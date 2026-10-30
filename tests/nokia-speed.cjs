// nokia-speed.cjs — long-chat performance: the transcript is virtualised so only a window
// around the viewport lives in the DOM (capped live message rows, recycled slot nodes),
// non-critical launch work is split from first paint, and the node budget is pinned by a
// deterministic 500-message chat. The store and the poll path both cap a stored chat at
// 128 messages, so the 500-row budget is exercised against the public uiMessages API and
// the 128-row maximum through the real send/poll path.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';
const SKEY = 'klaus.sessions.v2';
const NOW = 1700000000000;
// Fixed fake geometry: every row reports 38 px (the engine's estimate), the view is 200 px,
// so offset estimates are exact and the claims below are deterministic.
const ROW = 38;
const VIEW = 200;
const last = (h, pred) => h.xhrRequests.filter(pred).at(-1);
const isTurn = r => r.url.endsWith('/turns');
const msg = (role, text) => ({role, text});
function respond(h, req, status, body) {
  req.req.status = status;
  req.req.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  req.req.onload();
}
function newSess(id, title, serverId, messages, updatedAt, extra = {}) {
  return Object.assign({
    id, title, clientId: 'c-' + id, serverId: serverId || null, serverState: 'idle',
    messages, runId: null, lastRequestId: null, cancelRequestId: null, archived: false,
    pendingSince: 0, lastText: null, uploadPending: false, textPending: false,
    outboxId: null, outboxAudio: false, updatedAt, pinned: false, named: true, voiceTurns: []
  }, extra);
}
function bigMsgs(count) {
  const m = [];
  for (let i = 0; i < count; i++) m.push(i % 2 ? msg('assistant', 'Reply ' + i) : msg('user', 'Question ' + i));
  return m;
}
const liveRows = h => h.nodes.transcript.children.filter(c => /msg/.test(c.className));
const allRows = h => h.nodes.transcript.children;

