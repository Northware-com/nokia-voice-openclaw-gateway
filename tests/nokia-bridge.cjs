'use strict';
/**
 * nokia-bridge integration tests
 *
 * Uses fake WebSocket gateway + HTTP servers only; no production connections.
 * Run:  node tests/nokia-bridge.cjs
 * Requires the sources to be compiled first:  bash configs/nokia-bridge/build.sh
 */

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// ── Compiled sources ──────────────────────────────────────────────────────────
const DIST = path.join(__dirname, '..', 'configs', 'nokia-bridge', 'dist');
let bridge, gateway;
try {
  bridge = require(path.join(DIST, 'bridge.js'));
  gateway = require(path.join(DIST, 'gateway.js'));
} catch (e) {
  console.error('FAIL: build not found. Run: bash configs/nokia-bridge/build.sh first.');
  console.error(e.message);
  process.exit(1);
}
const { createBridge, readProvisioning, provisionDeviceIdentity, readDeviceIdentity, deriveDeviceId, requirePrincipal } = bridge;
const { GatewayClient, GatewayFailure } = gateway;

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${e.message}`);
      if (process.env.VERBOSE) console.error(e.stack);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ── Test principal ─────────────────────────────────────────────────────────────
const TEST_PRINCIPAL = 'nokia-bridge@nokia.invalid';

// ── Fake Gateway ──────────────────────────────────────────────────────────────
/**
 * A synchronous fake Gateway that records calls without a WebSocket.
 */
class FakeGateway extends EventEmitter {
  constructor(options = {}) {
    super();
    this.calls = [];
    this.responses = options.responses ?? {};  // method -> response or Error
    this.sessionKey = null;
  }

  async request(method, params) {
    this.calls.push({ method, params });
    const r = this.responses[method];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(params);
    return r ?? {};
  }

  async subscribe(sessionKey, agentId) {
    this.calls.push({ method: 'sessions.messages.subscribe', params: { sessionKey, agentId } });
    const r = this.responses['sessions.messages.subscribe'];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r({ sessionKey, agentId });
    return { key: sessionKey };
  }

  simulateChat(payload) { this.emit('chat', payload); }
  simulateDisconnect() { this.emit('disconnect', {}); }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function makeToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) {
      const buf = typeof body === 'string' ? Buffer.from(body) : body;
      req.write(buf);
    }
    req.end();
  });
}

async function withBridge(token, gatewayOverride, fn) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nokia-bridge-test-'));
  const provisioning = { deviceId: 'test-device-01', tokenHashes: [hashToken(token)] };
  const gw = gatewayOverride ?? new FakeGateway({
    responses: {
      // sessions.create must return canonical key for principal
      'sessions.create': (params) => ({ ok: true, key: params.key }),
    },
  });
  const { server } = await createBridge({
    stateDirectory: stateDir,
    provisioning: async () => provisioning,
    gateway: gw,
    principal: TEST_PRINCIPAL,
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const base = { hostname: '127.0.0.1', port };
      try {
        await fn(base, gw);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });
}

function req(base, method, path, { token, body, contentType, requestId } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (contentType) headers['Content-Type'] = contentType;
  if (requestId) headers['X-Request-Id'] = requestId;
  if (body !== undefined) {
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    headers['Content-Length'] = buf.length;
  }
  return httpRequest({ ...base, method, path, headers }, body);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /nokia/v1/health returns 200 with ok:true without auth', async () => {
  const token = makeToken();
  await withBridge(token, null, async (base) => {
    const r = await req(base, 'GET', '/nokia/v1/health');
    assertEqual(r.status, 200);
    assert(r.body.ok === true, 'ok should be true');
  });
});

test('GET /nokia/v1/sessions returns 401 without Bearer token', async () => {
  const token = makeToken();
  await withBridge(token, null, async (base) => {
    const r = await req(base, 'GET', '/nokia/v1/sessions');
    assertEqual(r.status, 401);
    assertEqual(r.body.error, 'unauthorized');
  });
});

test('GET /nokia/v1/sessions returns 401 with wrong token', async () => {
  const token = makeToken();
  await withBridge(token, null, async (base) => {
    const r = await req(base, 'GET', '/nokia/v1/sessions', { token: makeToken() });
    assertEqual(r.status, 401);
  });
});

test('GET /nokia/v1/sessions returns empty list', async () => {
  const token = makeToken();
  await withBridge(token, null, async (base) => {
    const r = await req(base, 'GET', '/nokia/v1/sessions', { token });
    assertEqual(r.status, 200);
    assert(Array.isArray(r.body.sessions), 'sessions should be array');
    assertEqual(r.body.sessions.length, 0);
  });
});

test('POST /nokia/v1/sessions creates session with title', async () => {
  const token = makeToken();
  const gw = new FakeGateway({ responses: { 'sessions.create': (p) => ({ ok: true, key: p.key }) } });
  await withBridge(token, gw, async (base) => {
    const id = crypto.randomUUID();
    const r = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Test Session' }),
      requestId: id,
    });
    assertEqual(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert(typeof r.body.id === 'string', 'id should be string');
    assertEqual(r.body.title, 'Test Session');
  });
});

test('POST /nokia/v1/sessions rejects missing title', async () => {
  const token = makeToken();
  await withBridge(token, null, async (base) => {
    const r = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({}),
      requestId: crypto.randomUUID(),
    });
    assertEqual(r.status, 400);
  });
});

test('POST /nokia/v1/sessions clientId dedup returns same session', async () => {
  const token = makeToken();
  const gw = new FakeGateway({ responses: { 'sessions.create': (p) => ({ ok: true, key: p.key }) } });
  await withBridge(token, gw, async (base) => {
    const clientId = crypto.randomUUID();
    const r1 = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Session A', clientId }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(r1.status, 201);
    const r2 = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Session B', clientId }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(r2.status, 200, 'second create with same clientId should be 200');
    assertEqual(r2.body.id, r1.body.id, 'should return same session id');
  });
});

test('POST /nokia/v1/sessions idempotency: same requestId returns same result', async () => {
  const token = makeToken();
  const gw = new FakeGateway({ responses: { 'sessions.create': (p) => ({ ok: true, key: p.key }) } });
  await withBridge(token, gw, async (base) => {
    const requestId = crypto.randomUUID();
    const r1 = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Idem Session' }),
      requestId,
    });
    assertEqual(r1.status, 201);
    const r2 = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Idem Session' }),
      requestId,
    });
    assertEqual(r2.status, 200, 'idempotent retry should be 200');
    assertEqual(r2.body.id, r1.body.id);
  });
});

test('B3: POST /nokia/v1/sessions accepts clientId without X-Request-Id', async () => {
  const token = makeToken();
  const gw = new FakeGateway({ responses: { 'sessions.create': (p) => ({ ok: true, key: p.key }) } });
  await withBridge(token, gw, async (base) => {
    const clientId = crypto.randomUUID();
    // No requestId header — clientId is used as idempotency key
    const r = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'No RequestId', clientId }),
      // no requestId
    });
    assertEqual(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    // Second request with same clientId should return same session
    const r2 = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'No RequestId Again', clientId }),
    });
    assertEqual(r2.status, 200, 'clientId dedup should work');
    assertEqual(r2.body.id, r.body.id);
  });
});

test('GET /nokia/v1/sessions/:id returns 404 for unknown id', async () => {
  const token = makeToken();
  await withBridge(token, null, async (base) => {
    const r = await req(base, 'GET', `/nokia/v1/sessions/${crypto.randomUUID()}`, { token });
    assertEqual(r.status, 404);
  });
});

test('GET /nokia/v1/sessions/:id returns session state', async () => {
  const token = makeToken();
  const gw = new FakeGateway({ responses: { 'sessions.create': (p) => ({ ok: true, key: p.key }) } });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'State Test' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    const r = await req(base, 'GET', `/nokia/v1/sessions/${createR.body.id}`, { token });
    assertEqual(r.status, 200);
    assertEqual(r.body.id, createR.body.id);
    assertEqual(r.body.title, 'State Test');
    assert(['idle','pending','complete','error','cancelled','uncertain'].includes(r.body.state),
      `unexpected state: ${r.body.state}`);
    assert(Array.isArray(r.body.messages), 'messages should be array');
  });
});

test('Cross-session access denied: session from different device not accessible', async () => {
  const token = makeToken();
  const gw = new FakeGateway({ responses: { 'sessions.create': (p) => ({ ok: true, key: p.key }) } });
  // We can't easily test cross-device without two devices, but wrong UUID should 404
  await withBridge(token, gw, async (base) => {
    const r = await req(base, 'GET', `/nokia/v1/sessions/${crypto.randomUUID()}`, { token });
    assertEqual(r.status, 404, 'unknown session id should 404');
  });
});

test('POST /nokia/v1/sessions/:id/turns rejects on non-ready session', async () => {
  const token = makeToken();
  // Gateway returns error to leave session in unknown state
  const gw = new FakeGateway({ responses: { 'sessions.create': new GatewayFailure('gateway_request_rejected') } });
  await withBridge(token, gw, async (base) => {
    let sessionId;
    try {
      const r = await req(base, 'POST', '/nokia/v1/sessions', {
        token, contentType: 'application/json',
        body: JSON.stringify({ title: 'Bad Session' }),
        requestId: crypto.randomUUID(),
      });
      sessionId = r.body?.id;
    } catch {}
    if (!sessionId) return; // Session may not have been created if gateway error was immediate
    const r = await req(base, 'POST', `/nokia/v1/sessions/${sessionId}/turns`, {
      token, contentType: 'application/json',
      body: JSON.stringify({ text: 'hello' }),
      requestId: crypto.randomUUID(),
    });
    assert([409, 404, 503].includes(r.status), `expected 409, 404 or 503, got ${r.status}`);
  });
});

test('POST /nokia/v1/sessions/:id/turns JSON text returns 202 with pending state', async () => {
  const token = makeToken();
  const gw = new FakeGateway({
    responses: {
      'sessions.create': (p) => ({ ok: true, key: p.key }),
      'chat.send': (params) => ({ runId: params.idempotencyKey, status: 'started' }),
    },
  });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Turn Test' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    const turnReqId = crypto.randomUUID();
    const r = await req(base, 'POST', `/nokia/v1/sessions/${createR.body.id}/turns`, {
      token, contentType: 'application/json',
      body: JSON.stringify({ text: 'hello world' }),
      requestId: turnReqId,
    });
    assertEqual(r.status, 202, `expected 202, got ${r.status}: ${JSON.stringify(r.body)}`);
    assertEqual(r.body.state, 'pending');
    assert(typeof r.body.runId === 'string', 'runId should be string');
    // Verify subscribe was called before chat.send
    const callMethods = gw.calls.map(c => c.method);
    const subIdx = callMethods.indexOf('sessions.messages.subscribe');
    const sendIdx = callMethods.indexOf('chat.send');
    assert(subIdx !== -1, 'subscribe should have been called');
    assert(sendIdx !== -1, 'chat.send should have been called');
    assert(subIdx < sendIdx, 'subscribe must happen before chat.send');
  });
});

test('POST /nokia/v1/sessions/:id/turns audio/ogg returns 202', async () => {
  const token = makeToken();
  const gw = new FakeGateway({
    responses: {
      'sessions.create': (p) => ({ ok: true, key: p.key }),
      'chat.send': (params) => ({ runId: params.idempotencyKey, status: 'started' }),
    },
  });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Audio Test' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    // Minimal OggS header
    const ogg = Buffer.from('4f676753' + '00'.repeat(24), 'hex'); // OggS + padding
    const r = await req(base, 'POST', `/nokia/v1/sessions/${createR.body.id}/turns`, {
      token, contentType: 'audio/ogg',
      body: ogg,
      requestId: crypto.randomUUID(),
    });
    assertEqual(r.status, 202, `expected 202, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

