// nokia-voice-commands.cjs — "task", "idea", "remind me" (and opgave, idé, husk) at the start of a
// note route it to a tagged task, idea or reminder file; the phone shows a confirmation chip.
// Run after npm run build (uses configs/nokia-notes/dist and configs/nokia-klaus/app.js).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {classify, parseWhen, confirmLabel} = require('../configs/nokia-notes/dist/commands.js');
const {createNotesServer} = require('../configs/nokia-notes/dist/notes.js');
const {harness} = require('./nokia-audio.cjs');

// Thursday 29 Oct 2026, 10:30 local time.
const NOW = new Date(2026, 9, 29, 10, 30);
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
const due = (text) => { const c = classify(text, NOW); return c.due ? c.due.getTime() : null; };

// ── Keywords, English and Danish ───────────────────────────────────────────
{
  assert.deepEqual(classify('Task: buy milk.', NOW), {kind: 'task', body: 'Buy milk.'});
  assert.deepEqual(classify('task, call the garage about the Opel', NOW), {kind: 'task', body: 'Call the garage about the Opel'});
  assert.deepEqual(classify('To-do renew the passport', NOW), {kind: 'task', body: 'Renew the passport'});
  assert.deepEqual(classify('Opgave: ring til tandlægen.', NOW), {kind: 'task', body: 'Ring til tandlægen.'});
  assert.deepEqual(classify('Ny opgave bestil brænde', NOW), {kind: 'task', body: 'Bestil brænde'});
  assert.deepEqual(classify('Idea. A podcast about Nordic design', NOW), {kind: 'idea', body: 'A podcast about Nordic design'});
  assert.deepEqual(classify('Idé: et brætspil om vikinger', NOW), {kind: 'idea', body: 'Et brætspil om vikinger'});
  assert.deepEqual(classify('ide til DrinkingDojo: quiz night', NOW), {kind: 'idea', body: 'Til DrinkingDojo: quiz night'});
  assert.equal(classify('Tasks are piling up this week.', NOW).kind, 'note', 'a longer word is not the keyword');
  assert.equal(classify('Ideas need time.', NOW).kind, 'note');
  assert.equal(classify('Remember the dentist on Friday!', NOW).kind, 'note', '"remember" is not "remind me"');
  assert.equal(classify('Huskeliste til weekenden', NOW).kind, 'note');
  assert.equal(classify('Task', NOW).kind, 'note', 'a bare keyword is just a note');
}

// ── Reminder times ─────────────────────────────────────────────────────────
{
  assert.deepEqual(classify('Remind me at 3 pm to call mum.', NOW), {kind: 'reminder', body: 'Call mum.', due: new Date(at(29, 15))});
  assert.equal(due('Remind me to call mum at 15:00'), at(29, 15));
  assert.equal(due('remind me at 3 to call mum'), at(29, 15), 'English "at 3" is the afternoon');
  assert.equal(due('remind me at 9 am to stretch'), at(30, 9), 'a time already gone today rolls to tomorrow');
  assert.equal(due('remind me at 10:45 to leave'), at(29, 10, 45));
  assert.equal(due('Remind me tomorrow at 9 to pay rent'), at(30, 9));
  assert.equal(due('remind me tomorrow to pay rent'), at(30, 9), 'a day without a time means 09:00');
  assert.equal(due('remind me tonight to water the plants'), at(29, 20));
  assert.equal(due('remind me in 20 minutes to check the oven'), NOW.getTime() + 20 * 60000);
  assert.equal(due('remind me in an hour to stretch'), NOW.getTime() + 3600000);
  assert.equal(due('remind me in half an hour to stretch'), NOW.getTime() + 1800000);
  assert.equal(due('Remind me on Friday at 14:30 about the invoice'), at(30, 14, 30));
  assert.equal(due('remind me Thursday to call'), at(29 + 7, 9), 'today\'s weekday means next week');
  assert.equal(due('Husk at ringe til mor kl. 15'), at(29, 15));
  assert.equal(due('husk mig på mødet i morgen klokken 9.30'), at(30, 9, 30));
  assert.equal(due('husk at hente pakken kl 7'), at(30, 7), 'Danish "kl 7" stays 07:00 (tomorrow, today is past)');
  assert.equal(due('husk at slukke ovnen om 10 minutter'), NOW.getTime() + 10 * 60000);
  assert.equal(due('Husk om en halv time at ringe'), NOW.getTime() + 1800000);
  assert.equal(due('husk at købe mælk på fredag'), at(30, 9));
  assert.equal(due('husk i aften at tage skraldet ud'), at(29, 20));
  assert.deepEqual(classify('Husk at købe mælk', NOW), {kind: 'reminder', body: 'Købe mælk'}, 'no time: a reminder without due');
  assert.equal(classify('husk at ringe til mor kl. 15', NOW).body, 'Ringe til mor');
  assert.equal(classify('remind me to buy 2 cartons of milk', NOW).due, undefined, 'a bare number is not a time');
  assert.equal(parseWhen('meet at 25:00', NOW).due, undefined, 'impossible times are ignored');
}

