import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, timingSafeEqual, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, lstat, writeFile } from 'node:fs/promises';
import { createServer, IncomingMessage } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DeviceIdentity, Gateway, GatewayFailure, RecordValue } from './gateway';

// ── Constants ────────────────────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE = /^[a-f0-9]{64}$|^[a-z0-9][a-z0-9-]{0,62}$/;
const PREFIX = '/nokia/v1';
const AUDIO_LIMIT = 5 * 1024 * 1024;
const TEXT_LIMIT = 16_000;
const OUTPUT_LIMIT = 64_000;
const MAX_OPERATIONS = 8192;
const MAX_SESSIONS = 128;
const MAX_CONCURRENT_ACTIVE = 4;
const MAX_TURN_MESSAGES = 128;
const REGISTRY_SIZE_LIMIT = 16 * 1024 * 1024;

// NOKIA_GATEWAY_PRINCIPAL must be set; no fallback — prevents accidental shared-namespace pollution.
export function requirePrincipal(): string {
  const p = process.env.NOKIA_GATEWAY_PRINCIPAL;
  if (!p || !p.includes('@')) throw new Error('NOKIA_GATEWAY_PRINCIPAL env var required (format: unique@nokia.invalid)');
  return p;
}

// ── Config / Provisioning ────────────────────────────────────────────────────
export interface Provisioning {
  deviceId: string;
  tokenHashes: string[];
}

// ── Types ────────────────────────────────────────────────────────────────────
type TurnState = 'running' | 'unknown' | 'final' | 'error' | 'aborted';

/** HTTP-facing turn state: maps internal states to the public contract. */
type PublicTurnState = 'pending' | 'complete' | 'error' | 'cancelled' | 'uncertain';

function publicTurnState(s: TurnState): PublicTurnState {
  switch (s) {
    case 'running':  return 'pending';
    case 'final':    return 'complete';
    case 'error':    return 'error';
    case 'aborted':  return 'cancelled';
    case 'unknown':  return 'uncertain';
  }
}

/** HTTP-facing session state. */
type PublicSessionState = 'idle' | 'pending' | 'complete' | 'error' | 'cancelled' | 'uncertain';

function publicSessionState(s: Session): PublicSessionState {
  if (s.state === 'creating') return 'uncertain';
  if (s.state === 'unknown') return 'uncertain';
  const active = s.turns.find(t => t.state === 'running' || t.state === 'unknown');
  if (active) return active.state === 'running' ? 'pending' : 'uncertain';
  const last = s.turns[s.turns.length - 1];
  if (!last) return 'idle';
  return publicTurnState(last.state);
}

interface Turn {
  requestId: string;
  fingerprint: string;
  runId: string;
  state: TurnState;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
}

interface Session {
  id: string;
  deviceId: string;
  key: string;
  title: string;
  /** clientId dedup: optional caller-provided UUID that prevents duplicate creation. */
  clientId?: string;
  state: 'creating' | 'ready' | 'unknown';
  turns: Turn[];
}

interface Operation {
  deviceId: string;
  kind: string;
  fingerprint: string;
  sessionId: string;
  state: string;
}

interface Registry {
  version: 1;
  sessions: Session[];
  operations: Record<string, Operation>;
}

class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const hashStr = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const isActive = (t: Turn) => t.state === 'running' || t.state === 'unknown';

function assertObject(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_json_object');
  return value as RecordValue;
}

function exactKeys(value: RecordValue, keys: string[]): void {
  if (Object.keys(value).some(k => !keys.includes(k))) throw new HttpError(400, 'unsupported_field');
}

function textOf(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const v = value as Record<string, unknown>;
  if (typeof v.content === 'string') return v.content.slice(0, OUTPUT_LIMIT);
  if (Array.isArray(v.content)) {
    return (v.content as unknown[])
      .filter((c): c is { type: string; text: string } => typeof (c as any)?.text === 'string' && (c as any).type === 'text')
      .map(c => c.text)
      .join('\n')
      .slice(0, OUTPUT_LIMIT);
  }
  return '';
}