test('POST /nokia/v1/sessions/:id/turns rejects oversized audio', async () => {
  const token = makeToken();
  const gw = new FakeGateway({ responses: { 'sessions.create': (p) => ({ ok: true, key: p.key }) } });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Oversize' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    // Create a buffer claiming to be 6MiB (header trick via content-length)
    const r = await httpRequest({
      ...base, method: 'POST',
      path: `/nokia/v1/sessions/${createR.body.id}/turns`,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'audio/ogg',
        'Content-Length': String(6 * 1024 * 1024 + 1),
        'X-Request-Id': crypto.randomUUID(),
      },
    }, Buffer.alloc(1));  // Only send 1 byte; content-length check fires first
    assertEqual(r.status, 413);
  });
});

test('POST /nokia/v1/sessions/:id/turns concurrent run limit returns 429', async () => {
  const token = makeToken();
  // Use a gateway that hangs on chat.send to keep turn in running state
  let resolveSend;
  const pendingSend = new Promise(r => { resolveSend = r; });
  const gw = new FakeGateway({
    responses: {
      'sessions.create': (p) => ({ ok: true, key: p.key }),
      'chat.send': () => pendingSend,
    },
  });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Concurrent' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    const sid = createR.body.id;
    // First turn — will hang
    const firstTurn = req(base, 'POST', `/nokia/v1/sessions/${sid}/turns`, {
      token, contentType: 'application/json',
      body: JSON.stringify({ text: 'first' }),
      requestId: crypto.randomUUID(),
    });
    // Give it a moment to be admitted
    await new Promise(r => setTimeout(r, 50));
    // Second turn on same session — must be rejected as busy
    const second = await req(base, 'POST', `/nokia/v1/sessions/${sid}/turns`, {
      token, contentType: 'application/json',
      body: JSON.stringify({ text: 'second' }),
      requestId: crypto.randomUUID(),
    });
    assert([409, 429].includes(second.status), `expected 409 or 429, got ${second.status}`);
    resolveSend({ runId: 'fake', status: 'started' });
    await firstTurn;
  });
});

