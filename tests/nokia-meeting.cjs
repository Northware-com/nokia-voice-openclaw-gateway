// nokia-meeting.cjs — meeting mode: the phone records one-minute Ogg segments and queues each as
// it ends; the notes service stores them privately, transcribes them after "finish" and writes
// one meeting note (local extractive summary, decisions, action items, transcript).
// Run after npm run build.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {digest, sentences} = require('../configs/nokia-notes/dist/meeting.js');
const {createNotesServer} = require('../configs/nokia-notes/dist/notes.js');
const {harness} = require('./nokia-audio.cjs');

// ── Local summary: decisions and action items by cue words, EN and DA ──────
{
  const text = 'Okay. We looked at the launch budget for the Copenhagen pop-up bar. The launch budget is tight but the pop-up bar ' +
    'can open in March. We decided to open the pop-up bar on the first of March. Anna will send the budget to the bank by Friday. ' +
    'Right. Vi har besluttet at bruge den gamle logo. Mikkel skal ringe til udlejeren i morgen. The weather was nice.';
  assert.equal(sentences(text).length, 9);
  const d = digest(text);
  assert.deepEqual(d.decisions, ['We decided to open the pop-up bar on the first of March.', 'Vi har besluttet at bruge den gamle logo.']);
  assert.deepEqual(d.actions, ['Anna will send the budget to the bank by Friday.', 'Mikkel skal ringe til udlejeren i morgen.']);
  assert.ok(d.summary.length <= 3 && d.summary.length >= 1);
  assert.ok(d.summary.every(s => !/^(Okay|Right)\.$/.test(s)), 'fragments never make the summary');
  assert.ok(d.summary.some(s => /pop-up bar/.test(s)), 'the summary favours what the meeting kept coming back to');
  assert.ok(d.keywords.includes('pop-up') || d.keywords.includes('bar'));
  assert.deepEqual(digest('').summary, []);
}

