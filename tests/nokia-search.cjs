// nokia-search.cjs — local chat search: case- and accent-insensitive match over titles and
// stored message text, one hit per chat, OK opens the chat with the first match focused.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');
// The Klaus namespace runs in its own vm context; normalise prototypes so deepStrictEqual holds.
const norm = o => o === null ? null : JSON.parse(JSON.stringify(o));
const titles = a => norm(a.map(h => h.title));

const BRIDGE = 'https://bridge.example.test/nokia/v1';

// ── Pure helpers: folding, snippet, order, caps, archived ──────────────────
{
  const K = harness().context.Klaus;
  const fold = s => K.searchFold(s).text;
  assert.equal(fold('PlOVERing'), 'plovering', 'å/ø fold to plain letters');
  assert.equal(fold('Renovéring'), 'renovering');
  assert.equal(fold('Château'), 'chateau');
  assert.equal(fold('ßAA'), 'ssaa');
  assert.equal(K.searchFold('Aa').to.length, 'Aa'.length);
  const chats = [
    {title: 'Shopping', archived: false, updatedAt: 300, messages: [{role: 'user', text: "what's on the shopping list?"}, {role: 'assistant', text: 'Milk, eggs and coffee.'}]},
    {title: 'Budget', archived: false, updatedAt: 200, messages: [{role: 'assistant', text: 'About 3,400 kr after rent and the car.'}]},
    {title: 'Repairs', archived: false, updatedAt: 100, messages: [{role: 'user', text: 'call the plöver after 15:00'}]},
    {title: 'Rømø trip', archived: false, updatedAt: 90, messages: [{role: 'assistant', text: 'Skagen or a night in Ribe.'}]},
    {title: 'Storage only', archived: true, updatedAt: 999, messages: [{role: 'assistant', text: 'archived plöver talk'}]},
  ];
  // Case-insensitive, title hits ranked first.
  const byTitle = K.searchSessions(chats, 'repair');
  assert.deepEqual(titles(byTitle), ['Repairs'], 'one title hit');
  assert.equal(byTitle[0].inTitle, true);
  // Accent-insensitive inside message text.
  const byAcc = K.searchSessions(chats, 'plover');
  assert.deepEqual(titles(byAcc), ['Repairs'], 'ö folded so the old spelling finds it');
  assert.match(byAcc[0].snippet, /plöver/, 'the snippet quotes the original letters');
  const byO = K.searchSessions(chats, 'romo');
  assert.deepEqual(titles(byO), ['Rømø trip'], 'ø→o both ways');
  // Case-insensitive title search.
  assert.deepEqual(titles(K.searchSessions(chats, 'SHOPPING')), ['Shopping']);
  // Snippet window centres the first hit.
  const hit = K.searchSessions(chats, 'rent')[0];
  assert.match(hit.snippet, /….{0,20}rent.{0,10}…|rent/, 'snippets keep context around the match');
  // A title hit reports the title; a text hit reports the matching message.
  assert.equal(K.searchSessions(chats, 'shopping').slice(1).length, 0, 'a title hit suppresses the text hit for the same chat');
  // Archived chats stay out, even on a perfect match.
  assert.deepEqual(norm(K.searchSessions(chats, 'storage')), []);
  // No match, empty query.
  assert.deepEqual(norm(K.searchSessions(chats, 'zzz')), []);
  assert.deepEqual(norm(K.searchSessions(chats, '  ')), [], 'blank query is not a search');
  // Recency order among text hits; capped at 12.
  const many = [];
  for (let i = 0; i < 20; i++) many.push({title: 'Chat ' + i, archived: false, updatedAt: i, messages: [{role: 'assistant', text: 'needle in the map'}]});
  const all = K.searchSessions(many, 'needle');
  assert.equal(all.length, 12, 'results are capped so the screen fits');
  assert.equal(all[0].title, 'Chat 19', 'newest match first');
  // searchMessageIndex finds the first matching message.
  const msgs = chats[0].messages;
  assert.equal(K.searchMessageIndex(msgs, 'shopping list'), 0);
  assert.equal(K.searchMessageIndex(msgs, 'eggs'), 1);
  assert.equal(K.searchMessageIndex(msgs, 'nope'), -1);
  // Map correctness: a folded char expanding to two letters (æ) still points to the original.
  const fa = K.searchFold('fæde');
  assert.deepEqual(norm(fa.to), [0, 1, 1, 2, 3], 'æ expands but the map points back to the original letters');
}

