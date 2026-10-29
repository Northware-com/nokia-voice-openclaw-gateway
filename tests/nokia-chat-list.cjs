// nokia-chat-list.cjs — chat list: automatic titles, previews, times, state and recency order.
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
function typeAndSend(h, text) {
  h.key('SoftLeft'); h.composer.value = text; h.key('Enter');
}
const rows = h => h.nodes['overlay-list'].children.filter(row => /\bitem\b/.test(row.className)).map(row => ({
  cls: row.className, title: row.children[0].children[0].textContent,
  time: row.children[0].children[1].textContent, preview: row.children[1].textContent,
}));

// ── Pure helpers ───────────────────────────────────────────────────────────
{
  const K = harness().context.Klaus;
  assert.equal(K.isDefaultTitle('Conversation 12'), true);
  assert.equal(K.isDefaultTitle('Shopping'), false);
  assert.equal(K.clipLine('  short   text ', 20), 'short text', 'whitespace collapses');
  assert.equal(K.clipLine('what is on the shopping list for tonight', 20), 'what is on the…', 'cuts at a word boundary');
  assert.equal(K.clipLine('abcdefghijklmnopqrstuvwxyz', 10), 'abcdefghi…', 'long words are cut hard');
  assert.equal(K.autoTitle([]), '');
  assert.equal(K.autoTitle([{role: 'user', text: "what's on my shopping list for the weekend?"}]), "What's on my shopping…");
  assert.equal(K.autoTitle([{role: 'assistant', text: '**Milk** and eggs'}, {role: 'user', text: 'thanks'}]), 'Thanks',
    'the first thing you said wins over the reply');
  assert.equal(K.autoTitle([{role: 'user', text: 'Voice clip · 0:07', voice: true}, {role: 'assistant', text: '"Sure, the plan is…"'}]),
    'Sure, the plan is…', 'voice placeholders are skipped; the reply names the chat');
  assert.equal(K.autoTitle([{role: 'user', text: '   '}]), '');
}
{
  const K = harness().context.Klaus;
  const now = new Date(2026, 9, 29, 14, 5).getTime(); // Thu 29 Oct 2026, 14:05 local
  assert.equal(K.relTime(0, now), '', 'unknown time stays blank');
  assert.equal(K.relTime(now - 30000, now), 'now');
  assert.equal(K.relTime(now - 5 * 60000, now), '5m');
  assert.equal(K.relTime(new Date(2026, 9, 29, 9, 7).getTime(), now), '9:07', 'earlier today shows the clock');
  assert.equal(K.relTime(new Date(2026, 9, 28, 23, 0).getTime(), now), 'Yday');
  assert.equal(K.relTime(new Date(2026, 9, 26, 12, 0).getTime(), now), 'Mon', 'this week shows the weekday');
  assert.equal(K.relTime(new Date(2026, 9, 12, 12, 0).getTime(), now), '12 Oct');
}
{
  const K = harness().context.Klaus;
  const msgs = [{role: 'user', text: 'list?'}, {role: 'assistant', text: 'Milk,\n eggs and coffee.'}];
  const row = (busy, failed, queued, m = msgs) => K.sessionRow('Shop', m, busy, failed, queued, 1000, 1000 + 120000);
  assert.deepEqual({...row(false, false, false)}, {kind: '', title: 'Shop', time: '2m', preview: 'Milk, eggs and coffee.', pinned: false});
  assert.equal(row(false, false, false, msgs.slice(0, 1)).preview, 'You: list?', 'your own last turn is prefixed');
  assert.equal(row(false, false, false, []).preview, 'No messages yet');
  assert.deepEqual({...row(true, false, false)}, {kind: 'busy', title: 'Shop', time: '2m', preview: 'Klaus is thinking…', pinned: false});
  assert.equal(row(false, true, true).kind, 'failed', 'failure outranks the queue');
  assert.equal(row(false, true, false).preview, 'Failed · open, Menu › Retry');
  assert.equal(row(false, false, true).preview, 'Queued · sends when online');
}

// ── Automatic title from a typed turn, the reply and the chat list row ──────
{
  const h = harness(new Map(), BRIDGE);
  typeAndSend(h, 'what is on the shopping list for tonight');
  assert.equal(h.nodes['session-title'].textContent, 'What is on the shopping…', 'typed text titles the chat at once');
  respond(last(h, isCreate), 201, {id: 'srv-1'});
  respond(last(h, isTurn), 202, {runId: 'r1', state: 'pending'});
  h.key('#');
  assert.deepEqual(rows(h)[0], {cls: 'item chat busy sel', title: 'What is on the shopping…', time: 'now', preview: 'Klaus is thinking…'});
  h.key('Backspace');
  firePoll(h);
  respond(last(h, isPoll('srv-1')), 200, {state: 'complete', messages: [
    {role: 'user', text: 'what is on the shopping list for tonight'}, {role: 'assistant', text: 'Milk, eggs and coffee.'}]});
  h.clock.t += 3 * 60000 + 5000;
  h.key('#');
  assert.deepEqual(rows(h)[0], {cls: 'item chat sel', title: 'What is on the shopping…', time: '3m', preview: 'Milk, eggs and coffee.'});
  // Renaming by hand stops automatic titles, and both survive a restart.
  h.key('Backspace'); h.key('SoftRight'); h.key('ArrowDown'); h.key('Enter');
  h.composer.value = 'Groceries'; h.key('Enter');
  const reload = harness(h.storage, BRIDGE);
  assert.equal(reload.nodes['session-title'].textContent, 'Groceries');
  const stored = JSON.parse(h.storage.get('klaus.sessions.v2'))[0];
  assert.equal(stored.named, true);
  assert.ok(stored.updatedAt > 0, 'activity time persists');
}

// ── Legacy chats: default names are retitled from their content, custom names kept ──
{
  const legacy = [
    {id: 'a', title: 'Conversation 1', messages: [{role: 'user', text: 'plan my week'}, {role: 'assistant', text: 'Sure.'}]},
    {id: 'b', title: 'Budget', messages: [{role: 'user', text: 'numbers please'}]},
    {id: 'c', title: 'Conversation 3', messages: []},
  ];
  const h = harness(new Map([['klaus.sessions.v2', JSON.stringify(legacy)]]));
  assert.equal(h.nodes['session-title'].textContent, 'Plan my week');
  h.key('#');
  const titles = rows(h).map(r => r.title);
  assert.deepEqual(titles.sort(), ['Budget', 'Conversation 3', 'Plan my week'], 'custom and empty chats keep their names');
  assert.equal(rows(h)[0].title, 'Plan my week', 'the open chat is listed first');
  assert.equal(rows(h).find(r => r.title === 'Conversation 3').preview, 'No messages yet');
}

// ── Recency: activity in another chat moves it up; archived chats stay out ──
{
  const h = harness();
  h.key('3'); h.key('3'); // chats 1, 2, 3; 3 is open
  h.key('#');
  assert.deepEqual(rows(h).map(r => r.title), ['Conversation 3', 'Conversation 2', 'Conversation 1']);
  h.key('ArrowDown'); h.key('ArrowDown'); h.key('Enter'); // open chat 1
  h.key('7'); h.key('Enter'); // archive it
  h.key('#');
  assert.deepEqual(rows(h).map(r => r.title).sort(), ['Conversation 2', 'Conversation 3']);
  assert.equal(h.nodes['overlay-list'].children.filter(r => /\bsel\b/.test(r.className)).length, 1, 'exactly one row selected');
}

console.log('Nokia chat list (auto titles, previews, times, recency) checks passed');
