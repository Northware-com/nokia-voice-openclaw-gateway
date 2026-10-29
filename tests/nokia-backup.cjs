// nokia-backup.cjs — Menu › Backup chats: one versioned JSON snapshot of every stored chat
// plus the display/sound settings, written to the app sandbox when KaiOS provides the
// filesystem API, else an on-screen summary and the console. The export must never contain
// the bridge URL, tokens or any client/server/request id.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';
const TOKEN = 'test-token-' + 'x'.repeat(32);
const norm = o => o === null ? null : JSON.parse(JSON.stringify(o));

// A fake KaiOS core-module loader: window.navigator.appDataPaths + require("fs").
function withFs(h, files) {
  const nav = h.context.navigator;
  h.context.window.navigator = nav; // the app reads navigator through window
  Object.defineProperty(nav, 'appDataPaths', {configurable: true, value: {app: '/app/klaus'}});
  const load = id => (id === 'fs' ? {writeFileSync(path, data, opts) { files.push({path, data: String(data), mode: opts && opts.mode}); return path; }} : undefined);
  h.context.window.require = load;
  h.context.require = load;
  return files;
}
function noConsole(h) {
  const c = {logs: [], log(m) { this.logs.push(String(m)); }};
  h.context.console = c;
  h.context.window.console = c;
  return c;
}
function typedTurn(h, id, text, reply) {
  h.key('SoftLeft'); h.composer.value = text; h.key('Enter');
  const create = h.xhrRequests.filter(r => r.method === 'POST' && r.url.endsWith('/sessions')).at(-1);
  create.req.status = 201; create.req.responseText = JSON.stringify({id}); create.req.onload();
  const turn = h.xhrRequests.filter(r => r.url.endsWith('/turns')).at(-1);
  turn.req.status = 202; turn.req.responseText = JSON.stringify({runId: 'r-' + text, state: 'pending'}); turn.req.onload();
  const pid = Object.keys(h.pollTimers).find(pid => h.pollTimers[pid].active);
  assert.ok(pid, 'a poll must be scheduled'); h.pollTimers[pid].fn();
  const poll = h.xhrRequests.filter(r => r.method === 'GET' && r.url.endsWith('/sessions/' + id)).at(-1);
  poll.req.status = 200; poll.req.responseText = JSON.stringify({state: 'complete', messages: reply}); poll.req.onload();
}
const menuRows = h => h.nodes['overlay-list'].children.filter(c => /\bitem\b/.test(c.className));
function pickBackup(h) {
  h.key('SoftRight');
  assert.equal(menuRows(h).length, 10, 'the menu has ten numbered items');
  for (let i = 0; i < 9; i++) h.key('ArrowDown'); // walk to the last item, "Backup chats"
  assert.equal(menuRows(h)[9].textContent, '10Backup chats', 'Backup is the last menu row (9 stays Keys)');
  assert.ok(/\bsel\b/.test(menuRows(h)[9].className), 'the Backup row is focused');
  h.key('Enter');
}

// ── Pure builder: schema, version, no secrets ──────────────────────────────
{
  const K = harness().context.Klaus;
  const empty = K.buildBackup([], {autoread: true, haptics: false, night: true, large: false});
  assert.equal(empty.version, 1, 'the export schema is versioned');
  assert.equal(empty.app, 'klaus');
  assert.ok(typeof empty.at === 'number');
  assert.deepEqual(norm(empty.chats), []);
  assert.deepEqual(norm(empty.settings), {autoread: true, haptics: false, night: true, large: false});
  const sess = {id: 's1', title: 'Plan', clientId: 'cl-1', serverId: 'srv-1', messages: [
    {role: 'user', text: 'hi'}, {role: 'assistant', text: 'hello'}, {role: 'user', text: 'Voice clip · 0:07', voice: true}],
    pinned: true, named: true, archived: false, updatedAt: 1234};
  const file = K.buildBackup([sess], {autoread: false, haptics: true, night: false, large: true});
  assert.equal(file.chats.length, 1);
  assert.deepEqual(norm(file.chats[0]), {id: 's1', title: 'Plan', pinned: true, named: true, archived: false,
    updatedAt: 1234, messages: [{role: 'user', text: 'hi'}, {role: 'assistant', text: 'hello'},
    {role: 'user', text: 'Voice clip · 0:07', voice: true}]}, 'a chat row is lean: no client/server or request ids');
  const raw = JSON.stringify(file);
  assert.ok(!/cl-1|srv-1|bridge|token|authorization/i.test(raw), 'no ids or credential-shaped words leak into the export');
  assert.equal(K.backupSummary(file), '1 chat, 3 messages');
  assert.equal(K.backupSummary(empty), '0 chats, 0 messages');
}

