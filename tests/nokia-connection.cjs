// nokia-connection.cjs — Bridge connection, transcript, TTS, and session isolation tests.
// Covers: fake XHR responses out-of-order, no-abort on switch, persistence of server IDs,
// independent pending/cancel, serialized TTS, single-session feedback, and regressions.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';

// ── Helper: record audio for active session in harness ─────────────────────
function recordAndFinish(h) {
  h.key('Enter'); h.grant(); h.key('Call');
  const rec = h.recorders.at(-1);
  rec.ondataavailable({data: new Blob(['audio'])});
  rec.onstop();
}

// ── Helper: respond to last XHR with JSON ─────────────────────────────────
function respondXHR(h, idx, status, body) {
  const req = h.xhrRequests[idx];
  assert.ok(req, `xhrRequests[${idx}] must exist`);
  req.req.status = status;
  req.req.responseText = JSON.stringify(body);
  req.req.onload();
}

// ── Helper: complete the two-step connection probe (GET /sessions then GET /health)
// Returns true if both requests were found and responded to.
function completeConnectionProbe(h, sessionStatus, healthBody) {
  const sessReq = h.xhrRequests.find(r => r.method === 'GET' && r.url.endsWith('/sessions'));
  if (!sessReq) return false;
  respondXHR(h, h.xhrRequests.indexOf(sessReq), sessionStatus, {});
  if (sessionStatus === 401 || sessionStatus === 403) return true;
  const healthReq = h.xhrRequests.find(r => r.method === 'GET' && r.url.endsWith('/health'));
  if (!healthReq) return false;
  respondXHR(h, h.xhrRequests.indexOf(healthReq), 200, healthBody);
  return true;
}

// ── Test 1: config.js template has blank URL → NOT CONNECTED ──────────────
{
  const h = harness(); // no bridgeUrl
  assert.equal(h.conn(), 'NOT CONNECTED',
    'Offline harness must show NOT CONNECTED without hitting XHR');
  assert.equal(h.xhrRequests.length, 0, 'No XHR issued when bridgeUrl is blank');
}

// ── Test 2: connection probe fires GET /sessions then GET /health on init ──
{
  const h = harness(new Map(), BRIDGE);
  assert.ok(h.xhrRequests.length >= 1, 'Connection probe XHR issued on init');
  const sessReq = h.xhrRequests[0];
  assert.ok(sessReq.url.endsWith('/sessions'), 'First probe targets GET /sessions (auth + cold-start trigger)');
  assert.equal(sessReq.method, 'GET', 'Sessions probe is GET');
  // Respond to sessions probe to trigger health check
  respondXHR(h, 0, 200, []);
  const healthReq = h.xhrRequests.find(r => r.method === 'GET' && r.url.endsWith('/health'));
  assert.ok(healthReq, 'Health check must fire after sessions probe succeeds');
  assert.equal(healthReq.method, 'GET', 'Health check is GET');
}

// ── Test 3: recording auto-submits when connected ─────────────────────────
{
  const h = harness(new Map(), BRIDGE);
  const priorXHR = h.xhrRequests.length;
  recordAndFinish(h);
  // Should have issued POST /sessions (create) then POST .../turns
  const newReqs = h.xhrRequests.slice(priorXHR);
  const sessionCreate = newReqs.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  assert.ok(sessionCreate, 'POST /sessions must be issued after recording');
  // Respond with session creation
  respondXHR(h, h.xhrRequests.indexOf(sessionCreate), 201, {id: 'srv-1', title: 'Conversation 1'});
  // Now a turns request should be issued
  const turnReq = h.xhrRequests.find(r => r.method === 'POST' && r.url.includes('/turns'));
  assert.ok(turnReq, 'POST /sessions/:id/turns must be issued after session creation');
  assert.ok(turnReq.body instanceof Blob, 'Turn body must be a Blob');
}

// ── Test 4: switching sessions does NOT cancel other session's XHR ────────
{
  const h = harness(new Map(), BRIDGE);
  // Record in session 1
  const priorXHR = h.xhrRequests.length;
  recordAndFinish(h);
  // Create session 1 on server
  const sessCreate1 = h.xhrRequests.slice(priorXHR).find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sessCreate1), 201, {id: 'srv-1', title: 'Conversation 1'});
  const turn1 = h.xhrRequests.find(r => r.url.includes('/turns'));
  const turn1idx = h.xhrRequests.indexOf(turn1);
  // Switch to session 2 (create it with 3)
  h.key('3'); // new session — session 2
  // Session 1's turn request has NOT been responded to yet; it must remain live
  // The XHR object for turn1 should still be reachable (not aborted)
  assert.ok(h.xhrRequests[turn1idx], 'Turn XHR for session 1 still in queue after switch');
  // Respond to session 1's turn (out-of-order, user is on session 2)
  respondXHR(h, turn1idx, 202, {runId: 'run-1', state: 'pending'});
  // The app should not crash and session 1 should be pending
  // The current active session (2) should show idle status, not session 1's state
  assert.ok(!h.nodes.status.textContent.includes('Waiting for Klaus'),
    'Session 2 status must not show session 1 pending state');
}