// ── Labels for the phone chip ──────────────────────────────────────────────
{
  const label = t => confirmLabel(classify(t, NOW), NOW);
  assert.equal(label('task buy milk'), 'Task saved');
  assert.equal(label('idea a song'), 'Idea saved');
  assert.equal(label('just a thought'), 'Note saved');
  assert.equal(label('remind me at 15:00 to call'), 'Reminder 15:00');
  assert.equal(label('remind me tomorrow at 9 to call'), 'Reminder tomorrow 9:00');
  assert.equal(label('remind me on Monday at 8:15 to call'), 'Reminder Mon 8:15');
  assert.equal(label('husk at købe mælk'), 'Reminder, no time');
  for (const t of ['remind me in 20 minutes to call', 'remind me tomorrow at 9 to call']) assert.ok(label(t).length <= 24, 'fits the chip');
}

// ── The service writes tagged files and answers with kind, label and due ───
const TOKEN = 'n'.repeat(40);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nokia-commands-'));
  const inboxDir = path.join(dir, 'inbox');
  fs.mkdirSync(inboxDir);
  let reply = {text: 'Opgave. Ring til tandlægen om tiden.', language: 'da', duration_s: 3};
  const whisper = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end(JSON.stringify(reply)); }); });
  const whisperUrl = `http://127.0.0.1:${await listen(whisper)}`;
  const server = createNotesServer({token: TOKEN, inboxDir, stateFile: path.join(dir, 'state.json'), whisperUrl}, () => NOW);
  const base = `http://127.0.0.1:${await listen(server)}`;
  const post = (n, type, body) => fetch(base + '/notes', {method: 'POST', body,
    headers: {Authorization: `Bearer ${TOKEN}`, 'Content-Type': type, 'X-Request-Id': id(n)}}).then(async r => ({status: r.status, body: await r.json()}));
  const read = f => fs.readFileSync(path.join(inboxDir, f), 'utf8');

  let r = await post(1, 'application/json', JSON.stringify({text: 'Task: buy oat milk.'}));
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, {file: 'Nokia-Task-2026-10-29-103000.md', summary: 'Buy oat milk.', kind: 'task', label: 'Task saved'});
  let md = read(r.body.file);
  assert.match(md, /^---\ntype: task\nstatus: open\ncreated: 2026-10-29T10:30:00[+-]\d\d:\d\d\ntags: \[task, nokia\]\nsource: Nokia typed note\n/);
  assert.match(md, /\n# Buy oat milk\.\n\nTask: buy oat milk\.\n$/, 'the title drops the keyword, the body keeps the words as said');

  r = await post(2, 'application/json', JSON.stringify({text: 'Idea: a pub quiz app for DrinkingDojo'}));
  assert.equal(r.body.file, 'Nokia-Idea-2026-10-29-103000.md');
  assert.match(read(r.body.file), /type: idea\nstatus: inbox\n.*\ntags: \[idea, nokia\]\n/s);

  r = await post(3, 'application/json', JSON.stringify({text: 'Remind me at 3 pm to call mum.'}));
  assert.equal(r.body.kind, 'reminder');
  assert.equal(r.body.label, 'Reminder 15:00');
  assert.match(r.body.due, /^2026-10-29T15:00:00[+-]\d\d:\d\d$/);
  md = read(r.body.file);
  assert.match(r.body.file, /^Nokia-Reminder-2026-10-29-103000\.md$/);
  assert.match(md, /type: reminder\nstatus: open\ncreated: [^\n]+\ndue: 2026-10-29T15:00:00[+-]\d\d:\d\d\ntags: \[reminder, nokia\]\n/);
  assert.match(md, /\n# Call mum\.\n/);

  r = await post(4, 'audio/ogg', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32)]));
  assert.equal(r.body.kind, 'task', 'a spoken Danish keyword routes the voice note too');
  assert.equal(r.body.summary, 'Ring til tandlægen om tiden.');
  assert.match(read(r.body.file), /source: Nokia voice note\nrequest_id: [^\n]+\nlanguage: da\n/);

  r = await post(5, 'application/json', JSON.stringify({text: 'Plain thought about the garden.'}));
  assert.deepEqual(r.body, {file: 'Nokia-Note-2026-10-29-103000.md', summary: 'Plain thought about the garden.', kind: 'note', label: 'Note saved'});
  assert.doesNotMatch(read(r.body.file), /tags:/, 'plain notes keep the inbox format');

  const again = await post(3, 'application/json', JSON.stringify({text: 'Remind me at 3 pm to call mum.'}));
  assert.equal(again.status, 200, 'a resend returns the saved reminder');
  assert.equal(again.body.label, 'Reminder 15:00');
  assert.equal(fs.readdirSync(inboxDir).filter(f => f.endsWith('.md')).length, 5);
  server.close(); whisper.close();
  fs.rmSync(dir, {recursive: true, force: true});
}

