// nokia-reliability.cjs — network loss: reconnect probes, queued text resend and idempotent turn resend.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';

function respond(h, req, status, body) {
  req.req.status = status;
  req.req.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  req.req.onload();
}
const last = (h, pred) => h.xhrRequests.filter(pred).at(-1);
const isCreate = r => r.method === 'POST' && r.url.endsWith('/sessions');
const isTurn = r => r.url.endsWith('/turns');
const isProbe = r => r.method === 'GET' && r.url.endsWith('/sessions');
const isPoll = id => r => r.method === 'GET' && r.url.endsWith('/sessions/' + id);
function tick(h) { Object.keys(h.tickers).filter(id => h.tickers[id].active).forEach(id => h.tickers[id].fn()); }
function firePoll(h) { const id = h.activePolls().at(-1); assert.ok(id, 'a poll must be scheduled'); h.pollTimers[id].fn(); }
// Answer the newest connection probe (GET /sessions, then GET /health).
function answerProbe(h, ok = true) {
  const probe = last(h, isProbe);
  if (!ok) { probe.req.onerror(); return; }
  respond(h, probe, 200, []);
  respond(h, last(h, r => r.url.endsWith('/health')), 200, {connected: true});
}
function record(h) {
  h.key('Enter'); h.grant(); h.key('Call');
  const rec = h.recorders.at(-1);
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
}
function typeAndSend(h, text) { h.key('SoftLeft'); h.composer.value = text; h.key('Enter'); }

// ── Typed text queued on network loss is resent by the periodic probe ──────
{
  const h = harness(new Map(), BRIDGE);
  answerProbe(h);
  assert.equal(h.conn(), 'CONNECTED');
  typeAndSend(h, 'queued text');
  last(h, isCreate).req.onerror();
  assert.match(h.status(), /Queued; sends when back online/);
  assert.equal(h.conn(), 'UNREACHABLE', 'a failed send flips the dot immediately');
  assert.equal(JSON.parse(h.storage.get('klaus.sessions.v2'))[0].textPending, true, 'queued text persisted');
  const probes = h.xhrRequests.filter(isProbe).length;
  h.clock.t += 5000; tick(h);
  assert.equal(h.xhrRequests.filter(isProbe).length, probes, 'no probe before the offline interval');
  h.clock.t += 11000; tick(h);
  assert.equal(h.xhrRequests.filter(isProbe).length, probes + 1, 'offline re-probe after 15 s');
  answerProbe(h, false);
  assert.equal(h.conn(), 'UNREACHABLE');
  h.clock.t += 16000; tick(h);
  answerProbe(h);
  assert.equal(h.conn(), 'CONNECTED');
  assert.match(h.status(), /Back online/);
  respond(h, last(h, isCreate), 201, {id: 'srv-q'});
  assert.deepEqual(JSON.parse(last(h, isTurn).body), {text: 'queued text'});
  respond(h, last(h, isTurn), 202, {runId: 'r', state: 'pending'});
  assert.equal(JSON.parse(h.storage.get('klaus.sessions.v2'))[0].textPending, false, 'accepted text leaves the queue');
  const turns = h.xhrRequests.filter(isTurn).length;
  h.clock.t += 61000; tick(h); answerProbe(h);
  assert.equal(h.xhrRequests.filter(isTurn).length, turns, 'an accepted text is never resent');
}

// ── Queued text survives an app restart ─────────────────────────────────────
{
  const storage = new Map();
  const h = harness(storage, BRIDGE);
  answerProbe(h);
  typeAndSend(h, 'after restart');
  last(h, isCreate).req.onerror();
  const h2 = harness(storage, BRIDGE);
  answerProbe(h2);
  respond(h2, last(h2, isCreate), 201, {id: 'srv-restart'});
  assert.deepEqual(JSON.parse(last(h2, isTurn).body), {text: 'after restart'});
}

// ── A turn POST lost to the network is resent with the same X-Request-Id ────
{
  const h = harness(new Map(), BRIDGE);
  answerProbe(h);
  record(h);
  respond(h, last(h, isCreate), 201, {id: 'srv-lost'});
  const first = last(h, isTurn);
  first.req.onerror();
  assert.match(h.status(), /Will resend when back online/);
  assert.equal(h.conn(), 'UNREACHABLE');
  h.handlers.online();
  answerProbe(h);
  const again = last(h, isTurn);
  assert.notEqual(again, first, 'turn POST resent after reconnect');
  assert.equal(again.headers['X-Request-Id'], first.headers['X-Request-Id'], 'resend is idempotent');
  assert.ok(again.body instanceof Blob, 'same clip resent');
  respond(h, again, 202, {runId: first.headers['X-Request-Id'], state: 'pending'});
  const turns = h.xhrRequests.filter(isTurn).length;
  h.handlers.online(); answerProbe(h);
  assert.equal(h.xhrRequests.filter(isTurn).length, turns, 'accepted turn is not resent');
  firePoll(h);
  respond(h, last(h, isPoll('srv-lost')), 200, {state: 'complete', messages: [{role: 'user', text: 'clip'}, {role: 'assistant', text: 'ok'}]});
  assert.equal(h.status(), '', 'the reply clears the reconnect notice');
}

// ── A poll showing the bridge never saw the turn triggers the resend ────────
{
  const h = harness(new Map(), BRIDGE);
  answerProbe(h);
  typeAndSend(h, 'poll resend');
  respond(h, last(h, isCreate), 201, {id: 'srv-p'});
  const first = last(h, isTurn);
  first.req.onerror();
  firePoll(h);
  respond(h, last(h, isPoll('srv-p')), 200, {state: 'idle', messages: []});
  const again = last(h, isTurn);
  assert.notEqual(again, first);
  assert.equal(again.headers['X-Request-Id'], first.headers['X-Request-Id']);
  assert.deepEqual(JSON.parse(again.body), {text: 'poll resend'});
}

// ── Back cancels a turn waiting for resend; nothing is sent later ──────────
{
  const h = harness(new Map(), BRIDGE);
  answerProbe(h);
  record(h);
  respond(h, last(h, isCreate), 201, {id: 'srv-c'});
  last(h, isTurn).req.onerror();
  assert.equal(h.key('Backspace'), true);
  const turns = h.xhrRequests.filter(isTurn).length;
  h.handlers.online(); answerProbe(h);
  assert.equal(h.xhrRequests.filter(isTurn).length, turns, 'cancelled turn is not resent');
}

// ── Offline event gives immediate feedback ─────────────────────────────────
{
  const h = harness(new Map(), BRIDGE);
  answerProbe(h);
  h.handlers.offline();
  assert.equal(h.conn(), 'UNREACHABLE');
  assert.match(h.status(), /Offline/);
}

console.log('Nokia reliability (reconnect, queue, idempotent resend) checks passed');