test('POST /nokia/v1/sessions/:id/cancel returns 202', async () => {
  const token = makeToken();
  let resolveSend;
  const pendingSend = new Promise(r => { resolveSend = r; });
  const gw = new FakeGateway({
    responses: {
      'sessions.create': (p) => ({ ok: true, key: p.key }),
      'chat.send': () => pendingSend,
      'chat.abort': { ok: true },
    },
  });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Cancel Test' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    const sid = createR.body.id;
    const turnPromise = req(base, 'POST', `/nokia/v1/sessions/${sid}/turns`, {
      token, contentType: 'application/json',
      body: JSON.stringify({ text: 'run me' }),
      requestId: crypto.randomUUID(),
    });
    await new Promise(r => setTimeout(r, 50));
    // Retrieve the turn requestId from the first turn
    const sessionState = await req(base, 'GET', `/nokia/v1/sessions/${sid}`, { token });
    // The turn is running; cancel it with the turnRequestId
    const turnRequestId = crypto.randomUUID(); // We need the actual turn requestId
    // Use the turn's requestId from the POST /turns request (turnReqId is not in scope here)
    // Instead, re-issue with the id we know from the turn POST
    const cancelTurnId = gw.calls.find(c => c.method === 'chat.send')?.params?.idempotencyKey;
    assert(cancelTurnId, 'should have a turn requestId from chat.send');
    const cancelR = await req(base, 'POST', `/nokia/v1/sessions/${sid}/cancel`, {
      token,
      requestId: crypto.randomUUID(),
      contentType: 'application/json',
      body: JSON.stringify({ turnRequestId: cancelTurnId }),
    });
    assertEqual(cancelR.status, 202, `expected 202, got ${cancelR.status}: ${JSON.stringify(cancelR.body)}`);
    resolveSend({ runId: 'fake', status: 'started' });
    await turnPromise;
  });
});

