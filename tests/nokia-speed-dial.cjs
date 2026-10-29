// nokia-speed-dial.cjs — chat list speed dial: 1 Notes, 2 new Klaus chat recording, 3 last chat.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const NOTES = {notesUrl: 'http://192.168.1.2:8790', notesToken: 'n'.repeat(40)};
const chips = h => {
  const strip = h.nodes['overlay-list'].children.find(c => c.className === 'dial');
  return strip ? strip.children.map(c => (/\boff\b/.test(c.className) ? '-' : '+') + c.textContent) : [];
};
const index = h => h.nodes['session-index'].textContent;

// ── Pure key map ───────────────────────────────────────────────────────────
{
  const K = harness().context.Klaus;
  for (const d of '1234') assert.equal(K.mapKey('sessions', d, true), 'dial', `chat list ${d}`);
  for (const d of '5 6 8 9 0 *'.split(' ')) assert.equal(K.mapKey('sessions', d, true), 'none', `chat list ${d} is unused`);
  assert.equal(K.mapKey('sessions', '7', true), 'pin', 'chat list 7 pins the chat under the cursor');
  assert.equal(K.mapKey('sessions', 'ArrowUp', true), 'up');
  assert.equal(K.mapKey('sessions', 'Enter', true), 'select');
  assert.equal(K.mapKey('menu', '1', true), 'pick', 'menu digits pick the numbered item, not speed dial');
  assert.deepEqual(Array.from(K.SPEED_DIAL), ['Notes', 'Klaus', 'Last', 'Today']);
}

// ── Chips: dimmed when the target does not exist ───────────────────────────
{
  const h = harness();
  h.key('#');
  assert.deepEqual(chips(h), ['-1Notes', '+2Klaus', '-3Last', '-4Today'], 'no Notes in this build, no other chat yet');
  h.key('1');
  assert.equal(h.status(), 'Notes are not configured in this build.');
  assert.ok(!h.nodes.overlay.hidden, 'the list stays open after a dimmed chip');
  h.key('3');
  assert.equal(h.status(), 'No other chat yet. 2 starts one.');
  h.key('Backspace');
  const n = harness(new Map(), 'https://bridge.example.test/nokia/v1', {config: NOTES});
  n.key('3'); n.key('#');
  assert.deepEqual(chips(n), ['+1Notes', '+2Klaus', '+3Last', '+4Today']);
}

// ── 1 opens Notes ──────────────────────────────────────────────────────────
{
  const h = harness(new Map(), 'https://bridge.example.test/nokia/v1', {config: NOTES});
  h.key('#'); h.key('1');
  assert.ok(h.nodes.overlay.hidden);
  assert.equal(h.nodes['session-index'].textContent, '✎', 'Notes screen');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Chat']);
}

// ── 2 starts a new Klaus chat with the recorder running ────────────────────
{
  const h = harness();
  h.key('#'); h.key('2');
  assert.ok(h.nodes.overlay.hidden);
  assert.equal(index(h), '2/2', 'a new chat');
  assert.equal(h.nodes['session-title'].textContent, 'Conversation 2');
  assert.equal(h.requests.length, 1, 'the microphone is requested at once');
  assert.match(h.banner(), /^● Recording/);
  assert.deepEqual(h.softkeys(), ['Delete', 'Pause', 'Send']);
  h.grant();
  assert.equal(h.recorders.length, 1);
}

// ── 3 jumps to the previous chat and back ──────────────────────────────────
{
  const h = harness();
  h.key('3'); h.key('3'); // chats 1-3, on 3
  h.key('4');             // on 2; previous is 3
  h.key('#'); h.key('3');
  assert.equal(index(h), '3/3');
  h.key('#'); h.key('3');
  assert.equal(index(h), '2/3', '3 toggles between the last two chats');
  // Archived chats are skipped.
  h.key('#'); h.key('3'); // on 3, previous 2
  h.key('7'); h.key('Enter'); // archive 3 → lands on another chat
  const now = index(h);
  h.key('#'); h.key('3');
  assert.notEqual(h.nodes['session-title'].textContent, 'Conversation 3', 'never jumps to an archived chat');
  assert.notEqual(index(h), now);
}

// ── 2 at the chat cap creates nothing and records nothing ──────────────────
{
  const many = Array.from({length: 128}, (_, i) => ({id: 's' + i, title: 'Conversation ' + (i + 1)}));
  const h = harness(new Map([['klaus.sessions.v2', JSON.stringify(many)]]));
  h.key('#');
  assert.deepEqual(chips(h)[1], '-2Klaus');
  h.key('2');
  assert.match(h.status(), /Maximum 128 chats/);
  assert.equal(h.requests.length, 0, 'no recording without a chat to hold it');
}

console.log('Nokia chat list speed dial checks passed');