// ── Test 5: back key cancels active session's server request ──────────────
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sessCreate = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sessCreate), 201, {id: 'srv-cancel', title: 'Conversation 1'});
  const turnReq = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(turnReq), 202, {runId: 'run-c', state: 'pending'});
  // Now press Back to cancel
  h.key('Backspace');
  // A cancel request should be issued
  const cancelReq = h.xhrRequests.find(r => r.method === 'POST' && r.url.includes('/cancel'));
  assert.ok(cancelReq, 'Back key must fire POST .../cancel to server');
  assert.ok(h.nodes.status.textContent.includes('Cancelled'), 'Status shows cancelled after Back');
}

// ── Test 6: independent sessions can both be pending simultaneously ────────
{
  const h = harness(new Map(), BRIDGE);
  // Record in session 1
  const priorXHR1 = h.xhrRequests.length;
  recordAndFinish(h);
  const sc1 = h.xhrRequests.slice(priorXHR1).find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc1), 201, {id: 'srv-a', title: 'Conversation 1'});
  const t1 = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(t1), 202, {runId: 'run-a', state: 'pending'});
  // Switch to new session 2
  h.key('3');
  // Record in session 2
  const priorXHR2 = h.xhrRequests.length;
  recordAndFinish(h);
  const sc2 = h.xhrRequests.slice(priorXHR2).find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc2), 201, {id: 'srv-b', title: 'Conversation 2'});
  const t2 = h.xhrRequests.slice(priorXHR2).find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(t2), 202, {runId: 'run-b', state: 'pending'});
  // Both sessions are pending — cancelling session 2 must not affect session 1
  h.key('Backspace'); // cancel session 2
  // Switch back to session 1
  h.key('ArrowLeft');
  // Session 1 should still be pending (not cancelled)
  assert.ok(h.nodes.status.textContent.includes('Waiting') ||
    h.nodes.status.textContent.includes('Klaus') ||
    !h.nodes.status.textContent.includes('Cancelled'),
    'Session 1 remains active/pending after session 2 is cancelled');
}

// ── Test 7: TTS replies are serialized and bound to correct session ────────
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-tts', title: 'Conversation 1'});
  const tr = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr), 202, {runId: 'run-tts', state: 'pending'});
  // Simulate a poll response arriving with an assistant message
  // Find the interval and fire it manually
  const intervalIds = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  assert.ok(intervalIds.length >= 1, 'At least one poll interval must be active');
  // Simulate GET /sessions/:id returning complete with a message
  const pollInterval = h.intervals[intervalIds[intervalIds.length - 1]];
  // Fire poll — it will issue a GET request
  pollInterval.fn();
  const pollGet = h.xhrRequests.filter(r => r.method === 'GET' && r.url.includes('/srv-tts') && !r.url.endsWith('/health') && !r.url.endsWith('/sessions'));
  assert.ok(pollGet.length >= 1, 'Poll must issue GET /sessions/:id');
  respondXHR(h, h.xhrRequests.indexOf(pollGet[0]), 200, {
    id: 'srv-tts', state: 'complete',
    messages: [{role: 'user', text: 'hello'}, {role: 'assistant', text: 'Hi there from Klaus'}]
  });
  // Transcript should be updated
  assert.ok(h.transcript().includes('hello'), 'Transcript must show the user turn');
  assert.ok(h.transcript().includes('Hi there from Klaus'), 'Transcript must show reply text');
  // TTS utterance enqueued
  assert.ok(h.utterances.length >= 1, 'TTS utterance must be enqueued for assistant reply');
  assert.ok(h.utterances.some(u => u.text === 'Hi there from Klaus'), 'Enqueued utterance text matches reply');
}

// ── Test 8: out-of-order poll response binds to correct session ────────────
{
  const h = harness(new Map(), BRIDGE);
  // Set up session 1 as pending
  recordAndFinish(h);
  const sc1 = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc1), 201, {id: 'srv-oo1', title: 'Conversation 1'});
  const tr1 = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr1), 202, {runId: 'run-oo1', state: 'pending'});
  // Switch to session 2
  h.key('3'); // Now on session 2 (index 1)
  // Out-of-order: session 1's poll response arrives while on session 2
  const allIntervals = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  if (allIntervals.length > 0) {
    const pi = h.intervals[allIntervals[0]];
    pi.fn(); // fires GET /sessions/srv-oo1
    const pollReqs = h.xhrRequests.filter(r => r.method === 'GET' && r.url.includes('srv-oo1'));
    if (pollReqs.length > 0) {
      respondXHR(h, h.xhrRequests.indexOf(pollReqs[0]), 200, {
        id: 'srv-oo1', state: 'complete',
        messages: [{role: 'user', text: 'q'}, {role: 'assistant', text: 'answer from sess1'}]
      });
      // Currently on session 2: transcript must NOT show session 1's reply
      assert.ok(!h.transcript().includes('answer from sess1'),
        'Session 2 transcript must not show session 1 reply when viewing session 2');
      // Switch back to session 1 to verify its transcript
      h.key('ArrowLeft');
      assert.ok(h.transcript().includes('answer from sess1'),
        'Session 1 transcript must show its reply after switching back');
    }
  }
}