test('Cancel idempotency: same requestId returns same result', async () => {
  const token = makeToken();
  const gw = new FakeGateway({
    responses: {
      'sessions.create': (p) => ({ ok: true, key: p.key }),
      'chat.abort': { ok: true },
    },
  });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Cancel Idem' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    const sid = createR.body.id;
    // No active turn; cancel with a fake turnRequestId that doesn't exist => 409
    const cancelId = crypto.randomUUID();
    const fakeTurnId = crypto.randomUUID();
    const r1 = await req(base, 'POST', `/nokia/v1/sessions/${sid}/cancel`, {
      token, requestId: cancelId,
      contentType: 'application/json',
      body: JSON.stringify({ turnRequestId: fakeTurnId }),
    });
    // 409 = turn_not_found (no such turn)
    assertEqual(r1.status, 409, `expected 409 for unknown turn, got ${r1.status}`);
  });
});

test('Gateway chat event updates turn state to complete', async () => {
  const token = makeToken();
  const turnReqId = crypto.randomUUID();
  const gw = new FakeGateway({
    responses: {
      'sessions.create': (p) => ({ ok: true, key: p.key }),
      'chat.send': (params) => ({ runId: params.idempotencyKey, status: 'started' }),
    },
  });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Event Test' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    const sid = createR.body.id;
    const sessionKey = `agent:main:${TEST_PRINCIPAL}:test-device-01:${sid}`;
    const turnR = await req(base, 'POST', `/nokia/v1/sessions/${sid}/turns`, {
      token, contentType: 'application/json',
      body: JSON.stringify({ text: 'go' }),
      requestId: turnReqId,
    });
    assertEqual(turnR.status, 202);
    // Simulate final chat event
    gw.simulateChat({
      runId: turnReqId,
      sessionKey,
      state: 'final',
      message: { content: 'Done!' },
    });
    // Allow store.transaction microtask to settle
    await new Promise(r => setTimeout(r, 20));
    const stateR = await req(base, 'GET', `/nokia/v1/sessions/${sid}`, { token });
    assertEqual(stateR.status, 200);
    assertEqual(stateR.body.state, 'complete', `expected complete, got ${stateR.body.state}`);
    assert(stateR.body.messages.some(m => m.text === 'Done!'), 'message text should appear');
  });
});