// ── The phone shows the chip and the routed label in the notes log ────────
function phone() {
  const BRIDGE = 'https://bridge.example.test/nokia/v1';
  const NOTES = 'http://192.168.1.20:8790';
  const h = harness(new Map(), BRIDGE, {config: {notesUrl: NOTES, notesToken: 'notes-token'}});
  const respond = (status, body) => { const q = h.xhrRequests.filter(r => r.url === NOTES + '/notes').at(-1); q.req.status = status; q.req.responseText = JSON.stringify(body); q.req.onload(); };
  const chip = () => (h.nodes.chip.hidden ? '' : h.nodes.chip.textContent);
  h.key('*');
  h.key('SoftLeft'); h.composer.value = 'remind me at 3 pm to call mum'; h.key('Enter');
  respond(201, {file: 'f.md', summary: 'Call mum', kind: 'reminder', label: 'Reminder 15:00', due: '2026-10-29T15:00:00+00:00'});
  assert.equal(chip(), '✓ Reminder 15:00');
  assert.equal(h.nodes.chip.className, 'reminder');
  assert.match(h.transcript(), /Reminder 15:00: Call mum/);
  h.key('ArrowUp');
  assert.equal(chip(), '', 'the next key press clears the chip');
  h.key('SoftLeft'); h.composer.value = 'task buy milk'; h.key('Enter');
  respond(201, {file: 'f.md', summary: 'Buy milk', kind: 'task', label: 'Task saved'});
  assert.equal(chip(), '✓ Task saved');
  assert.equal(h.nodes.chip.className, 'task');
  const timer = Object.values(h.pollTimers).filter(t => t.active && t.ms === 4000).at(-1);
  timer.fn();
  assert.equal(chip(), '', 'the chip fades after 4 s');
  h.key('SoftLeft'); h.composer.value = 'hello'; h.key('Enter');
  respond(201, {file: 'f.md', summary: 'hello'});
  assert.equal(chip(), '✓ Note saved', 'an older service without labels still confirms');
  assert.match(h.transcript(), /Saved: hello/);
  h.key('SoftLeft'); h.composer.value = 'x'; h.key('Enter');
  respond(201, {file: 'f.md', summary: 'x', kind: '<b>', label: 'Task saved'});
  assert.equal(h.nodes.chip.className, 'note', 'unknown kinds fall back to a plain note');
}

service().then(() => {
  phone();
  console.log('Nokia voice commands (task/idea/reminder routing, times, chip) checks passed');
}).catch(e => { console.error(e); process.exit(1); });
