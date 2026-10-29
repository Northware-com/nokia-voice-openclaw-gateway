// nokia-pinned.cjs — pin/unpin chats from the chat list (7): pinned chats sort to the top
// (pinned group in recency order) with a pin badge, and the choice survives restarts.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const rows = h => h.nodes['overlay-list'].children.filter(r => /\bitem\b/.test(r.className) && /\bchat\b/.test(r.className)).map(r => {
  const l1 = r.children[0];
  const t = l1.children.find(c => c.className === 't');
  return {
    cls: r.className,
    badge: l1.children.indexOf(t) > 0 && l1.children[l1.children.indexOf(t) - 1].className === 'pino',
    title: t.textContent,
  };
});
const titles = h => rows(h).map(r => r.title);
const LQ = '\u201c', RQ = '\u201d';

{
  const h = harness();
  h.key('3'); h.key('3'); // chats [1,2,3], c3 open; recency c3 > c2 > c1
  h.key('#'); // list [3, 2, 1], cursor row 1
  assert.deepEqual(titles(h), ['Conversation 3', 'Conversation 2', 'Conversation 1'], 'recency order before pinning');
  assert.ok(rows(h).every(r => !r.badge), 'no pin badges at first');
  // Step to c1 and pin it: it jumps to the top with a badge.
  h.key('ArrowDown'); h.key('ArrowDown'); // cursor row 3 = c1
  h.key('7');
  assert.equal(h.status(), 'Pinned ' + LQ + 'Conversation 1' + RQ + '; stays at the top of the list.');
  assert.equal(h.nodes.status.className, 'ok', 'pinning is a confirmation');
  h.key('#'); // list [1p, 3, 2], cursor = open chat c3 = row 2
  assert.deepEqual(titles(h), ['Conversation 1', 'Conversation 3', 'Conversation 2'], 'the pinned chat jumps above the rest');
  assert.deepEqual(rows(h).map(r => r.badge), [true, false, false], 'only the pinned row carries the P badge');
  // Pin the open chat from its own row: it joins the pinned group at the top (recency).
  h.key('7');
  assert.equal(h.status(), 'Pinned ' + LQ + 'Conversation 3' + RQ + '; stays at the top of the list.');
  h.key('#'); // list [3p, 1p, 2], cursor = c3 = row 1
  assert.deepEqual(titles(h), ['Conversation 3', 'Conversation 1', 'Conversation 2'], 'the pinned group keeps its recency order');
  assert.deepEqual(rows(h).map(r => r.badge), [true, true, false], 'badges follow the pinned group');
  // Unpin the open chat: it falls back into the unpinned block by recency.
  h.key('7');
  assert.equal(h.status(), 'Unpinned ' + LQ + 'Conversation 3' + RQ + '.');
  h.key('#'); // list [1p, 3, 2], cursor = c3 = row 2
  assert.deepEqual(titles(h), ['Conversation 1', 'Conversation 3', 'Conversation 2'], 'the remaining pinned chat stays at the top');
  // Unpin c1 from its row: back to plain recency, no badges.
  h.key('ArrowDown'); h.key('ArrowDown'); // rows [1p,3,2]: cursor row 2 -> 3 -> 1
  h.key('7');
  assert.equal(h.status(), 'Unpinned ' + LQ + 'Conversation 1' + RQ + '.');
  h.key('#');
  assert.deepEqual(titles(h), ['Conversation 3', 'Conversation 2', 'Conversation 1'], 'everything unpinned: plain recency again');
  assert.ok(rows(h).every(r => !r.badge), 'all badges are gone');
  // 7 keeps its old meaning inside a chat: the archive confirm, not pin.
  h.key('Backspace');
  h.key('7');
  assert.equal(h.nodes['overlay-title'].textContent, 'Archive ' + LQ + 'Conversation 3' + RQ + '?', '7 in a chat still opens the archive confirm');
  h.key('SoftLeft');
}
{
  // The pin choice is stored per session and comes back after a restart.
  const storage = new Map();
  const h = harness(storage);
  h.key('3'); // chats [1,2], c2 open; list [2, 1], cursor row 1
  h.key('#');
  h.key('ArrowDown'); // cursor row 2 = c1
  h.key('7');
  assert.match(h.status(), /Pinned/);
  h.key('#'); // list [1p, 2], cursor = c2 = row 2
  h.key('7'); // pin c2: list [2p, 1p]
  assert.match(h.status(), /Pinned/);
  h.key('#'); // cursor = c2 = row 1
  h.key('ArrowDown'); // row 2 = c1
  h.key('7'); // unpin c1: list [2p, 1]
  assert.match(h.status(), /Unpinned/);
  h.key('#');
  const stored = JSON.parse(storage.get('klaus.sessions.v2'));
  assert.deepEqual(stored.map(sx => sx.pinned), [false, true], 'pinned is stored per session');
  const again = harness(storage);
  again.key('#');
  assert.equal(again.nodes['overlay-list'].children.filter(r => /\bpinned\b/.test(r.className)).length, 1, 'the badge survives a restart');
  assert.equal(titles(again)[0], 'Conversation 2', 'the pinned chat is at the top on relaunch');
  assert.equal(rows(again)[0].badge, true);
}
console.log('Nokia chat pinning (order, badge, 7 key, persistence) checks passed');