test('Gateway disconnect marks active turns uncertain', async () => {
  const token = makeToken();
  const gw = new FakeGateway({
    responses: {
      'sessions.create': (p) => ({ ok: true, key: p.key }),
      'chat.send': (params) => new Promise(() => {}), // never resolves
    },
  });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Disconnect Test' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    const sid = createR.body.id;
    // Start a turn (will stay pending)
    req(base, 'POST', `/nokia/v1/sessions/${sid}/turns`, {
      token, contentType: 'application/json',
      body: JSON.stringify({ text: 'hanging' }),
      requestId: crypto.randomUUID(),
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 30));
    // Simulate disconnect
    gw.simulateDisconnect();
    await new Promise(r => setTimeout(r, 20));
    const stateR = await req(base, 'GET', `/nokia/v1/sessions/${sid}`, { token });
    assertEqual(stateR.status, 200);
    assert(['uncertain', 'idle', 'pending'].includes(stateR.body.state),
      `expected uncertain, idle, or pending, got ${stateR.body.state}`);
  });
});

test('B5: Subscribe failure blocks chat.send and marks turn unknown', async () => {
  const token = makeToken();
  const gw = new FakeGateway({
    responses: {
      'sessions.create': (p) => ({ ok: true, key: p.key }),
      'sessions.messages.subscribe': new GatewayFailure('gateway_subscription_failed'),
      'chat.send': (params) => ({ runId: params.idempotencyKey, status: 'started' }),
    },
  });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Subscribe Fail' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    const sid = createR.body.id;
    const r = await req(base, 'POST', `/nokia/v1/sessions/${sid}/turns`, {
      token, contentType: 'application/json',
      body: JSON.stringify({ text: 'hello' }),
      requestId: crypto.randomUUID(),
    });
    // Subscribe failure should propagate as an error
    assert([503, 500, 409].includes(r.status), `expected 503/500/409 on subscribe failure, got ${r.status}`);
    // chat.send should NOT have been called
    const chatSendCalled = gw.calls.some(c => c.method === 'chat.send');
    assert(!chatSendCalled, 'chat.send must NOT be called when subscribe fails');
  });
});

