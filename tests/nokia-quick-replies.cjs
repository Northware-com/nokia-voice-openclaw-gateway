// nokia-quick-replies.cjs — 0 opens quick replies; 1-9 (or Up/Down + OK) sends one as a typed turn.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';
function respond(req, status, body) {
  req.req.status = status;
  req.req.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  req.req.onload();
}
const last = (h, pred) => h.xhrRequests.filter(pred).at(-1);
const isCreate = r => r.method === 'POST' && r.url.endsWith('/sessions');
const isTurn = r => r.url.endsWith('/turns');
const isPoll = id => r => r.method === 'GET' && r.url.endsWith('/sessions/' + id);
function firePoll(h) { const id = h.activePolls().at(-1); assert.ok(id, 'a poll must be scheduled'); h.pollTimers[id].fn(); }
const items = h => h.nodes['overlay-list'].children.map(c => c.textContent);

// ── Pure key map and lists ─────────────────────────────────────────────────
{
  const K = harness().context.Klaus;
  assert.equal(K.mapKey('idle', '0', true), 'quick');
  for (const d of '123456789') assert.equal(K.mapKey('quick', d, true), 'pick', `quick ${d}`);
  assert.equal(K.mapKey('quick', '0', true), 'none');
  assert.equal(K.mapKey('quick', 'Enter', true), 'select');
  assert.equal(K.mapKey('quick', 'ArrowDown', true), 'down');
  assert.equal(K.mapKey('quick', 'Backspace', true), 'close');
  assert.equal(K.mapKey('quick', 'Call', true), 'none');
  assert.deepEqual(Array.from(K.softkeysFor('quick', '')), ['Close', 'Send', '']);
  const en = Array.from(K.quickReplies('Shall I book it?'));
  assert.equal(en.length, 9, 'one reply per digit');
  assert.deepEqual(en.slice(0, 3), ['Yes', 'No', 'Thanks!']);
  assert.deepEqual(Array.from(K.quickReplies('Skal jeg booke det til på fredag?')).slice(0, 3), ['Ja', 'Nej', 'Tak!'],
    'Danish replies after a Danish answer');
  assert.equal(K.quickReplies('')[0], 'Yes', 'English by default');
  assert.ok(Array.from(K.quickReplies('x')).every(t => t.length <= 24), 'every reply fits one 240 px row');
}

// ── 0 then a digit sends at once ───────────────────────────────────────────
{
  const h = harness(new Map(), BRIDGE);
  h.key('0');
  assert.deepEqual(h.softkeys(), ['Close', 'Send', '']);
  assert.equal(h.nodes['overlay-title'].textContent, 'Quick reply · 1-9 sends');
  assert.equal(items(h)[0], '1Yes', 'digit badge + label');
  assert.equal(items(h)[8], '9Stop, that\'s all');
  h.key('4');
  assert.ok(h.nodes.overlay.hidden, 'the overlay closes on send');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu']);
  respond(last(h, isCreate), 201, {id: 'srv-q'});
  const turn = last(h, isTurn);
  assert.equal(turn.body, JSON.stringify({text: 'Tell me more'}), 'sent as a typed turn');
  assert.equal(turn.headers['Content-Type'], 'application/json');
  assert.match(h.nodes.echo.textContent, /Tell me more/, 'echoed while pending');
  assert.equal(h.nodes['session-title'].textContent, 'Tell me more', 'titles an empty chat like typed text');

  // Busy: quick replies wait for the answer.
  respond(turn, 202, {runId: 'r1', state: 'pending'});
  h.key('0');
  assert.ok(h.nodes.overlay.hidden);
  assert.equal(h.status(), 'Klaus is still replying. Back cancels.');

  // A Danish reply switches the list; Up/Down + OK also sends; Back closes without sending.
  firePoll(h);
  respond(last(h, isPoll('srv-q')), 200, {state: 'complete', messages: [
    {role: 'user', text: 'Tell me more'}, {role: 'assistant', text: 'Det er en god idé, og jeg kan hjælpe med det.'}]});
  const sent = h.xhrRequests.filter(isTurn).length;
  h.key('0');
  assert.equal(items(h)[0], '1Ja');
  h.key('Backspace');
  assert.ok(h.nodes.overlay.hidden);
  assert.equal(h.xhrRequests.filter(isTurn).length, sent, 'Back sends nothing');
  h.key('0'); h.key('ArrowDown'); h.key('ArrowUp'); h.key('ArrowUp'); // wraps to 9
  assert.match(h.nodes['overlay-list'].children[8].className, /\bsel\b/);
  h.key('Enter');
  assert.equal(last(h, isTurn).body, JSON.stringify({text: 'Stop, det var det'}));
}

// ── Offline: the quick reply is kept for Retry like typed text ─────────────
{
  const h = harness();
  h.key('0'); h.key('1');
  assert.match(h.status(), /Not connected/);
  assert.equal(JSON.parse(h.storage.get('klaus.sessions.v2'))[0].lastText, 'Yes');
}

// ── Notes screen: quick replies stay with Klaus chats ──────────────────────
{
  const h = harness(new Map(), BRIDGE, {config: {notesUrl: 'http://192.168.1.2:8790', notesToken: 'n'.repeat(40)}});
  h.key('*');
  h.key('0');
  assert.ok(h.nodes.overlay.hidden, 'no quick replies on the Notes screen');
  assert.equal(h.requests.length, 1, '0 there starts a meeting recording instead (nokia-meeting.cjs)');
}

console.log('Nokia quick reply checks passed');