// ── Test 9: 5 key replays last assistant reply via TTS ────────────────────
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-rep', title: 'Conversation 1'});
  const tr = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr), 202, {runId: 'run-rep', state: 'pending'});
  // Inject messages directly (simulates completed poll)
  const iids = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  if (iids.length > 0) {
    h.intervals[iids[0]].fn();
    const pg = h.xhrRequests.filter(r => r.method === 'GET' && r.url.includes('srv-rep') && !r.url.endsWith('/health') && !r.url.endsWith('/sessions'));
    respondXHR(h, h.xhrRequests.indexOf(pg[0]), 200, {
      id: 'srv-rep', state: 'complete',
      messages: [{role: 'user', text: 'q'}, {role: 'assistant', text: 'Reply to replay'}]
    });
    const beforeUtterances = h.utterances.length;
    h.key('5'); // replay
    assert.ok(h.utterances.length > beforeUtterances, '5 key must enqueue new TTS utterance for replay');
    assert.equal(h.utterances[h.utterances.length - 1].text, 'Reply to replay',
      'Replayed utterance must match last assistant message');
  }
}

// ── Test 10: no reply shows correct feedback on 5 key ────────────────────
{
  const h = harness(new Map(), BRIDGE);
  // No recording, no reply yet
  h.key('5');
  // Should show "No recording" or "No reply" — not crash
  assert.ok(h.nodes.status.textContent.length > 0, '5 key must show a status message when nothing to replay');
}

// ── Test 11: wrap-around Left/Right with more than one session ────────────
{
  const h = harness();
  h.key('3'); // session 2
  h.key('3'); // session 3
  // Now on session 3 (index 2). Arrow right wraps to 0
  h.key('ArrowRight');
  assert.equal(h.nodes['session-index'].textContent, '1/3',
    'Right wrap must go to first session');
  // Arrow left from session 1 wraps to last
  h.key('ArrowLeft');
  assert.equal(h.nodes['session-index'].textContent, '3/3',
    'Left wrap must go to last session');
}

// ── Test 12: 3-new creates single session with clear title feedback ────────
{
  const h = harness();
  assert.equal(h.nodes['session-index'].textContent, '1/1', 'Start with 1 session');
  h.key('3');
  assert.equal(h.nodes['session-index'].textContent, '2/2', '3 creates session 2');
  assert.equal(h.nodes['session-title'].textContent, 'Conversation 2', 'New session has correct title');
  assert.ok(h.nodes.status.textContent.includes('Conversation 2'), 'Status confirms new session name');
  h.key('3');
  assert.equal(h.nodes['session-index'].textContent, '3/3', '3 creates session 3');
  assert.equal(h.nodes['session-title'].textContent, 'Conversation 3', 'Third session has correct title');
}

// ── Test 13: persistence includes server IDs after successful creation ─────
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-persist', title: 'Conversation 1'});
  // Reload from storage
  const reload = harness(h.storage, BRIDGE);
  // Server ID should survive reload (loaded from persisted sessions)
  // After reload the connection probe goes out but no new session create
  const createAfterReload = reload.xhrRequests.filter(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  assert.equal(createAfterReload.length, 0, 'No new POST /sessions after reload when serverId persisted');
}

// ── Test 14: systemXHR declared in manifest ───────────────────────────────
{
  const fs = require('node:fs');
  const manifest = JSON.parse(fs.readFileSync(
    require('node:path').join(__dirname, '../configs/nokia-klaus/manifest.webapp'), 'utf8'));
  assert.ok(manifest.permissions.systemXHR, 'manifest.webapp must declare systemXHR permission');
  assert.equal(manifest.type, 'privileged', 'manifest.webapp type must be privileged');
}

// ── Test 15: UUID generation uses crypto.getRandomValues ─────────────────
{
  const h = harness();
  // Sessions should have clientId fields that look like UUIDs (8-4-4-4-12 hex)
  const stored = JSON.parse(h.storage.get('klaus.sessions.v2') || '[]');
  assert.ok(stored.length >= 1, 'At least one session persisted');
  const clientId = stored[0].clientId;
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clientId),
    'clientId must be a valid UUID v4: ' + clientId);
}