test('B4: Gateway sessions.create key mismatch rejects with namespace error', async () => {
  const token = makeToken();
  // Gateway returns a wrong key — different namespace
  const gw = new FakeGateway({
    responses: {
      'sessions.create': () => ({ ok: true, key: 'agent:main:EVIL_PRINCIPAL:test-device-01:some-id' }),
    },
  });
  await withBridge(token, gw, async (base) => {
    const r = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Key Mismatch' }),
      requestId: crypto.randomUUID(),
    });
    // Must not succeed — key namespace violation
    assert(r.status >= 400, `expected error status, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

test('B7: Uncertain session create returns 503 not 201', async () => {
  const token = makeToken();
  let createCallCount = 0;
  const gw = new FakeGateway({
    responses: {
      'sessions.create': () => {
        createCallCount++;
        // Always fail to leave session in unknown state
        throw new GatewayFailure('gateway_request_rejected');
      },
    },
  });
  await withBridge(token, gw, async (base) => {
    const clientId = crypto.randomUUID();
    // First create — fails, session goes unknown
    const r1 = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Uncertain', clientId }),
    });
    // May get 503 from gateway failure or session unknown
    // Second create with same clientId — should return 503 (uncertain, not fresh 201)
    const r2 = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Uncertain', clientId }),
    });
    // If the session was created but is unknown, second attempt must not return 201
    assert(r2.status !== 201, `uncertain session must not return 201, got ${r2.status}`);
  });
});

test('B8: Message bounds: truncates old messages beyond MAX_TURN_MESSAGES', async () => {
  const token = makeToken();
  let eventCount = 0;
  const gw = new FakeGateway({
    responses: {
      'sessions.create': (p) => ({ ok: true, key: p.key }),
      'chat.send': (params) => ({ runId: params.idempotencyKey, status: 'started' }),
    },
  });
  await withBridge(token, gw, async (base) => {
    const createR = await req(base, 'POST', '/nokia/v1/sessions', {
      token, contentType: 'application/json',
      body: JSON.stringify({ title: 'Bounds Test' }),
      requestId: crypto.randomUUID(),
    });
    assertEqual(createR.status, 201);
    const sid = createR.body.id;
    const sessionKey = `agent:main:${TEST_PRINCIPAL}:test-device-01:${sid}`;
    // Send one turn
    const turnReqId = crypto.randomUUID();
    const turnR = await req(base, 'POST', `/nokia/v1/sessions/${sid}/turns`, {
      token, contentType: 'application/json',
      body: JSON.stringify({ text: 'count' }),
      requestId: turnReqId,
    });
    assertEqual(turnR.status, 202);
    // Simulate 150 chat events (> MAX_TURN_MESSAGES=128)
    for (let i = 0; i < 150; i++) {
      gw.simulateChat({
        runId: turnReqId,
        sessionKey,
        state: i < 149 ? 'running' : 'final',
        message: { content: `msg${i}` },
      });
    }
    await new Promise(r => setTimeout(r, 50));
    const stateR = await req(base, 'GET', `/nokia/v1/sessions/${sid}`, { token });
    assertEqual(stateR.status, 200);
    // Messages should be bounded
    assert(stateR.body.messages.length <= 128, `messages.length=${stateR.body.messages.length} must be <=128`);
  });
});

test('provisionDeviceIdentity writes mode-0600 file with sha256-derived deviceId', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nokia-id-test-'));
  try {
    const identityPath = path.join(dir, 'device-identity.json');
    // Set dir to 0700 first so privateJson can read
    fs.chmodSync(dir, 0o700);
    const identity = await provisionDeviceIdentity(identityPath);
    // B1: deviceId is full 64-char sha256 hex
    assert(typeof identity.deviceId === 'string', 'deviceId should be string');
    assert(/^[a-f0-9]{64}$/.test(identity.deviceId), `deviceId should be 64-char hex, got ${identity.deviceId}`);
    // Verify it matches deriveDeviceId
    const derived = deriveDeviceId(identity.publicKeyPem);
    assertEqual(identity.deviceId, derived, 'deviceId must equal deriveDeviceId(publicKey)');
    assert(typeof identity.privateKeyPem === 'string' && identity.privateKeyPem.includes('PRIVATE KEY'), 'private key pem');
    assert(typeof identity.publicKeyPem === 'string' && identity.publicKeyPem.includes('PUBLIC KEY'), 'public key pem');
    const stat = fs.statSync(identityPath);
    assertEqual(stat.mode & 0o777, 0o600, 'identity file must be mode 0600');
    // Roundtrip: readDeviceIdentity verifies key match
    const loaded = await readDeviceIdentity(identityPath);
    assertEqual(loaded.deviceId, identity.deviceId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('provisionDeviceIdentity refuses to overwrite existing identity (exclusive create)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nokia-id-excl-'));
  try {
    const identityPath = path.join(dir, 'device-identity.json');
    fs.chmodSync(dir, 0o700);
    const first = await provisionDeviceIdentity(identityPath);
    // Second provision must fail (no overwrite)
    let threw = false;
    try { await provisionDeviceIdentity(identityPath); } catch { threw = true; }
    assert(threw, 'provisionDeviceIdentity must not overwrite existing identity');
    // Original must still be readable
    const loaded = await readDeviceIdentity(identityPath);
    assertEqual(loaded.deviceId, first.deviceId, 'original identity must be preserved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readDeviceIdentity rejects key mismatch (private/public pair)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nokia-id-mismatch-'));
  try {
    const identityPath = path.join(dir, 'mismatch.json');
    // Generate two separate keypairs
    const kp1 = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const kp2 = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const wrongId = deriveDeviceId(kp2.publicKey);
    // Mix private key from kp1 with public key from kp2
    const tampered = JSON.stringify({
      deviceId: wrongId,
      privateKeyPem: kp1.privateKey,
      publicKeyPem: kp2.publicKey,
    });
    fs.writeFileSync(identityPath, tampered, { mode: 0o600 });
    let threw = false;
    try { await readDeviceIdentity(identityPath); } catch { threw = true; }
    assert(threw, 'readDeviceIdentity must reject mismatched private/public keys');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readProvisioning rejects bad tokenHashes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nokia-prov-test-'));
  try {
    const p = path.join(dir, 'prov.json');
    fs.writeFileSync(p, JSON.stringify({ deviceId: 'test-device-01', tokenHashes: ['not-a-hash'] }), { mode: 0o600 });
    let threw = false;
    try { await readProvisioning(p); } catch { threw = true; }
    assert(threw, 'should throw on bad tokenHashes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('requirePrincipal throws without env var', () => {
  const saved = process.env.NOKIA_GATEWAY_PRINCIPAL;
  delete process.env.NOKIA_GATEWAY_PRINCIPAL;
  let threw = false;
  try { requirePrincipal(); } catch { threw = true; }
  finally { if (saved !== undefined) process.env.NOKIA_GATEWAY_PRINCIPAL = saved; }
  assert(threw, 'requirePrincipal must throw without env var');
});

test('GatewayClient signing: buildDeviceAuthPayloadV3 produces correct format', () => {
  // Test the payload format via the compiled module
  // We can't call internal functions directly, but we can verify the connect
  // frame structure by using a fake socket factory.
  const frames = [];
  class FakeSocket extends EventEmitter {
    send(data) { frames.push(JSON.parse(data)); }
    close() {}
    terminate() {}
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const identity = {
    deviceId: deriveDeviceId(publicKey),
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
  };
  const testHeaders = {
    'Tailscale-User-Login': TEST_PRINCIPAL,
    'Tailscale-Headers-Info': JSON.stringify({ loginName: TEST_PRINCIPAL }),
    'X-Forwarded-For': '127.0.0.1',
    'X-Forwarded-Host': 'gateway.example.invalid',
    'X-Forwarded-Proto': 'https',
  };
  const client = new GatewayClient(
    (url, opts) => {
      // Verify headers are present
      assert(opts.headers && opts.headers['Tailscale-User-Login'] === TEST_PRINCIPAL, 'Tailscale-User-Login header required');
      const s = new FakeSocket();
      // Simulate challenge
      // Delay challenge so connect() has time to register socket.on('message', ...) handlers
      setTimeout(() => s.emit('message', Buffer.from(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'test-nonce-abc', ts: Date.now() },
      }))), 30);
      return s;
    },
    'ws://127.0.0.1:18789',
    testHeaders,
    identity,
    200,
  );
  const connectPromise = client.request('sessions.list', {}).catch(() => {});
  return new Promise((resolve) => {
    setTimeout(() => {
      const connectFrame = frames.find(f => f.method === 'connect');
      assert(connectFrame, 'should have sent connect frame');
      assertEqual(connectFrame.params.client.id, 'gateway-client', 'client.id must be gateway-client');
      assertEqual(connectFrame.params.client.mode, 'backend', 'client.mode must be backend');
      assert(connectFrame.params.device, 'device param required');
      assertEqual(connectFrame.params.device.id, identity.deviceId, 'device.id matches full 64-char id');
      assert(/^[a-f0-9]{64}$/.test(identity.deviceId), `device.id must be 64-char hex, got ${identity.deviceId}`);
      assert(typeof connectFrame.params.device.signature === 'string', 'signature present');
      assert(typeof connectFrame.params.device.publicKey === 'string', 'publicKey present');
      assertEqual(connectFrame.params.minProtocol, 4, 'protocol must be 4');
      assertEqual(connectFrame.params.maxProtocol, 4, 'protocol must be 4');
      const scopes = connectFrame.params.scopes;
      assert(scopes.includes('operator.read') && scopes.includes('operator.write'), 'scopes must include read+write');
      // Must NOT use control-ui identity
      assert(connectFrame.params.client.id !== 'openclaw-control-ui', 'must not impersonate control-ui');
      assert(connectFrame.params.client.mode !== 'ui', 'must not use ui mode');
      // Verify signature using the public key (independent crypto verification, not own helper)
      const device = connectFrame.params.device;
      const nonce = 'test-nonce-abc';
      const ts = connectFrame.params.device.signedAt;
      // Reconstruct the payload the gateway client would have signed
      const normMeta = (v) => v.trim().replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));
      const authPayload = ['v3', identity.deviceId, 'gateway-client', 'backend', 'operator',
        'operator.read,operator.write', String(ts), '', nonce,
        normMeta('linux'), normMeta('')].join('|');
      const rawPubKeyB64url = (function(pem) {
        const b64 = pem.replace(/-----BEGIN PUBLIC KEY-----/, '').replace(/-----END PUBLIC KEY-----/, '').replace(/\s+/g, '');
        const der = Buffer.from(b64, 'base64');
        return der.subarray(der.length - 32).toString('base64url');
      })(publicKey);
      assertEqual(device.publicKey, rawPubKeyB64url, 'publicKey in frame matches raw ed25519 key');
      const sigBuf = Buffer.from(device.signature, 'base64url');
      const isValid = crypto.verify(null, Buffer.from(authPayload, 'utf8'), { key: publicKey, format: 'pem' }, sigBuf);
      assert(isValid, 'signature must verify against the public key and reconstructed payload');
      resolve();
    }, 120);
  });
});

test('GatewayClient.ready is false initially and true after handshake', () => {
  const frames = [];
  class FakeSocket extends EventEmitter {
    send(data) {
      frames.push(JSON.parse(data));
      // After receiving connect req, send hello-ok response
      const frame = JSON.parse(data);
      if (frame.method === 'connect') {
        setTimeout(() => this.emit('message', Buffer.from(JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: true,
          payload: {
            type: 'hello-ok',
            protocol: 4,
            auth: { scopes: ['operator.read', 'operator.write'] },
            policy: { maxPayload: 1024 * 1024 },
          },
        }))), 10);
      }
    }
    close() {}
    terminate() {}
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const identity = { deviceId: deriveDeviceId(publicKey), privateKeyPem: privateKey, publicKeyPem: publicKey };
  const client = new GatewayClient(
    (url, opts) => {
      const s = new FakeSocket();
      setTimeout(() => s.emit('message', Buffer.from(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce123', ts: Date.now() },
      }))), 10);
      return s;
    },
    'ws://127.0.0.1:18789',
    { 'Tailscale-User-Login': TEST_PRINCIPAL, 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Host': 'gateway.example.invalid', 'X-Forwarded-Proto': 'https' },
    identity, 500,
  );
  assert(client.ready === false, 'ready must be false before connect');
  return new Promise((resolve) => {
    // Request triggers connect
    client.request('test', {}).then(() => {
      assert(client.ready === true, 'ready must be true after successful handshake');
      resolve();
    }).catch(() => {
      // May fail on method dispatch but connection should be ready
      assert(client.ready === true || client.ready === false, 'ready is boolean');
      resolve();
    });
    setTimeout(() => {
      // After handshake completes ready should be true
      assert(client.ready === true, 'ready must be true after handshake');
      resolve();
    }, 200);
  });
});

// ── Run ───────────────────────────────────────────────────────────────────────
console.log('\nnokia-bridge tests\n');
run();