// ── 500-message node budget: capped live rows, recycled slots, spacer-reported height ──
{
  const h = harness(new Map(), BRIDGE);
  const K = h.context.Klaus;
  const cap = K.UI_POOL_MAX;
  assert.ok(cap > 0 && cap <= 30, 'the pool cap exists and stays small (<= 30)');
  K.uiMessages('s-big', bigMsgs(500));
  const nodes = () => allRows(h).length;
  const pool = () => K.uiPoolInfo();
  // Arriving on a 500-row transcript: the model holds everything, the DOM holds a bounded
  // window at the newest rows, and one top spacer answers for the hidden history.
  assert.equal(pool().total, 500, 'the transcript model holds all 500 rows');
  assert.ok(pool().live > 0 && pool().live <= cap, 'the initial window is a bounded, in-cap set of rows');
  assert.equal(pool().end, 500, 'the window sits at the newest rows');
  assert.equal(h.nodes.chat.scrollHeight, 500 * ROW, 'the spacer answers for the whole hidden history');
  assert.equal(h.nodes.chat.scrollTop, 500 * ROW - VIEW, 'the reader is pinned to the bottom');
  assert.ok(nodes() <= cap + 2, 'rows plus at most two spacers');
  assert.ok(h.transcript().includes('Reply 499'), 'the newest rows are live on arrival');
  assert.ok(!h.transcript().includes('Question 0'), 'the oldest rows are out of the DOM');
  // A viewport taller than the pool (mid-history): the cap binds at exactly cap live rows.
  // (On the handset every scroll arrives through a key press that funnels through uiPage;
  // uiPage(0) is that same path re-rendering the current window.)
  h.nodes.chat.clientHeight = 1200;
  h.nodes.chat.scrollTop = 250 * ROW;
  K.uiPage(0);
  assert.equal(liveRows(h).length, cap, 'a window over the cap is clipped to the cap');
  assert.ok(nodes() <= cap + 2, 'capped window is rows + spacers only');
  assert.ok(h.transcript().includes('Reply 259') && h.transcript().includes('Question 272'),
    'the capped window shows the mid-history rows it is supposed to show');
  assert.ok(!h.transcript().includes('Question 0'), 'the top of the history stays out of the DOM');
  h.nodes.chat.clientHeight = VIEW;
}
// ── Key navigation on the full live chat: focus, page and end recycle in place ────
// (Runs on the maximum stored chat, 128 rows, through the real send/poll path below —
// the key paths read the app's own session cursor, so the model has to be in-session.)
{
  const storage = new Map();
  const seed = newSess('s-key', 'Key chat', 'srv-key', [msg('user', 'q0'), msg('assistant', 'a0')], NOW - 2000);
  storage.set(SKEY, JSON.stringify([seed]));
  storage.set(SKEY + '.active', 's-key');
  const h = harness(storage, BRIDGE);
  const K = h.context.Klaus;
  const cap = K.UI_POOL_MAX;
  h.key('SoftLeft'); h.composer.value = 'ping'; h.key('Enter');
  respond(h, last(h, isTurn), 202, {runId: 'r-key', state: 'pending'});
  let pid = Object.keys(h.pollTimers).find(id => h.pollTimers[id].active);
  assert.ok(pid, 'a poll must be scheduled'); h.pollTimers[pid].fn();
  respond(h, last(h, r => r.method === 'GET' && r.url.endsWith('/sessions/srv-key')), 200,
    {state: 'complete', messages: bigMsgs(128)});
  h.finishSpeech();
  const nodes = () => allRows(h).length;
  assert.equal(h.nodes.chat.scrollTop, 128 * ROW - VIEW, 'arrival pins the reader to the bottom');
  assert.ok(liveRows(h).length <= cap, 'arrival renders a bounded window, not the 128 rows');
  assert.ok(h.transcript().includes('Reply 127') && !h.transcript().includes('Question 0'),
    'the newest rows are live, the oldest are out of the DOM');
  // 1 focuses the oldest message; the window jumps to it and the slot node that held
  // row 123 is recycled to row 0.
  const captured = liveRows(h)[0];
  h.key('1');
  const focused = allRows(h).filter(c => /\bsel\b/.test(c.className));
  assert.equal(focused.length, 1, '1 focuses the oldest message');
  assert.equal(focused[0].textContent, 'Question 0');
  assert.ok(h.transcript().includes('Question 0') && !h.transcript().includes('Reply 127'),
    'the window followed the focus to the top');
  assert.ok(nodes() <= cap + 2, 'focus repaint stays inside the budget');
  h.key('8'); // page down through the live window
  assert.ok(liveRows(h).length <= cap, 'the page-down window is inside the cap');
  assert.ok(liveRows(h).some(c => c.textContent === 'Question 4'), 'a recycled slot shows the next page of rows');
  assert.ok(!h.transcript().includes('Question 0'), 'row 0 left the live window');
  assert.ok(liveRows(h).some(c => c === captured), 'the captured node was reused, not re-created');
  assert.ok(nodes() <= cap + 2, 'page down stays inside the budget');
  h.key('9');
  assert.ok(liveRows(h).length <= cap, 'the end window is inside the cap');
  assert.ok(h.transcript().includes('Reply 127'), 'the newest row is live at the end');
}
// ── The stored maximum (128 messages) through the real send/poll path ──────────────
{
  const storage = new Map();
  const seed = newSess('s-max', 'Max chat', 'srv-max', [msg('user', 'q0'), msg('assistant', 'a0')], NOW - 2000);
  storage.set(SKEY, JSON.stringify([seed]));
  storage.set(SKEY + '.active', 's-max');
  const h = harness(storage, BRIDGE);
  const K = h.context.Klaus;
  h.key('SoftLeft'); h.composer.value = 'ping'; h.key('Enter');
  respond(h, last(h, isTurn), 202, {runId: 'r-max', state: 'pending'});
  const pid = Object.keys(h.pollTimers).find(id => h.pollTimers[id].active);
  assert.ok(pid, 'a poll must be scheduled'); h.pollTimers[pid].fn();
  // The bridge may carry a history beyond the store cap; the model keeps the 128-message
  // cap and the view is a bounded window at the bottom.
  respond(h, last(h, r => r.method === 'GET' && r.url.endsWith('/sessions/srv-max')), 200,
    {state: 'complete', messages: bigMsgs(300)});
  assert.equal(h.nodes.chat.scrollHeight, 128 * ROW, 'a chat is capped at 128 messages end to end');
  assert.equal(h.nodes.chat.scrollTop, 128 * ROW - VIEW, 'arrival pins the reader to the bottom');
  assert.ok(liveRows(h).length > 0 && liveRows(h).length <= K.UI_POOL_MAX, 'arrival renders a bounded window, not the whole chat');
  assert.ok(h.transcript().includes('Reply 127'), 'the newest of the 128 rows is live');
  assert.ok(!h.transcript().includes('Question 0'), 'rows that exceed the cap never reached the DOM');
  h.finishSpeech();
}
// ── Appends reuse the rendered prefix: existing row nodes keep their identity ───────
{
  const storage = new Map();
  const seed = newSess('s-seed', 'Reuse', 'srv-seed', [msg('user', 'first'), msg('assistant', 'second')], NOW - 1000);
  storage.set(SKEY, JSON.stringify([seed]));
  storage.set(SKEY + '.active', 's-seed');
  const h = harness(storage, BRIDGE);
  const firstRow = allRows(h)[0];
  h.key('SoftLeft'); h.composer.value = 'next'; h.key('Enter');
  respond(h, last(h, isTurn), 202, {runId: 'r-reuse', state: 'pending'});
  const pid = Object.keys(h.pollTimers).find(id => h.pollTimers[id].active);
  assert.ok(pid, 'a poll must be scheduled'); h.pollTimers[pid].fn();
  respond(h, last(h, r => r.method === 'GET' && r.url.endsWith('/sessions/srv-seed')), 200,
    {state: 'complete', messages: [msg('user', 'first'), msg('assistant', 'second'), msg('user', 'next'), msg('assistant', 'third')]});
  assert.equal(allRows(h).at(-1).textContent, 'third', 'the reply is appended');
  assert.ok(allRows(h).some(c => c === firstRow), 'the first row node was reused, not re-rendered');
}
// ── Launch split: the deferred probe and the resumed poll still run on boot ─────────
{
  const h = harness(new Map(), BRIDGE);
  assert.ok(last(h, r => r.method === 'GET' && r.url.endsWith('/sessions')), 'the connection probe is issued on launch');
  const storage = new Map();
  const busy = newSess('s-busy', 'Busy', 'srv-busy', [msg('user', 'waiting')], NOW, {
    serverState: 'pending', runId: 'r-busy', lastRequestId: 'req-busy', outboxId: 'req-busy', pendingSince: NOW
  });
  storage.set(SKEY, JSON.stringify([busy]));
  storage.set(SKEY + '.active', 's-busy');
  const h2 = harness(storage, BRIDGE);
  assert.equal(h2.activePolls().length, 1, 'a turn in flight resumes polling at launch, before the idle tick');
  h2.pollTimers[Object.keys(h2.pollTimers).find(id => h2.pollTimers[id].active)].fn();
  respond(h2, last(h2, r => r.method === 'GET' && r.url.endsWith('/sessions/srv-busy')), 200,
    {state: 'complete', runId: 'req-busy', messages: [msg('user', 'waiting'), msg('assistant', 'done')]});
  assert.equal(h2.activePolls().length, 0, 'a completed turn stops the resumed poll');
}
// ── Key-down feedback happens before any paint work, so input stays instant ───────
{
  const h = harness();
  h.key('Enter');
  assert.equal(h.nodes['sk-center'].className, 'press', 'the centre key lights at once');
  h.handlers.keyup({key: 'Enter'});
  assert.equal(h.nodes['sk-center'].className, '');
}

console.log('Nokia speed (virtualised transcript, launch split) checks passed');