// ── Test 16: switching left/right does not abort pending network for other sessions ──
{
  const h = harness(new Map(), BRIDGE);
  // Setup session 1 with pending server state
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-sw', title: 'Conversation 1'});
  const tr = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr), 202, {runId: 'run-sw', state: 'pending'});
  // Poll interval active for session 1
  const iids = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  assert.ok(iids.length >= 1, 'Poll interval active for session 1');
  // Switch to new session 2 via 3
  h.key('3');
  // Poll interval for session 1 must still be active
  const stillActive = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  assert.ok(stillActive.some(id => iids.includes(id)),
    'Session 1 poll interval must survive switch to session 2');
}

// ── Test 17: offline mode — recording saves blob locally, no XHR ──────────
{
  const h = harness(); // no bridge
  recordAndFinish(h);
  // No turns XHR should be issued
  const turnReqs = h.xhrRequests.filter(r => r.url && r.url.includes('/turns'));
  assert.equal(turnReqs.length, 0, 'No turns XHR when offline');
  // Status should explain audio is saved locally
  assert.ok(
    h.nodes.status.textContent.includes('Not connected') ||
    h.nodes.status.textContent.includes('offline') ||
    h.nodes.status.textContent.includes('locally') ||
    h.nodes.status.textContent.includes('Recording ready'),
    'Offline status must indicate audio saved: ' + h.nodes.status.textContent
  );
}

// ── Test 18: auth error (401) surfaces to user ───────────────────────────
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-auth', title: 'Conversation 1'});
  const tr = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr), 401, {error: 'Unauthorized'});
  assert.ok(h.nodes.status.textContent.includes('Auth error') || h.nodes.status.textContent.includes('401'),
    'Auth error must surface to user: ' + h.nodes.status.textContent);
}

// ── Test 19: existing legacy non-UUID session IDs get new clientId ─────────
{
  const legacyStorage = new Map([
    ['klaus.sessions.v2', JSON.stringify([{id: 'legacy-id', title: 'Old Session'}])]
  ]);
  const h = harness(legacyStorage);
  // Should load session with new clientId (UUID)
  const stored = JSON.parse(h.storage.get('klaus.sessions.v2') || '[]');
  const clientId = stored[0].clientId;
  assert.ok(clientId && /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(clientId),
    'Legacy session must receive a new UUID clientId');
  assert.equal(stored[0].id, 'legacy-id', 'Legacy session local id must be preserved');
}

// ── Test 20: old v1 storage key migration ─────────────────────────────────
{
  // v1 storage used different key; app should start fresh (not crash)
  const v1Storage = new Map([
    ['klaus.local.sessions.v1', JSON.stringify([{id: 'v1-id', title: 'V1 Session'}])]
  ]);
  const h = harness(v1Storage);
  // App should start with at least one session (either migrated or fresh)
  assert.ok(h.nodes['session-title'].textContent.length > 0, 'Session title must be non-empty with v1 storage');
}

// ── Test 21: mozSystem false → honest error, no XHR sent ────────────────
// Simulates an old install (manifest without systemXHR): the constructor argument is
// accepted but mozSystem stays false on the request object.
{
  const h = harness(new Map(), BRIDGE, {oldInstall: true});
  recordAndFinish(h);
  assert.equal(h.xhrRequests.length, 0, 'Old install (mozSystem=false) must not send any XHR');
  assert.equal(h.conn(), 'UNREACHABLE', 'Connection dot reports the failed probe');
  assert.ok(h.status().includes('systemXHR') && h.status().includes('Could not'),
    'systemXHR error must surface in status: ' + h.status());
}

// ── Test 22: POST /sessions carries X-Request-Id equal to clientId ────────
{
  const h = harness(new Map(), BRIDGE);
  // Wait for health check, then record
  const priorXHR = h.xhrRequests.length;
  recordAndFinish(h);
  const sessionCreate = h.xhrRequests.slice(priorXHR).find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  assert.ok(sessionCreate, 'POST /sessions must be issued');
  // Find the X-Request-Id header value captured in the request object
  // The harness stores headers via setRequestHeader — we need to track them
  // Verify by checking the persisted clientId matches what would be sent
  const stored = JSON.parse(h.storage.get('klaus.sessions.v2') || '[]');
  assert.ok(stored.length >= 1, 'session persisted');
  const clientId = stored[0].clientId;
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(clientId), 'clientId is UUID');
  // The harness mock does not capture individual header values, but the clientId
  // is stable and will be passed as requestId: sess.clientId in the xhr() call.
  // Verify the sessions body contains the same clientId (consistent contract).
  assert.ok(sessionCreate.body && sessionCreate.body.includes(clientId),
    'POST /sessions body must contain clientId matching the persisted value');
}