const TOKEN = 'm'.repeat(40);
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const ogg = tag => Buffer.concat([Buffer.from('OggS'), Buffer.from(tag)]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nokia-meeting-'));
  const inboxDir = path.join(dir, 'inbox');
  fs.mkdirSync(inboxDir);
  const meetingsDir = path.join(dir, 'meetings');
  // Fake WhisperX: the transcript names the segment it was sent; "down" answers 500.
  let down = false, calls = 0;
  const lines = {
    'one': 'We reviewed the bar menu for the Copenhagen opening. The bar menu needs fewer cocktails.',
    'two': 'We decided to keep the menu to eight cocktails. Anna will print the bar menu by Friday.',
    'three': '',
  };
  const whisper = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      calls++;
      if (down) { res.writeHead(500); res.end('{}'); return; }
      const body = Buffer.concat(parts).toString('latin1');
      const tag = Object.keys(lines).find(k => body.includes('OggS' + k + '\r\n'));
      if (lines[tag] === null) { res.writeHead(200); res.end('{}'); return; } // no text: transcriber_error
      res.writeHead(200); res.end(JSON.stringify({text: lines[tag] ?? 'unknown', language: 'en', duration_s: 60}));
    });
  });
  const whisperUrl = `http://127.0.0.1:${await listen(whisper)}`;
  const started = new Date(2026, 9, 29, 14, 0, 0);
  const cfg = {token: TOKEN, inboxDir, stateFile: path.join(dir, 'state.json'), whisperUrl, meetingRetryMs: 30};
  let server = createNotesServer(cfg, () => new Date(2026, 9, 29, 15, 0, 0));
  let base = `http://127.0.0.1:${await listen(server)}`;
  const post = (url, type, body, id, token = TOKEN) => fetch(base + url, {method: 'POST', body,
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': type, 'X-Request-Id': id}}).then(async r => ({status: r.status, body: await r.json()}));
  const seg = (n, tag) => post(`/meetings/${MID}/segments/${n}`, 'audio/ogg', ogg(tag), uuid(100 + n));
  const finish = (body, id = uuid(200)) => post(`/meetings/${MID}/finish`, 'application/json', JSON.stringify(body), id);
  const finishBody = {segments: 3, startedAt: started.getTime(), durationMs: 150000, segmentMs: 60000};

  assert.equal((await post(`/meetings/${MID}/segments/1`, 'audio/ogg', ogg('one'), uuid(1), 'x'.repeat(40))).status, 401);
  assert.equal((await post(`/meetings/${MID}/segments/0`, 'audio/ogg', ogg('one'), uuid(1))).status, 404);
  assert.equal((await post(`/meetings/not-a-uuid/finish`, 'application/json', '{}', uuid(1))).status, 404);
  assert.equal((await post(`/meetings/${MID}/segments/1`, 'application/json', '{}', uuid(1))).status, 415);
  assert.equal((await post(`/meetings/${MID}/segments/1`, 'audio/ogg', Buffer.from('nope'), uuid(1))).status, 400);

  let r = await seg(1, 'one');
  assert.deepEqual(r, {status: 201, body: {stored: 1}});
  assert.equal((await seg(1, 'one')).status, 200, 'a resent segment is stored once');
  assert.equal((await seg(2, 'two')).status, 201);
  // Segments wait privately until the meeting is finished; nothing is transcribed yet.
  const mdir = path.join(meetingsDir, MID);
  assert.equal(fs.statSync(mdir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(mdir, 'seg-0001.ogg')).mode & 0o777, 0o600);
  assert.equal(calls, 0);

  // Transcriber down at finish: accepted, retried, and the transcripts already made are kept.
  assert.equal((await finish({segments: 'x'})).status, 400);
  assert.equal((await seg(3, 'three')).status, 201);
  down = true;
  r = await finish(finishBody);
  assert.equal(r.status, 202);
  assert.equal(r.body.kind, 'meeting');
  assert.equal(r.body.label, 'Meeting saved');
  assert.equal((await finish(finishBody)).status, 202, 'a resent finish while processing is fine');
  await server.meetingsIdle();
  assert.equal(fs.readdirSync(inboxDir).length, 0, 'no note while the transcriber is down');
  assert.ok(fs.existsSync(mdir), 'audio is kept for the retry');
  down = false;
  await sleep(80);
  await server.meetingsIdle();

  const files = fs.readdirSync(inboxDir);
  assert.deepEqual(files, ['Nokia-Meeting-2026-10-29-140000.md'], 'named after the meeting start');
  const md = fs.readFileSync(path.join(inboxDir, files[0]), 'utf8');
  assert.match(md, /^---\ntype: meeting\nstatus: inbox\ncreated: 2026-10-29T14:00:00[+-]\d\d:\d\d\nduration: "2:30"\nsegments: 3\ntags: \[meeting, nokia\]\n/);
  assert.match(md, /summary_method: extractive \(local, no language model\)\n/);
  assert.match(md, /\n## Decisions\n\n- We decided to keep the menu to eight cocktails\.\n/);
  assert.match(md, /\n## Action items\n\n- \[ \] Anna will print the bar menu by Friday\.\n/);
  assert.match(md, /\*\*\[0:00\]\*\* We reviewed the bar menu/);
  assert.match(md, /\*\*\[1:00\]\*\* We decided/);
  assert.match(md, /\*\*\[2:00\]\*\* _\(no speech\)_/);
  assert.ok(!fs.existsSync(mdir), 'the audio is deleted once the note exists');

  r = await finish(finishBody);
  assert.equal(r.status, 200, 'finish after the note exists returns it');
  assert.equal(r.body.file, files[0]);
  assert.equal((await seg(2, 'two')).status, 200, 'a late resent segment is accepted');
  assert.ok(!fs.existsSync(mdir), '…and does not resurrect the meeting');

  // A meeting finished before a restart is written after it; a segment the transcriber always
  // fails on is named in the note after five attempts.
  server.close();
  const M2 = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const m2 = path.join(meetingsDir, M2);
  fs.mkdirSync(m2, {mode: 0o700});
  fs.writeFileSync(path.join(m2, 'seg-0001.ogg'), ogg('one'));
  fs.writeFileSync(path.join(m2, 'seg-0002.ogg'), ogg('bad'));
  fs.writeFileSync(path.join(m2, 'meta.json'), JSON.stringify({requestId: uuid(300), segments: 3, startedAt: new Date(2026, 9, 29, 16, 0).getTime(), durationMs: 170000, segmentMs: 60000}));
  lines.bad = null; // fake answers 200 without text -> transcriber_error
  const before = calls;
  server = createNotesServer(cfg);
  base = `http://127.0.0.1:${await listen(server)}`;
  for (let i = 0; i < 10 && fs.existsSync(m2); i++) { await server.meetingsIdle(); await sleep(50); }
  const second = fs.readFileSync(path.join(inboxDir, 'Nokia-Meeting-2026-10-29-160000.md'), 'utf8');
  assert.match(second, /\*\*\[1:00\]\*\* _\(could not be transcribed\)_/);
  assert.match(second, /> Missing segments: 3 \(lost before upload\)\./);
  assert.equal(calls - before, 1 + 5, 'segment 1 once (cached), segment 2 five times');
  server.close(); whisper.close();
  fs.rmSync(dir, {recursive: true, force: true});
}

// ── Phone: 0 on the Notes screen records a meeting in segments ─────────────
const BRIDGE = 'https://bridge.example.test/nokia/v1';
const NOTES = 'http://192.168.1.20:8790';
const config = {notesUrl: NOTES, notesToken: 'notes-token'};
const toNotes = h => h.xhrRequests.filter(r => r.url.startsWith(NOTES));
function respond(req, status, body) { req.req.status = status; req.req.responseText = JSON.stringify(body); req.req.onload(); }
const tick = h => Object.values(h.tickers).filter(t => t.active && t.ms === 1000).forEach(t => t.fn());
function deliver(rec, data) { rec.ondataavailable({data: new Blob([data])}); rec.onstop(); }

function phone() {
  const storage = new Map();
  const idb = new Map();
  const h = harness(storage, BRIDGE, {config, idb});
  const locks = [];
  h.context.navigator.requestWakeLock = topic => { const l = {topic, released: false, unlock() { l.released = true; }}; locks.push(l); return l; };
  h.key('*');
  assert.match(h.transcript(), /0 records a meeting/, 'the empty Notes screen offers it');
  h.key('0'); h.grant();
  assert.deepEqual(h.softkeys(), ['', 'Stop', '']);
  assert.equal(h.banner(), '● Meeting 0:00');
  assert.equal(h.nodes.bar.className, 'rec');
  assert.deepEqual(locks.map(l => l.topic), ['cpu'], 'the CPU stays awake with the screen off');
  assert.match(h.transcript(), /Recording the meeting/);
  assert.equal(h.recorders.length, 1);
  assert.equal(h.recorders[0].options.audioBitsPerSecond, 16000);
  assert.ok(JSON.parse(storage.get('klaus.meeting.v1')).id, 'the open meeting is remembered for recovery');

  // Back never ends the meeting or closes the app; the screen turning off does not either.
  assert.equal(h.key('Backspace'), true);
  assert.match(h.status(), /still recording/);
  h.context.document.hidden = true; h.handlers.visibilitychange();
  assert.equal(h.recorders[0].state, 'recording');
  h.context.document.hidden = false;
  for (const k of ['1', '#', '5', 'SoftLeft', 'ArrowLeft']) h.key(k);
  assert.equal(h.recorders[0].state, 'recording', 'other keys are ignored mid-meeting');

  // After a minute the next recorder starts first, then the finished one is queued and uploaded.
  h.clock.t += 59000; tick(h);
  assert.equal(h.recorders.length, 1, 'not before the minute is up');
  h.clock.t += 1000; tick(h);
  assert.equal(h.recorders.length, 2);
  assert.equal(h.recorders[1].state, 'recording');
  assert.equal(h.recorders[0].state, 'inactive');
  deliver(h.recorders[0], 'OggS-1');
  let reqs = toNotes(h);
  assert.equal(reqs.length, 1);
  const mid = JSON.parse(storage.get('klaus.meeting.v1')).id;
  assert.equal(reqs[0].url, `${NOTES}/meetings/${mid}/segments/1`);
  assert.equal(reqs[0].headers['Content-Type'], 'audio/ogg');
  assert.equal(h.banner(), '● Meeting 1:00 · 1 ✓', 'one finished minute saved');
  assert.match(h.thinking(), /uploading meeting part 1/);
  respond(reqs[0], 503, {error: 'busy'}); // a failed upload stays queued; recording goes on

  // Stop: the last segment is delivered, then the finish request follows in order.
  h.clock.t += 30000;
  h.key('Enter');
  assert.match(h.status(), /Saving the last part/);
  deliver(h.recorders[1], 'OggS-2');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Chat']);
  assert.equal(h.nodes.bar.className, 'notes');
  assert.equal(locks[0].released, true);
  assert.equal(storage.get('klaus.meeting.v1'), undefined, 'nothing to recover once finished');
  assert.match(h.status(), /Meeting 1:30 saved/);
  const queue = JSON.parse(storage.get('klaus.notes.v1')).queue;
  assert.deepEqual(queue.map(q => [q.seq || null, !!q.finish]), [[1, false], [2, false], [null, true]]);
  assert.deepEqual(queue[2].finish, {segments: 2, startedAt: 1700000000000, durationMs: 90000, segmentMs: 60000});
  assert.match(h.thinking(), /uploading meeting part 1/, 'a new part retries the queue at once');

  // A restart before the upload resumes it from IndexedDB with the same request ids.
  const ids = queue.map(q => q.id);
  const r2 = harness(storage, BRIDGE, {config, idb});
  r2.key('*');
  reqs = toNotes(r2);
  assert.equal(reqs.at(-1).url, `${NOTES}/meetings/${mid}/segments/1`);
  assert.equal(reqs.at(-1).headers['X-Request-Id'], ids[0]);
  respond(reqs.at(-1), 201, {stored: 1});
  respond(toNotes(r2).at(-1), 200, {stored: 2});
  const fin = toNotes(r2).at(-1);
  assert.equal(fin.url, `${NOTES}/meetings/${mid}/finish`);
  assert.equal(fin.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(fin.body), {segments: 2, startedAt: 1700000000000, durationMs: 90000, segmentMs: 60000});
  respond(fin, 202, {state: 'processing', kind: 'meeting', label: 'Meeting saved', summary: 'Transcript and summary follow in the inbox'});
  assert.match(r2.transcript(), /Meeting 1:30.*Meeting saved: transcript and summary follow in Plato's inbox/);
  assert.equal(r2.nodes.chip.textContent, '✓ Meeting saved');
  assert.equal(r2.nodes.chip.className, 'meeting');
  assert.equal(JSON.parse(storage.get('klaus.notes.v1')).queue.length, 0);
  assert.equal(idb.size, 0, 'uploaded parts leave IndexedDB');
}

// A meeting cut short by a crash is finished on the next launch with what was saved.
function recovery() {
  const storage = new Map([['klaus.meeting.v1', JSON.stringify({id: MID, seq: 3, startedAt: 1700000000000})]]);
  const h = harness(storage, BRIDGE, {config});
  h.key('*');
  const fin = toNotes(h).at(-1);
  assert.equal(fin.url, `${NOTES}/meetings/${MID}/finish`);
  assert.equal(JSON.parse(fin.body).segments, 3);
  assert.match(h.transcript(), /cut short; its 3 saved parts are being sent/);
  assert.equal(storage.get('klaus.meeting.v1'), undefined);
  // Without notes configured, 0 stays the quick-reply key in chats and is inert on Notes.
  const plain = harness(new Map(), BRIDGE);
  plain.key('0');
  assert.equal(plain.nodes['overlay-title'].textContent, 'Quick reply · 1-9 sends');
}

service().then(() => {
  phone();
  recovery();
  console.log('Nokia meeting mode (segments, finish, local summary, retry, recovery) checks passed');
}).catch(e => { console.error(e); process.exit(1); });