// ── End to end: chat list, right softkey types, OK opens the chat focused ──
const listRows = h => h.nodes['overlay-list'].children.filter(r => /\bsres\b/.test(r.className));
function seedChats(h) {
  h.key('3'); // chat 2
  h.key('SoftLeft'); h.composer.value = 'call the plöver'; h.key('Enter');
  const create = h.xhrRequests.filter(r => r.method === 'POST' && r.url.endsWith('/sessions')).at(-1);
  create.req.status = 201; create.req.responseText = JSON.stringify({id: 'srv-2'}); create.req.onload();
  const turn = h.xhrRequests.filter(r => r.url.endsWith('/turns')).at(-1);
  turn.req.status = 202; turn.req.responseText = JSON.stringify({runId: 'r2', state: 'pending'}); turn.req.onload();
  const id = Object.keys(h.pollTimers).find(id => h.pollTimers[id].active);
  assert.ok(id, 'a poll must be scheduled'); h.pollTimers[id].fn();
  const poll = h.xhrRequests.filter(r => r.method === 'GET' && r.url.endsWith('/sessions/srv-2')).at(-1);
  poll.req.status = 200;
  poll.req.responseText = JSON.stringify({state: 'complete', messages: [
    {role: 'user', text: 'call the plöver'}, {role: 'assistant', text: 'Booked for Friday.'}]});
  poll.req.onload();
}
{
  const h = harness(new Map(), BRIDGE);
  seedChats(h);
  h.key('#');
  assert.deepEqual(h.softkeys(), ['Close', 'Open', 'Search'], 'the chat list offers search on the right key');
  h.key('SoftRight');
  assert.deepEqual(h.softkeys(), ['Clear', 'Open', ''], 'search mode takes the softkeys over');
  assert.equal(h.nodes['overlay-title'].textContent, 'Search chats');
  assert.ok(h.nodes['overlay-list'].children.some(c => /\bsquery\b/.test(c.className)), 'a query row sits at the top');
  // Type a query; results appear live.
  for (const ch of 'plöver') h.key(ch);
  assert.equal(h.nodes['overlay-list'].children[0].textContent, '> plöver');
  const res = listRows(h);
  assert.equal(res.length, 1);
  assert.equal(res[0].children[0].children[0].textContent, 'Call the plöver', 'the auto-title chat is the hit');
  assert.equal(res[0].children[1].textContent, 'Title', 'a title hit says so and skips the text match');
  // A message-only query quotes the matched message with its original letters.
  h.key('SoftLeft');
  for (const ch of 'booked') h.key(ch);
  const res2 = listRows(h);
  assert.equal(res2.length, 1);
  assert.match(res2[0].children[1].textContent, /Booked for Friday/, 'the snippet quotes the matched message');
  // Accent-insensitive: the old spelling finds the same chat, from the other end too.
  h.key('SoftLeft');
  for (const ch of 'plover') h.key(ch);
  assert.equal(listRows(h).length, 1, 'plover matches plöver');
  // SoftLeft while there is text clears the query.
  h.key('SoftLeft');
  assert.equal(h.nodes['overlay-list'].children[0].textContent, '> type to search…');
  // No match states.
  h.key('z'); h.key('z'); h.key('z');
  assert.ok(h.nodes['overlay-list'].children.some(c => /\bsnote\b/.test(c.className) && /No match/.test(c.textContent)));
  // Backspace on an empty query closes search and returns to the chats.
  for (let i = 0; i < 3; i++) h.key('Backspace');
  h.key('Backspace');
  assert.ok(h.nodes.overlay.hidden, 'empty-query Backspace closes search');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu'], 'idle keys are back');
}
{
  // OK opens the hit chat and focuses the first matching message.
  const h = harness(new Map(), BRIDGE);
  seedChats(h);
  h.key('ArrowLeft');
  assert.equal(h.nodes['session-title'].textContent, 'Conversation 1', 'back in the empty first chat');
  h.key('#'); h.key('SoftRight');
  for (const ch of 'booked') h.key(ch);
  assert.equal(listRows(h).length, 1, 'a reply-text hit is found');
  h.key('Enter');
  assert.equal(h.nodes['session-title'].textContent, 'Call the plöver', 'OK switched to the hit chat');
  const rows = h.nodes.transcript.children;
  const selected = rows.filter(r => /\bsel\b/.test(r.className));
  assert.equal(selected.length, 1, 'exactly one message is focused');
  assert.equal(rows.indexOf(selected[0]), 1, 'the first match (the reply) is the focused one');
  // Up/Down move over results before opening.
  const h2 = harness(new Map(), BRIDGE);
  seedChats(h2);
  h2.key('#'); h2.key('SoftRight');
  for (const ch of 'the') h2.key(ch);
  h2.key('ArrowDown');
  assert.equal(h2.nodes['overlay-list'].children.filter(r => /\bsres\b/.test(r.className)).filter(r => /\bsel\b/.test(r.className)).length, 1);
}
console.log('Nokia chat search (fold, snippets, order, open-and-focus) checks passed');