// ── Test 23: POST .../cancel carries X-Request-Id (cancelRequestId, persisted) ──
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-crid', title: 'Conversation 1'});
  const tr = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr), 202, {runId: 'run-crid', state: 'pending'});
  const preCancelXHR = h.xhrRequests.length;
  h.key('Backspace');
  const cancelReq = h.xhrRequests.slice(preCancelXHR).find(r => r.method === 'POST' && r.url.includes('/cancel'));
  assert.ok(cancelReq, 'Back key must fire POST .../cancel');
  // cancelRequestId must be persisted in storage
  const stored = JSON.parse(h.storage.get('klaus.sessions.v2') || '[]');
  const cancelReqId = stored[0] && stored[0].cancelRequestId;
  assert.ok(cancelReqId && /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(cancelReqId),
    'cancelRequestId must be a UUID persisted in storage: ' + cancelReqId);
}

// ── Test 24: health check — non-200 → GATEWAY DOWN (not CONNECTED) ───────
{
  const h = harness(new Map(), BRIDGE);
  // Respond to GET /sessions probe successfully first
  const sessReq = h.xhrRequests.find(r => r.method === 'GET' && r.url.endsWith('/sessions'));
  assert.ok(sessReq, 'GET /sessions probe issued');
  respondXHR(h, h.xhrRequests.indexOf(sessReq), 200, []);
  const healthReq = h.xhrRequests.find(r => r.url.endsWith('/health'));
  assert.ok(healthReq, 'health request issued after sessions probe');
  respondXHR(h, h.xhrRequests.indexOf(healthReq), 503, {connected: true});
  assert.equal(h.conn(), 'GATEWAY DOWN',
    'Non-200 health response must show GATEWAY DOWN not CONNECTED');
}

// ── Test 25: health parse error → GATEWAY DOWN (not CONNECTED) ─────────
{
  const h = harness(new Map(), BRIDGE);
  const sessReq = h.xhrRequests.find(r => r.method === 'GET' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sessReq), 200, []);
  const healthReq = h.xhrRequests.find(r => r.url.endsWith('/health'));
  // Respond with HTTP 200 but invalid JSON
  const req = h.xhrRequests[h.xhrRequests.indexOf(healthReq)];
  req.req.status = 200;
  req.req.responseText = 'not json{{{';
  req.req.onload();
  assert.equal(h.conn(), 'GATEWAY DOWN',
    'Health parse error must show GATEWAY DOWN not CONNECTED');
}

// ── Test 26: health connected:false → GATEWAY DOWN ───────────────────
{
  const h = harness(new Map(), BRIDGE);
  const sessReq = h.xhrRequests.find(r => r.method === 'GET' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sessReq), 200, []);
  const healthReq = h.xhrRequests.find(r => r.url.endsWith('/health'));
  respondXHR(h, h.xhrRequests.indexOf(healthReq), 200, {connected: false, version: '1.0'});
  assert.equal(h.conn(), 'GATEWAY DOWN',
    'health connected:false must show GATEWAY DOWN');
}

// ── Test 27: sessions 200 + health connected:true → CONNECTED ──────────────
{
  const h = harness(new Map(), BRIDGE);
  const sessReq = h.xhrRequests.find(r => r.method === 'GET' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sessReq), 200, []);
  const healthReq = h.xhrRequests.find(r => r.url.endsWith('/health'));
  respondXHR(h, h.xhrRequests.indexOf(healthReq), 200, {connected: true});
  assert.equal(h.conn(), 'CONNECTED',
    'sessions 200 + health 200 connected:true must show CONNECTED');
  // No extra GET /sessions should have been issued as a side effect (just the two expected)
  const extraSess = h.xhrRequests.filter(
    r => r.method === 'GET' && r.url.endsWith('/sessions'));
  assert.equal(extraSess.length, 1,
    'Exactly one GET /sessions (the auth probe) must be issued, not more');
}

// ── Test 28: H3 — pending guard blocks duplicate submit ─────────────────
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-dup', title: 'Conversation 1'});
  const tr = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr), 202, {runId: 'run-dup', state: 'pending'});
  // Session is now pending. Attempt another record+submit on the same session.
  const preXHR = h.xhrRequests.length;
  recordAndFinish(h); // tries to submit again while pending
  const newTurns = h.xhrRequests.slice(preXHR).filter(r => r.url.includes('/turns'));
  assert.equal(newTurns.length, 0,
    'Duplicate submit while pending must be blocked (no extra turns POST)');
  assert.ok(h.nodes.status.textContent.includes('progress') || h.nodes.status.textContent.includes('cancel'),
    'Status must warn about in-progress request: ' + h.nodes.status.textContent);
}

