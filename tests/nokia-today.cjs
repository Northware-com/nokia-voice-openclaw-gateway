// nokia-today.cjs — Today screen: GET /today on the notes service (token-auth, read-only)
// lists reminders due today and the latest inbox items; the phone opens it with # then 4,
// caches the last answer and says how fresh it is. Run after npm run build.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createNotesServer} = require('../configs/nokia-notes/dist/notes.js');
const {readToday, frontMatter} = require('../configs/nokia-notes/dist/today.js');
const {harness} = require('./nokia-audio.cjs');

const NOW = new Date(2026, 9, 29, 14, 5);
const iso = (d, h, m = 0) => {
  const t = new Date(2026, 9, d, h, m);
  const off = -t.getTimezoneOffset(), pad = n => String(n).padStart(2, '0');
  return `2026-10-${pad(d)}T${pad(h)}:${pad(m)}:00${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
};
const note = (type, extra, summary) => ['---', `type: ${type}`, ...extra, `summary: ${JSON.stringify(summary)}`, '---', '', '# x', ''].join('\n');

function inbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nokia-today-'));
  const w = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  w('Nokia-Reminder-2026-10-29-080000.md', note('reminder', ['status: open', `created: ${iso(29, 8)}`, `due: ${iso(29, 15)}`], 'Call mum.'));
  w('Nokia-Reminder-2026-10-29-080100.md', note('reminder', ['status: open', `created: ${iso(29, 8, 1)}`, `due: ${iso(29, 9, 30)}`], 'Take the bins out'));
  w('Nokia-Reminder-2026-10-28-080000.md', note('reminder', ['status: open', `created: ${iso(28, 8)}`, `due: ${iso(28, 18)}`], 'Pay the plumber'));
  w('Nokia-Reminder-2026-10-27-080000.md', note('reminder', ['status: done', `created: ${iso(27, 8)}`, `due: ${iso(27, 18)}`], 'Done already'));
  w('Nokia-Reminder-2026-10-29-090000.md', note('reminder', ['status: open', `created: ${iso(29, 9)}`, `due: ${iso(30, 9)}`], 'Tomorrow thing'));
  w('Nokia-Reminder-2026-10-29-100000.md', note('reminder', ['status: open', `created: ${iso(29, 10)}`], 'Buy milk'));
  w('Nokia-Task-2026-10-29-120000.md', note('task', ['status: open', `created: ${iso(29, 12)}`, 'tags: [task, nokia]'], 'Renew the passport'));
  w('Nokia-Idea-2026-10-29-130000.md', note('idea', ['status: inbox', `created: ${iso(29, 13)}`], 'Pub quiz app'));
  w('Nokia-Meeting-2026-10-29-110000.md', note('meeting', ['status: inbox', `created: ${iso(29, 11)}`], 'Bar menu review'));
  w('Nokia-Note-2026-10-20-070000.md', note('note', ['status: inbox', `created: ${iso(20, 7)}`], 'Old note'));
  w('Someone-Else.md', note('task', [], 'Not from the phone'));
  w('Nokia-Note-broken.md', 'no front matter');
  return dir;
}

// ── Reading the inbox ──────────────────────────────────────────────────────
{
  assert.deepEqual(frontMatter('---\ntype: task\nsummary: "a: \\"b\\""\n---\nbody'), {type: 'task', summary: 'a: "b"'});
  const dir = inbox();
  const t = readToday(dir, NOW);
  assert.equal(t.date, '2026-10-29');
  assert.deepEqual(t.reminders.map(r => [r.text, r.overdue]), [['Pay the plumber', true], ['Take the bins out', false], ['Call mum.', false]],
    'today in time order, open overdue first; done and future ones are left out');
  assert.equal(t.undated, 1);
  assert.deepEqual(t.latest.map(i => [i.kind, i.summary]),
    [['idea', 'Pub quiz app'], ['task', 'Renew the passport'], ['meeting', 'Bar menu review'], ['note', 'Old note']],
    'newest first across kinds; reminders and foreign files are not listed');
  assert.equal(t.calendar, null);
  assert.equal(t.mail, null);
  fs.rmSync(dir, {recursive: true, force: true});
}

// ── The endpoint needs the token and is read-only ──────────────────────────
async function endpoint() {
  const dir = inbox();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'nokia-today-state-'));
  const server = createNotesServer({token: 't'.repeat(40), inboxDir: dir, stateFile: path.join(state, 's.json'), whisperUrl: 'http://127.0.0.1:9'}, () => NOW);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const before = fs.readdirSync(dir).sort();
  let r = await fetch(base + '/today', {headers: {Authorization: 'Bearer ' + 'x'.repeat(40)}});
  assert.equal(r.status, 401);
  r = await fetch(base + '/today', {headers: {Authorization: 'Bearer ' + 't'.repeat(40)}});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json();
  assert.equal(body.reminders.length, 3);
  assert.equal(body.latest[0].summary, 'Pub quiz app');
  r = await fetch(base + '/today', {method: 'POST', headers: {Authorization: 'Bearer ' + 't'.repeat(40)}});
  assert.equal(r.status, 404, 'only GET');
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'reading changes nothing');
  server.close();
  fs.rmSync(dir, {recursive: true, force: true});
  fs.rmSync(state, {recursive: true, force: true});
  return body;
}

// ── Phone: # then 4 opens Today, cached, refreshable ───────────────────────
const BRIDGE = 'https://bridge.example.test/nokia/v1';
const NOTES = 'http://192.168.1.20:8790';
const config = {notesUrl: NOTES, notesToken: 'notes-token'};
const rows = h => h.nodes['overlay-list'].children.map(c => c.className + '|' + c.textContent);
const todayReqs = h => h.xhrRequests.filter(r => r.url === NOTES + '/today');
function respond(req, status, body) { req.req.status = status; req.req.responseText = JSON.stringify(body); req.req.onload(); }

function phone(body) {
  const K = harness().context.Klaus;
  assert.equal(K.mapKey('today', 'Enter', true), 'select');
  assert.equal(K.mapKey('today', 'Backspace', true), 'close');
  assert.equal(K.mapKey('today', '5', true), 'none');
  assert.deepEqual(Array.from(K.softkeysFor('today', '')), ['Close', 'Update', '']);
  assert.equal(K.validateToday({date: 1}), null);
  assert.equal(K.validateToday({date: 'x', reminders: [{text: 5}], latest: [{summary: 'a', kind: '<script>'}]}).latest[0].kind, 'note');

  const storage = new Map();
  const h = harness(storage, BRIDGE, {config});
  h.clock.t = NOW.getTime();
  h.key('#'); h.key('4');
  assert.equal(h.nodes['overlay-title'].textContent, 'Today · Thu 29 Oct');
  assert.deepEqual(h.softkeys(), ['Close', 'Update', '']);
  assert.equal(todayReqs(h).length, 1);
  assert.equal(todayReqs(h)[0].method, 'GET');
  assert.equal(todayReqs(h)[0].headers.Authorization, 'Bearer notes-token', 'the notes token, never the bridge token');
  assert.match(rows(h)[0], /Loading from Plato/);
  respond(todayReqs(h)[0], 200, body);
  const shown = rows(h);
  assert.equal(shown[0], 'fresh|Updated just now');
  assert.equal(shown[1], 'sec|Reminders');
  assert.deepEqual(shown.slice(2, 5), ['trow late|YdayPay the plumber', 'trow past|9:30Take the bins out', 'trow|15:00Call mum.']);
  assert.equal(shown[5], 'trow none|+1 without a time');
  assert.equal(shown[6], "sec|Latest in Plato's inbox");
  assert.equal(shown[7], 'trow k-idea|13:00IdeaPub quiz app');
  assert.equal(shown.at(-2), 'sec|Calendar & mail');
  assert.equal(shown.at(-1), 'trow none|Not connected yet');

  // OK refreshes; a failure keeps the last list and says so.
  h.clock.t += 10 * 60000;
  h.key('Enter');
  assert.equal(todayReqs(h).length, 2);
  assert.equal(rows(h)[0], 'fresh|Updating…');
  todayReqs(h)[1].req.onerror();
  assert.equal(rows(h)[0], 'fresh warn|Offline · 10m ago · OK retries');
  assert.ok(rows(h).includes('trow|15:00Call mum.'), 'the cached list stays');
  h.key('ArrowDown'); h.key('ArrowUp');
  assert.ok(!h.nodes.overlay.hidden, 'Up/Down scroll, they do not close');
  h.key('Backspace');
  assert.ok(h.nodes.overlay.hidden);
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu']);

  // After a restart the cached list shows at once while the update runs.
  const again = harness(storage, BRIDGE, {config});
  again.clock.t = NOW.getTime() + 60 * 60000;
  again.key('#'); again.key('4');
  assert.equal(rows(again)[0], 'fresh|Updating…');
  assert.ok(rows(again).includes('trow past|15:00Call mum.'), 'cached, and 15:00 has passed by now');
  respond(todayReqs(again)[0], 500, {error: 'internal'});
  assert.match(rows(again)[0], /^fresh warn\|Offline · 14:05/);

  // Without the notes service the chip is dimmed and 4 explains itself.
  const plain = harness(new Map(), BRIDGE);
  plain.key('#'); plain.key('4');
  assert.match(plain.status(), /Today needs the notes service/);
  assert.equal(todayReqs(plain).length, 0);
}

endpoint().then(body => {
  phone(body);
  console.log('Nokia Today screen (endpoint, reminders, latest items, cache, refresh) checks passed');
}).catch(e => { console.error(e); process.exit(1); });