// ── Private file I/O ─────────────────────────────────────────────────────────
export async function privateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 ||
      (stat.uid !== 0 && process.getuid && stat.uid !== process.getuid())) {
      throw new Error('private_file_required');
    }
    if (stat.size > REGISTRY_SIZE_LIMIT) throw new Error('private_file_too_large');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export async function readProvisioning(path: string): Promise<Provisioning> {
  const value = assertObject(await privateJson(path));
  exactKeys(value, ['deviceId', 'tokenHashes']);
  if (!DEVICE.test(value.deviceId as string) || !Array.isArray(value.tokenHashes) ||
    (value.tokenHashes as unknown[]).length > 8 ||
    !(value.tokenHashes as unknown[]).every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v as string))) {
    throw new Error('invalid_provisioning');
  }
  return value as unknown as Provisioning;
}

/**
 * Derive deviceId as the full 64-char hex sha256 of the raw 32-byte ed25519 pubkey.
 * Ed25519 SPKI DER has a 12-byte header; the raw public key is the last 32 bytes.
 */
export function deriveDeviceId(publicKeyPem: string): string {
  const b64 = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(b64, 'base64');
  if (der.length < 32) throw new Error('invalid_ed25519_public_key');
  const rawKey = der.subarray(der.length - 32);
  return createHash('sha256').update(rawKey).digest('hex');
}

/** Generate a new ed25519 identity and persist it as a mode-0600 JSON file.
 *  Exclusive create (wx open on destination, no TOCTOU). Fsyncs file before close. */
export async function provisionDeviceIdentity(path: string): Promise<DeviceIdentity> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const deviceId = deriveDeviceId(publicKey);
  const identity: DeviceIdentity = { deviceId, privateKeyPem: privateKey, publicKeyPem: publicKey };
  // Exclusive create directly on destination — O_EXCL guarantees no TOCTOU
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(identity));
    await file.sync();
  } finally {
    await file.close();
  }
  return identity;
}

export async function readDeviceIdentity(path: string): Promise<DeviceIdentity> {
  const value = assertObject(await privateJson(path));
  exactKeys(value, ['deviceId', 'publicKeyPem', 'privateKeyPem']);
  if (typeof value.deviceId !== 'string' || !DEVICE.test(value.deviceId as string) ||
    typeof value.privateKeyPem !== 'string' || typeof value.publicKeyPem !== 'string') {
    throw new Error('invalid_device_identity');
  }
  // Verify both keys are parseable
  let privKey: ReturnType<typeof createPrivateKey>;
  let pubKey: ReturnType<typeof createPublicKey>;
  try {
    privKey = createPrivateKey(value.privateKeyPem as string);
    pubKey = createPublicKey(value.publicKeyPem as string);
  } catch {
    throw new Error('invalid_device_identity_key');
  }
  // Verify private/public key match via sign/verify round-trip
  const probe = Buffer.from('nokia-bridge-key-verify');
  let sig: Buffer;
  try { sig = sign(null, probe, privKey); } catch { throw new Error('invalid_device_identity_key'); }
  if (!verify(null, probe, pubKey, sig)) throw new Error('invalid_device_identity_key_mismatch');
  // Verify stored deviceId matches derived value
  const expectedId = deriveDeviceId(value.publicKeyPem as string);
  if ((value.deviceId as string) !== expectedId) throw new Error('invalid_device_identity_id_mismatch');
  return value as unknown as DeviceIdentity;
}

// ── Durable atomic store ─────────────────────────────────────────────────────
class Store {
  private tail: Promise<unknown> = Promise.resolve();
  private failed = false;
  constructor(readonly path: string, readonly data: Registry) {}