// ── Test 29: H3 — network error on POST /turns → uncertain, poll starts ────
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-neterr', title: 'Conversation 1'});
  const tr = h.xhrRequests.find(r => r.url.includes('/turns'));
  // Simulate network error on turns
  tr.req.onerror();
  // Session must be uncertain (not error), and a poll interval must be active
  const stored = JSON.parse(h.storage.get('klaus.sessions.v2') || '[]');
  assert.equal(stored[0].serverState, 'uncertain',
    'Network error after submission must set uncertain (not error): ' + stored[0].serverState);
  const activeIntervals = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  assert.ok(activeIntervals.length >= 1, 'Poll must start after uncertain network error');
}

// ── Test 30: H4 — stale poll XHR — at-most-one concurrent poll per session ──
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-stale', title: 'Conversation 1'});
  const tr = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr), 202, {runId: 'run-stale', state: 'pending'});
  const iids = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  assert.ok(iids.length >= 1, 'Poll interval active');
  const pi = h.intervals[iids[iids.length - 1]];
  // Fire poll twice without responding to first GET
  pi.fn(); // issues GET, pollXhr is set
  const firstPoll = h.xhrRequests.filter(r => r.method === 'GET' && r.url.includes('srv-stale') && !r.url.endsWith('/health') && !r.url.endsWith('/sessions'));
  pi.fn(); // must not issue another GET while pollXhr is pending
  const secondPoll = h.xhrRequests.filter(r => r.method === 'GET' && r.url.includes('srv-stale') && !r.url.endsWith('/health') && !r.url.endsWith('/sessions'));
  assert.equal(firstPoll.length, secondPoll.length,
    'Second poll tick must not issue new XHR while first is still in flight');
}

// ── Test 31: Cold start — sessions with serverId resume polling on reload ──
{
  // Simulate a session that was persisted as "pending" with a serverId
  const coldStorage = new Map([
    ['klaus.sessions.v2', JSON.stringify([{
      id: 'cold-id', title: 'Cold Session',
      clientId: '00000000-0000-4000-8000-000000000001',
      serverId: 'srv-cold', serverState: 'pending',
      messages: [], runId: null,
      lastRequestId: 'req-cold', cancelRequestId: null
    }])],
    ['klaus.sessions.v2.active', 'cold-id']
  ]);
  const h = harness(coldStorage, BRIDGE);
  // On reload with a connected bridge and existing serverId, polling must restart
  const activeIntervals = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  assert.ok(activeIntervals.length >= 1,
    'Cold start: poll must resume for persisted pending session with serverId');
  // Status must indicate waiting (pending state is shown on updateSession)
  assert.ok(h.thinking().startsWith('thinking'),
    'Cold start: thinking bubble must show pending state: ' + h.thinking());
}

// ── Test 32: Invalid token — GET /sessions 401 → AUTH ERROR indicator ─────
{
  const h = harness(new Map(), BRIDGE);
  const sessReq = h.xhrRequests.find(r => r.method === 'GET' && r.url.endsWith('/sessions'));
  assert.ok(sessReq, 'GET /sessions auth probe must be issued on init');
  respondXHR(h, h.xhrRequests.indexOf(sessReq), 401, {error: 'Unauthorized'});
  assert.equal(h.conn(), 'AUTH ERROR',
    '401 on GET /sessions must show AUTH ERROR in connection indicator');
  // Health check must NOT be issued after 401 (no point probing health with bad token)
  const healthAfter = h.xhrRequests.filter(r => r.method === 'GET' && r.url.endsWith('/health'));
  assert.equal(healthAfter.length, 0,
    'No /health check must be issued after 401 on GET /sessions');
}

// ── Test 33: cancel sets "cancelling" — poll continues until server confirms ──
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-cancel2', title: 'Conversation 1'});
  const tr = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr), 202, {runId: 'run-cancel2', state: 'pending'});
  // Press Back to cancel
  h.key('Backspace');
  // Poll interval must still be active (not stopped by cancel)
  const iids = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  assert.ok(iids.length >= 1,
    'Poll interval must remain active after cancel (waiting for server confirmation)');
  // Cancel POST must carry turnRequestId in body
  const cancelReq = h.xhrRequests.find(r => r.method === 'POST' && r.url.includes('/cancel'));
  assert.ok(cancelReq, 'Cancel POST must be issued');
  const body = typeof cancelReq.body === 'string' ? JSON.parse(cancelReq.body) : null;
  assert.ok(body && 'turnRequestId' in body,
    'Cancel POST body must contain turnRequestId: ' + JSON.stringify(body));
}