// ── Menu › Backup writes one mode-600 JSON file when the filesystem API exists ─
{
  const h = harness(new Map(), BRIDGE);
  typedTurn(h, 'srv-b', 'call the plumber', [{role: 'user', text: 'call the plumber'}, {role: 'assistant', text: 'Booked for Friday.'}]);
  h.key('3'); // an empty second chat
  const files = withFs(h, []);
  const console = noConsole(h);
  pickBackup(h);
  assert.equal(files.length, 1, 'exactly one file is written');
  assert.match(files[0].path, /^\/app\/klaus\/klaus-backup-\d{4}-\d{2}-\d{2}\.json$/, 'one dated file in the app sandbox');
  assert.equal(files[0].mode & 0o777, 0o600, 'the backup is written mode 600');
  const parsed = JSON.parse(files[0].data);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.chats.length, 2, 'every stored chat is in the file');
  assert.deepEqual(norm(parsed.chats.map(c => c.messages.length).sort()), [0, 2], 'the seeded chat keeps both turns; the new chat is empty');
  assert.equal(parsed.chats.find(c => c.messages.length === 2).title, 'Call the plumber', 'auto-titled chats keep their title in the backup');
  assert.equal(parsed.chats.find(c => c.messages.length === 2).messages[1].role, 'assistant');
  assert.match(h.status(), /^Backup saved to klaus-backup-\d{4}-\d{2}-\d{2}\.json\. 2 chats, 2 messages$/);
  assert.equal(h.nodes.status.className, 'ok', 'a successful backup is a confirmation');
  assert.equal(console.logs.length, 1);
  assert.match(console.logs[0], /^Klaus backup written: \/app\/klaus\/klaus-backup-.*\.json$/, 'the path is logged too');
  const leaked = files[0].data;
  assert.ok(!leaked.includes(TOKEN), 'the bridge token is never in the export');
  assert.ok(!leaked.includes('bridge.example.test'), 'the bridge URL is never in the export');
  assert.ok(!leaked.includes('srv-b'), 'server ids are never in the export');
  // Repeated same-day backups reuse the same file name (one per day).
  pickBackup(h);
  assert.equal(files.length, 2);
  assert.equal(files[1].path, files[0].path);
}

// ── No filesystem API: on-screen summary + console snapshot, no file ───────
{
  const h = harness(new Map(), BRIDGE);
  typedTurn(h, 'srv-c', 'anything at all', [{role: 'user', text: 'anything at all'}, {role: 'assistant', text: 'Sure, done.'}]);
  const console = noConsole(h);
  pickBackup(h);
  assert.equal(h.status(), 'File saving is not available on this device. 1 chat, 2 messages logged to the console.',
    'without the API the screen still says what was captured');
  assert.ok(!h.nodes.status.hidden, 'the notice is visible');
  assert.equal(console.logs.length, 1, 'the JSON snapshot goes to the console');
  const logged = JSON.parse(console.logs[0]);
  assert.ok(logged.chats.every(c => !(c.id === 'notes')), 'the Notes scratch pad is not a stored chat');
  assert.equal(logged.version, 1, 'the console snapshot is the same versioned schema');
  assert.ok(logged.chats.length === 1 && logged.chats[0].messages.length === 2, 'the console snapshot holds the stored chat');
}
console.log('Nokia local backup (schema, secrets, sandbox write, console fallback) checks passed');