  async transaction<T>(action: () => T): Promise<T> {
    const job = this.tail.then(async () => {
      if (this.failed) throw new HttpError(503, 'registry_unavailable');
      try {
        const result = action();
        await this.save();
        return result;
      } catch (error) {
        if (!(error instanceof HttpError)) this.failed = true;
        throw error;
      }
    });
    this.tail = job.catch(() => {});
    return job;
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.failed) throw new HttpError(503, 'registry_unavailable');
  }

  private async save(): Promise<void> {
    const serialized = JSON.stringify(this.data);
    if (Buffer.byteLength(serialized) > REGISTRY_SIZE_LIMIT) throw new Error('registry_too_large');
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(serialized); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, this.path);
    const dir = await open(dirname(this.path), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

function validateRegistry(value: unknown, principal: string): asserts value is Registry {
  const v = value as any;
  if (v?.version !== 1 || !Array.isArray(v.sessions) || v.sessions.length > MAX_SESSIONS ||
    !v.operations || Object.getPrototypeOf(v.operations) !== Object.prototype ||
    Object.keys(v.operations).length > MAX_OPERATIONS) throw new Error('invalid_registry');
  const ids = new Set<string>();
  for (const s of v.sessions) {
    // Key must match canonical pattern for this principal
    const expectedKey = `agent:main:${principal}:${s.deviceId}:${s.id}`;
    if (!UUID.test(s.id) || ids.has(s.id) || !DEVICE.test(s.deviceId) ||
      s.key !== expectedKey ||
      typeof s.title !== 'string' || s.title.length > 200 ||
      !['creating', 'ready', 'unknown'].includes(s.state) ||
      !Array.isArray(s.turns)) throw new Error('invalid_registry');
    if (s.clientId !== undefined && !UUID.test(s.clientId)) throw new Error('invalid_registry');
    ids.add(s.id);
    for (const t of s.turns) {
      if (!UUID.test(t.requestId) || t.runId !== t.requestId ||
        !/^[a-f0-9]{64}$/.test(t.fingerprint) ||
        !['running', 'unknown', 'final', 'error', 'aborted'].includes(t.state) ||
        !Array.isArray(t.messages)) throw new Error('invalid_registry');
      // Enforce message bounds
      if (t.messages.length > MAX_TURN_MESSAGES) throw new Error('invalid_registry');
    }
  }
  for (const [id, op] of Object.entries(v.operations) as [string, Operation][]) {
    if (!UUID.test(id) || !DEVICE.test(op.deviceId) || !ids.has(op.sessionId) ||
      typeof op.kind !== 'string' || !/^[a-f0-9]{64}$/.test(op.fingerprint) ||
      typeof op.state !== 'string') throw new Error('invalid_registry');
  }
}

/** Validate a key returned by the gateway is canonical for this principal/device/session. */
function validateReturnedKey(key: unknown, principal: string, deviceId: string, sessionId: string): string {
  const expected = `agent:main:${principal}:${deviceId}:${sessionId}`;
  if (typeof key !== 'string' || key !== expected) {
    throw new GatewayFailure('gateway_key_namespace_violation');
  }
  return key;
}

// ── HTTP body helpers ─────────────────────────────────────────────────────────
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw new HttpError(413, 'body_too_large'); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) { req.resume(); throw new HttpError(413, 'body_too_large'); }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(data: Buffer): RecordValue {
  try { return assertObject(JSON.parse(data.toString('utf8'))); }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'invalid_json'); }
}

// ── Message bounds enforcement ────────────────────────────────────────────────
/** Append an assistant message to a turn, enforcing the per-session message limit. */
function appendTurnMessage(turn: Turn, msg: { role: 'user' | 'assistant'; text: string }): void {
  turn.messages.push(msg);
  // Keep only the most recent MAX_TURN_MESSAGES messages (drop oldest)
  if (turn.messages.length > MAX_TURN_MESSAGES) {
    turn.messages.splice(0, turn.messages.length - MAX_TURN_MESSAGES);
  }
}

// ── Public session projection ─────────────────────────────────────────────────
function publicSession(s: Session): RecordValue {
  return {
    id: s.id,
    title: s.title,
    state: publicSessionState(s),
    runId: s.turns.find(isActive)?.runId,
    messages: s.turns.flatMap(t => t.messages),
    error: s.turns.find(t => t.state === 'error')?.messages.at(-1)?.text,
  };
}

function publicSessionSummary(s: Session): RecordValue {
  return { id: s.id, title: s.title };
}