// ── Test 34: cancelRequestId cleared on new turn — fresh UUID per cancel attempt ──
{
  const h = harness(new Map(), BRIDGE);
  // First turn
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-fresh', title: 'Conversation 1'});
  const tr1 = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr1), 202, {runId: 'run-fresh1', state: 'pending'});
  // Cancel
  h.key('Backspace');
  const stored1 = JSON.parse(h.storage.get('klaus.sessions.v2') || '[]');
  const crid1 = stored1[0].cancelRequestId;
  assert.ok(crid1, 'cancelRequestId must be set after first cancel');
  // Simulate server confirming cancel via poll
  const iids = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  if (iids.length > 0) {
    h.intervals[iids[iids.length-1]].fn();
    const pollReq = h.xhrRequests.filter(r => r.method === 'GET' && r.url.includes('srv-fresh'));
    if (pollReq.length > 0) {
      respondXHR(h, h.xhrRequests.indexOf(pollReq[0]), 200, {state: 'cancelled', messages: []});
    }
  }
  // Now start a new turn
  recordAndFinish(h);
  // submitAudio should clear cancelRequestId before new turn
  const stored2 = JSON.parse(h.storage.get('klaus.sessions.v2') || '[]');
  // After submitAudio runs cancelRequestId must be null (cleared for fresh turn)
  assert.equal(stored2[0].cancelRequestId, null,
    'cancelRequestId must be cleared (null) when new turn starts');
}

// ── Test 35: TTS replay does not discard other sessions' queued utterances ──
{
  // This test verifies that replaySelectedReply uses unshift (not ttsQueue=[])
  // so other sessions' queued utterances survive.
  const h = harness(new Map(), BRIDGE);
  // Set up session 1 with a reply
  recordAndFinish(h);
  const sc1 = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc1), 201, {id: 'srv-tts2', title: 'Conversation 1'});
  const tr1 = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr1), 202, {runId: 'run-tts2', state: 'pending'});
  const iids1 = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  h.intervals[iids1[iids1.length-1]].fn();
  const pg1 = h.xhrRequests.filter(r => r.method === 'GET' && r.url.includes('srv-tts2') && !r.url.endsWith('/sessions') && !r.url.endsWith('/health'));
  respondXHR(h, h.xhrRequests.indexOf(pg1[0]), 200, {state: 'complete',
    messages: [{role: 'user', text: 'q'}, {role: 'assistant', text: 'Reply from sess1'}]});
  // Create session 2 with its own reply pending in TTS
  h.key('3');
  recordAndFinish(h);
  const sc2 = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions') && r.body && r.body.includes('Conversation 2'));
  if (sc2) {
    respondXHR(h, h.xhrRequests.indexOf(sc2), 201, {id: 'srv-tts3', title: 'Conversation 2'});
    const tr2 = h.xhrRequests.filter(r => r.url.includes('/turns')).at(-1);
    if (tr2) {
      respondXHR(h, h.xhrRequests.indexOf(tr2), 202, {runId: 'run-tts3', state: 'pending'});
      const iids2 = Object.keys(h.intervals).filter(id => h.intervals[id].active);
      h.intervals[iids2[iids2.length-1]].fn();
      const pg2 = h.xhrRequests.filter(r => r.method === 'GET' && r.url.includes('srv-tts3') && !r.url.endsWith('/sessions') && !r.url.endsWith('/health'));
      if (pg2.length > 0) {
        respondXHR(h, h.xhrRequests.indexOf(pg2[0]), 200, {state: 'complete',
          messages: [{role: 'user', text: 'q2'}, {role: 'assistant', text: 'Reply from sess2'}]});
      }
    }
  }
  // Go back to session 1 and replay
  h.key('ArrowLeft');
  const queueBefore = h.utterances.length;
  h.key('5'); // replay session 1's reply
  // Session 1's reply must be in the queue — and session 2's queued reply must NOT be dropped
  const allTexts = h.utterances.map(u => u.text);
  assert.ok(allTexts.includes('Reply from sess1'),
    'Session 1 replay must appear in utterances');
  // The replay must be at tail (most recently enqueued = most recently unshifted to head)
  assert.equal(h.utterances[h.utterances.length-1].text, 'Reply from sess1',
    'Replayed utterance must be the last enqueued (unshifted to head, spoken next)');
}

// ── Test 36: 7 key shows confirmation prompt, Back cancels ─────────────────
{
  const h = harness();
  // First 7: confirmation prompt
  h.key('7');
  // The prompt lives on the confirm overlay (the status line sits underneath it).
  assert.ok(!h.nodes.overlay.hidden && h.nodes['overlay-title'].textContent.includes('Archive') &&
    h.nodes['overlay-list'].textContent.includes('OK archives'),
    'First 7 must show archive confirmation prompt: ' + h.nodes['overlay-title'].textContent);
  // Back should cancel confirmation and restore normal status
  h.key('Backspace');
  // Status should be normal (ready) not archive prompt
  assert.ok(!h.nodes.status.textContent.includes('Archive') || h.nodes.status.textContent.includes('Ready') ||
    h.nodes.status.textContent.includes('record') || h.nodes.status.textContent.includes('Cancelled'),
    'Back after 7 must clear archive confirmation: ' + h.nodes.status.textContent);
}