// ── Main factory ──────────────────────────────────────────────────────────────
export async function createBridge(options: {
  stateDirectory: string;
  provisioning: () => Promise<Provisioning>;
  gateway: Gateway;
  /** Gateway principal; must be NOKIA_GATEWAY_PRINCIPAL. Required — no fallback. */
  principal: string;
}) {
  const { principal } = options;

  const directoryPath = resolve(options.stateDirectory);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const dir = await lstat(directoryPath);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700 ||
    (process.getuid && dir.uid !== process.getuid())) {
    throw new Error('private_state_directory_required');
  }

  const path = join(directoryPath, 'registry.json');
  let data: Registry;
  try {
    const raw = await privateJson(path);
    validateRegistry(raw, principal);
    data = raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    data = { version: 1, sessions: [], operations: {} };
  }

  const store = new Store(path, data);
  // Mark in-flight turns as uncertain on startup
  await store.transaction(() => {
    for (const s of data.sessions) {
      if (s.state === 'creating') s.state = 'unknown';
      for (const t of s.turns) if (isActive(t)) t.state = 'unknown';
    }
  });

  // Subscribe to gateway chat events
  options.gateway.on('chat', (event: RecordValue) => {
    const state = event.state as string;
    if (!['final', 'error', 'aborted'].includes(state)) return;
    void store.transaction(() => {
      const session = data.sessions.find(s => s.key === event.sessionKey);
      const turn = session?.turns.find(t => t.runId === event.runId && isActive(t));
      if (!turn) return;
      turn.state = state as TurnState;
      // Append the final message text
      const text = textOf(event.message);
      if (text) appendTurnMessage(turn, { role: 'assistant', text });
    }).catch(() => {});
  });

  options.gateway.on('disconnect', () => {
    void store.transaction(() => {
      for (const s of data.sessions) for (const t of s.turns) if (isActive(t)) t.state = 'unknown';
    }).catch(() => {});
  });

  // ── Idempotency helpers ──────────────────────────────────────────────────
  function reserve(
    requestId: string, deviceId: string, kind: string,
    fingerprint: string, sessionId: string,
  ): boolean {
    const prior = data.operations[requestId];
    if (prior) {
      if (prior.deviceId !== deviceId || prior.kind !== kind ||
        prior.fingerprint !== fingerprint || prior.sessionId !== sessionId) {
        throw new HttpError(409, 'request_id_conflict');
      }
      return false;
    }
    if (Object.keys(data.operations).length >= MAX_OPERATIONS) throw new HttpError(429, 'request_registry_full');
    data.operations[requestId] = { deviceId, kind, fingerprint, sessionId, state: 'reserved' };
    return true;
  }

  // ── History reconciliation ────────────────────────────────────────────────
  /** Reconcile uncertain turn/session state from gateway history.
   * Uses chat.history schema: { sessionKey, agentId, limit } -> { messages, session, inFlightRun, ... } */
  async function reconcileHistory(session: Session): Promise<void> {
    let historyResult: RecordValue | undefined;
    try {
      // Re-subscribe first to ensure events flow
      await options.gateway.subscribe(session.key, 'main');
      historyResult = await options.gateway.request('chat.history', {
        sessionKey: session.key,
        agentId: 'main',
        limit: 64,
      });
    } catch {
      // Gateway unavailable; leave as uncertain
      return;
    }
    const messages = Array.isArray(historyResult?.messages) ? (historyResult.messages as RecordValue[]) : [];
    await store.transaction(() => {
      const sessionMeta = historyResult?.session as RecordValue | undefined;
      const inFlight = sessionMeta?.inFlightRun as string | undefined;
      const activeRunIds = Array.isArray(sessionMeta?.activeRunIds) ? sessionMeta.activeRunIds as string[] : [];
      for (const turn of session.turns) {
        if (turn.state !== 'unknown') continue;
        // A turn still active on the gateway: leave uncertain
        const isStillActive = inFlight === turn.runId || activeRunIds.includes(turn.runId);
        if (isStillActive) continue;
        // Find messages linked to this turn's runId
        const linked = messages.filter((m: RecordValue) => (m as any).runId === turn.runId);
        if (!linked.length) continue;
        const lastMsg = linked[linked.length - 1] as RecordValue & { role?: string; state?: string };
        const msgState = lastMsg.state as string | undefined;
        const terminalState: TurnState = (['final', 'error', 'aborted'].includes(msgState ?? '')) ? (msgState as TurnState) : 'final';
        turn.state = terminalState;
        const existingTexts = new Set(turn.messages.filter(m => m.role === 'assistant').map(m => m.text));
        const text = textOf(lastMsg);
        if (text && !existingTexts.has(text)) {
          appendTurnMessage(turn, { role: 'assistant', text });
        }
      }
      // If all turns resolved and session was unknown, mark ready if last turn is terminal
      if (session.state === 'unknown') {
        const allSettled = session.turns.every(t => !isActive(t));
        if (allSettled) session.state = 'ready';
      }
    }).catch(() => {});
  }

  // ── Route handler ────────────────────────────────────────────────────────
  async function route(req: IncomingMessage): Promise<{ status: number; value: unknown }> {
    const url = req.url ?? '';

    // Public health endpoint — no auth required; only reflects actual connection state
    if (url === `${PREFIX}/health` && req.method === 'GET') {
      const gw = options.gateway as any;
      const connected = typeof gw.ready === 'boolean' ? gw.ready : false;
      return { status: 200, value: { ok: true, connected } };
    }

    // Auth: reload provisioning on every request for immediate revocation
    const config = await options.provisioning();
    const auth = req.headers.authorization;
    const token = typeof auth === 'string' && /^Bearer [A-Za-z0-9_\-]{32,256}$/.test(auth) ? auth.slice(7) : '';
    const digest = Buffer.from(hashStr(token), 'hex');
    if (!token || !config.tokenHashes.some(h => timingSafeEqual(digest, Buffer.from(h, 'hex')))) {
      throw new HttpError(401, 'unauthorized');
    }

    await store.flush();
    const deviceId = config.deviceId;

    // GET /nokia/v1/sessions — attempt gateway probe if not connected
    if (url === `${PREFIX}/sessions` && req.method === 'GET') {
      // Attempt to probe gateway connectivity (best-effort, non-fatal)
      const gw = options.gateway as any;
      if (typeof gw.ensureConnected === 'function') {
        try { await (gw.ensureConnected as () => Promise<void>)(); } catch { /* leave disconnected */ }
      }
      return {
        status: 200,
        value: { sessions: data.sessions.filter(s => s.deviceId === deviceId).map(publicSessionSummary) },
      };
    }

    // POST /nokia/v1/sessions
    if (url === `${PREFIX}/sessions` && req.method === 'POST') {
      const ct = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') throw new HttpError(415, 'json_required');
      const payload = parseJson(await readBody(req, 2048));
      exactKeys(payload, ['title', 'clientId']);
      if (typeof payload.title !== 'string' || !(payload.title as string).trim() ||
        (payload.title as string).length > 200) throw new HttpError(400, 'invalid_title');
      if (payload.clientId !== undefined && !UUID.test(payload.clientId as string)) {
        throw new HttpError(400, 'invalid_client_id');
      }
      const title = (payload.title as string).trim();
      const clientId = payload.clientId as string | undefined;

      // B3: X-Request-Id OR clientId is required for idempotency; prefer requestId
      const requestIdHeader = req.headers['x-request-id'];
      const hasRequestId = typeof requestIdHeader === 'string' && UUID.test(requestIdHeader);
      const requestId: string = hasRequestId
        ? (requestIdHeader as string)
        : (clientId ?? ''); // use clientId as idempotency key if no requestId
      if (!requestId) throw new HttpError(400, 'uuid_request_id_required');
      // When clientId is used as requestId, it must be a UUID (already validated above)

      const fingerprint = hashStr(JSON.stringify({ title, clientId }));

      let session!: Session;
      const fresh = await store.transaction(() => {
        // clientId dedup: if clientId present, find existing session with same clientId+deviceId
        if (clientId) {
          const existing = data.sessions.find(s => s.clientId === clientId && s.deviceId === deviceId);
          if (existing) {
            // If we have a requestId distinct from clientId, also record the operation for idempotency
            if (hasRequestId) reserve(requestIdHeader as string, deviceId, 'create', fingerprint, existing.id);
            session = existing;
            return false;
          }
        }
        const prevOp = data.operations[requestId];
        if (prevOp) {
          reserve(requestId, deviceId, 'create', fingerprint, prevOp.sessionId);
          session = data.sessions.find(s => s.id === prevOp.sessionId && s.deviceId === deviceId)!;
          return false;
        }
        if (data.sessions.length >= MAX_SESSIONS) throw new HttpError(429, 'session_limit');
        const id = randomUUID();
        // Construct key locally; will be validated against gateway response
        const key = `agent:main:${principal}:${deviceId}:${id}`;
        reserve(requestId, deviceId, 'create', fingerprint, id);
        session = { id, deviceId, key, title, state: 'creating', turns: [], ...(clientId ? { clientId } : {}) };
        data.sessions.push(session);
        return true;
      });

      // B7: If session is in uncertain/unknown state from a prior attempt, return 503 (not 201)
      if (!fresh && session.state === 'unknown') {
        throw new HttpError(503, 'session_create_uncertain');
      }
      if (!fresh && session.state === 'creating') {
        throw new HttpError(503, 'session_create_in_progress');
      }

      if (fresh) {
        try {
          const result = await options.gateway.request('sessions.create', {
            key: session.key,
            agentId: 'main',
            displayName: session.title,
            idempotencyKey: requestId,
          });
          // B4: Validate and save the returned key — must match canonical pattern
          const returnedKey = validateReturnedKey(result.key ?? session.key, principal, deviceId, session.id);
          await store.transaction(() => {
            session.state = 'ready';
            session.key = returnedKey;
            data.operations[requestId].state = 'ready';
          });
        } catch (error) {
          await store.transaction(() => {
            session.state = 'unknown';
            data.operations[requestId].state = 'unknown';
          });
          throw error;
        }
      }

      return { status: fresh ? 201 : 200, value: { id: session.id, title: session.title } };
    }

    // Session-scoped routes: /nokia/v1/sessions/:id[/turns|/cancel]
    const match = new RegExp(`^${PREFIX}/sessions/([a-fA-F0-9-]{36})(?:/(turns|cancel))?$`).exec(url);
    const session = match ? data.sessions.find(s => s.id === match[1] && s.deviceId === deviceId) : undefined;
    if (!match || !session) throw new HttpError(404, 'not_found');

    // GET /nokia/v1/sessions/:id
    if (!match[2] && req.method === 'GET') {
      // B6: If session or any turn is uncertain, attempt reconciliation via history
      const hasUncertain = session.state === 'unknown' || session.turns.some(t => t.state === 'unknown');
      if (hasUncertain) {
        await reconcileHistory(session);
      }
      return { status: 200, value: publicSession(session) };
    }

    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    if (!match[2]) throw new HttpError(405, 'method_not_allowed');

    const requestId = req.headers['x-request-id'];
    if (typeof requestId !== 'string' || !UUID.test(requestId)) throw new HttpError(400, 'uuid_request_id_required');

    // POST /nokia/v1/sessions/:id/turns
    if (match[2] === 'turns') {
      const ct = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
      const bytes = await readBody(req, ct === 'audio/ogg' ? AUDIO_LIMIT : TEXT_LIMIT * 4 + 128);
      let message = '';
      let attachments: RecordValue[] | undefined;

      if (ct === 'audio/ogg') {
        if (bytes.length < 4 || bytes.subarray(0, 4).toString() !== 'OggS') {
          throw new HttpError(400, 'invalid_ogg');
        }
        if (bytes.length > AUDIO_LIMIT) throw new HttpError(413, 'audio_too_large');
        attachments = [{
          type: 'audio', mimeType: 'audio/ogg', fileName: 'recording.ogg',
          content: bytes.toString('base64'),
        }];
      } else if (ct === 'application/json') {
        const payload = parseJson(bytes);
        exactKeys(payload, ['text']);
        if (typeof payload.text !== 'string' || !(payload.text as string).trim() ||
          (payload.text as string).length > TEXT_LIMIT) throw new HttpError(400, 'invalid_text');
        message = payload.text as string;
      } else {
        throw new HttpError(415, 'unsupported_media_type');
      }

      const fingerprint = hashStr(Buffer.concat([Buffer.from(ct!), bytes]));
      let turn!: Turn;
      const fresh = await store.transaction(() => {
        if (data.operations[requestId]) {
          reserve(requestId, deviceId, 'turn', fingerprint, session.id);
          turn = session.turns.find(t => t.requestId === requestId)!;
          return false;
        }
        if (session.state !== 'ready') throw new HttpError(409, 'session_not_ready');
        if (session.turns.some(isActive)) throw new HttpError(409, 'session_busy');
        const activeTurns = data.sessions.reduce((n, s) => n + s.turns.filter(isActive).length, 0);
        if (activeTurns >= MAX_CONCURRENT_ACTIVE) throw new HttpError(429, 'concurrent_run_limit');
        reserve(requestId, deviceId, 'turn', fingerprint, session.id);
        turn = { requestId, fingerprint, runId: requestId, state: 'running', messages: [] };
        if (message) turn.messages.push({ role: 'user', text: message });
        session.turns.push(turn);
        return true;
      });

      if (fresh) {
        // B5: Subscribe BEFORE send. If subscribe fails, abort the turn — do NOT send chat.
        let subscribeKey: string;
        try {
          const subResult = await options.gateway.subscribe(session.key, 'main');
          subscribeKey = subResult.key;
        } catch (error) {
          // Subscribe failed: mark turn unknown, do not send chat
          await store.transaction(() => { if (isActive(turn)) turn.state = 'unknown'; });
          throw error;
        }
        // Use the subscribe-returned key if it differs (canonical key from gateway)
        if (subscribeKey !== session.key) {
          await store.transaction(() => { session.key = subscribeKey; }).catch(() => {});
        }
        try {
          const ack = await options.gateway.request('chat.send', {
            sessionKey: session.key,
            agentId: 'main',
            message,
            idempotencyKey: requestId,
            deliver: false,
            ...(attachments ? { attachments } : {}),
          });
          // ack.runId is an acknowledgment of admission, not completion
          if (ack.runId !== requestId) {
            await store.transaction(() => { if (isActive(turn)) turn.state = 'unknown'; });
          }
        } catch (error) {
          await store.transaction(() => { if (isActive(turn)) turn.state = 'unknown'; });
          throw error;
        }
      }

      return {
        status: 202,
        value: { runId: turn.runId, state: publicTurnState(turn.state) },
      };
    }

    // POST /nokia/v1/sessions/:id/cancel
    if (match[2] === 'cancel') {
      // Require JSON body with { turnRequestId } — empty body rejected 400 to prevent late cancel hitting a new turn
      const ct = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') throw new HttpError(415, 'json_required');
      const payload = parseJson(await readBody(req, 512));
      exactKeys(payload, ['turnRequestId']);
      const turnRequestId = payload.turnRequestId;
      if (typeof turnRequestId !== 'string' || !UUID.test(turnRequestId)) {
        throw new HttpError(400, 'turn_request_id_required');
      }
      // Look up the exact turn — must belong to this owned session
      const targetTurn = session.turns.find(t => t.requestId === (turnRequestId as string));
      if (!targetTurn) throw new HttpError(409, 'turn_not_found');
      // If already terminal, return actual state without touching any new turn
      if (!isActive(targetTurn)) {
        return {
          status: 200,
          value: {
            runId: targetTurn.runId,
            state: publicTurnState(targetTurn.state),
            cancellation: 'already_terminal',
          },
        };
      }
      const fingerprint = hashStr(JSON.stringify({ sessionId: session.id, turnRequestId }));
      const fresh = await store.transaction(() =>
        reserve(requestId, deviceId, 'cancel', fingerprint, session.id)
      );
      if (fresh) {
        try {
          await options.gateway.request('chat.abort', {
            sessionKey: session.key,
            agentId: 'main',
            runId: targetTurn.runId,
          });
          await store.transaction(() => { data.operations[requestId].state = 'requested'; });
        } catch (error) {
          await store.transaction(() => { data.operations[requestId].state = 'unknown'; });
          throw error;
        }
      }
      return {
        status: 202,
        value: {
          runId: targetTurn.runId,
          cancellation: data.operations[requestId]?.state ?? 'no_active_run',
        },
      };
    }

    throw new HttpError(404, 'not_found');
  }

  // ── HTTP server ──────────────────────────────────────────────────────────
  const server = createServer((req, res) => {
    const send = (status: number, value: unknown) => {
      const encoded = JSON.stringify(value);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(encoded);
    };
    void route(req).then(r => send(r.status, r.value)).catch(error => {
      req.resume();
      const isKnown = error instanceof HttpError || error instanceof GatewayFailure;
      send(
        error instanceof HttpError ? error.status : 503,
        { error: isKnown ? error.code : 'bridge_unavailable' },
      );
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.timeout = 35_000;

  return { server, flush: () => store.flush() };
}