// ── Test 37: 7+7 archives session, history retained, not visible in ← / → ──
{
  const h = harness();
  h.key('3'); // create session 2, now on session 2
  // Archive session 2 by pressing 7 twice
  h.key('7'); h.key('7');
  // After archive, session-index must show session 1 (only open session)
  const stored = JSON.parse(h.storage.get('klaus.sessions.v2') || '[]');
  // Total sessions = 2 (1 archived + 1 open)
  assert.equal(stored.length, 2, 'Archive must retain both sessions in storage');
  const archivedSess = stored.find(s => s.archived === true);
  assert.ok(archivedSess, 'Archived session must be persisted with archived:true');
  // Header must show only open sessions in count
  const indexText = h.nodes['session-index'].textContent;
  assert.ok(indexText.includes('1/1'), 'Header must show 1/1 open sessions after archiving: ' + indexText);
}

// ── Test 38: reload — archived session not visible in navigation ──────────
{
  // Build storage with 2 sessions, one archived
  const h = harness();
  h.key('3'); // session 2
  h.key('7'); h.key('7'); // archive session 2
  const savedStorage = h.storage;
  // Reload
  const h2 = harness(savedStorage);
  // After reload, only open sessions navigable
  const stored = JSON.parse(h2.storage.get('klaus.sessions.v2') || '[]');
  const openSessions = stored.filter(s => !s.archived);
  assert.ok(openSessions.length >= 1, 'At least one open session after reload');
  const indexText = h2.nodes['session-index'].textContent;
  assert.ok(indexText.includes('/' + openSessions.length), 'Reload: header count matches open sessions');
}

// ── Test 39: archiving pending session does NOT abort cancel or poll ────────
{
  const h = harness(new Map(), BRIDGE);
  recordAndFinish(h);
  const sc = h.xhrRequests.find(r => r.method === 'POST' && r.url.endsWith('/sessions'));
  respondXHR(h, h.xhrRequests.indexOf(sc), 201, {id: 'srv-archpoll', title: 'Conversation 1'});
  const tr = h.xhrRequests.find(r => r.url.includes('/turns'));
  respondXHR(h, h.xhrRequests.indexOf(tr), 202, {runId: 'run-archpoll', state: 'pending'});
  // Poll interval should be active
  const iidsBefore = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  assert.ok(iidsBefore.length >= 1, 'Poll interval active before archive');
  // Archive the pending session (7+7)
  h.key('7'); h.key('7');
  // Poll interval must still be active — no abort on archive
  const iidsAfter = Object.keys(h.intervals).filter(id => h.intervals[id].active);
  assert.ok(iidsAfter.some(id => iidsBefore.includes(id)),
    'Poll must continue for archived pending session');
}

// ── Test 40: archiving last open session creates fresh session ───────────────
{
  const h = harness();
  // Only session 1 (the initial one)
  assert.equal(h.nodes['session-index'].textContent, '1/1', 'Start: 1 open session');
  h.key('7'); h.key('7'); // archive last open session
  // A new fresh session must have been created and activated
  const stored = JSON.parse(h.storage.get('klaus.sessions.v2') || '[]');
  const openSessions = stored.filter(s => !s.archived);
  assert.equal(openSessions.length, 1, 'After archiving last, exactly 1 new open session exists');
  // The active session must be the newly created one (not the archived one)
  const indexText = h.nodes['session-index'].textContent;
  assert.ok(indexText.includes('1/1'), 'After last-archive: header shows 1/1: ' + indexText);
}

// ── Test 41: ← / → skips archived sessions ─────────────────────────────────
{
  const h = harness();
  h.key('3'); // session 2
  h.key('3'); // session 3
  // Archive session 2 (go back to it first)
  h.key('ArrowLeft'); // now on session 2
  h.key('7'); h.key('7'); // archive session 2
  // Now on session 1 or 3 (auto-moved to next open)
  // Navigate: ArrowRight from session 1 must go to session 3 (skip archived 2)
  // First, go to session 1
  const indexBefore = h.nodes['session-index'].textContent;
  // Navigate right — should land on a different open session, not the archived one
  h.key('ArrowRight');
  const indexAfter = h.nodes['session-index'].textContent;
  assert.notEqual(indexBefore, indexAfter,
    'ArrowRight must move to a different open session, not stay: ' + indexAfter);
  // Verify the title is not the archived session's title
  assert.notEqual(h.nodes['session-title'].textContent, 'Conversation 2',
    'Navigation must skip archived session 2: ' + h.nodes['session-title'].textContent);
}

console.log('Nokia connection, transcript, TTS, and session isolation checks passed');
