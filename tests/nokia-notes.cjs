// nokia-notes.cjs — quick-note inbox service: auth, idempotency, transcription and note files.
// Uses a fake WhisperX server and a temporary inbox; run after bash configs/nokia-notes/build.sh.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {createNotesServer, summarize} = require('../configs/nokia-notes/dist/notes.js');

const TOKEN = 'n'.repeat(40);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nokia-notes-'));
  const inboxDir = path.join(dir, 'inbox');
  fs.mkdirSync(inboxDir);
  const stateFile = path.join(dir, 'state.json');

  // Fake transcriber: answers with `reply`, or fails when reply is null.
  let reply = {text: ' Buy oat milk tomorrow. Also call the garage about the Opel. ', language: 'en', duration_s: 4.2};
  let calls = 0;
  const whisper = http.createServer((req, res) => {
    calls++;
    req.resume();
    req.on('end', () => {
      if (!reply) { res.writeHead(500); res.end('{}'); return; }
      res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(reply));
    });
  });
  const whisperUrl = `http://127.0.0.1:${await listen(whisper)}`;
  const date = new Date(2026, 9, 29, 7, 5, 9);
  const config = {token: TOKEN, inboxDir, stateFile, whisperUrl};
  let server = createNotesServer(config, () => date);
  let base = `http://127.0.0.1:${await listen(server)}`;

  const post = (requestId, type, body, token = TOKEN) => fetch(base + '/notes', {
    method: 'POST', body,
    headers: {'Authorization': `Bearer ${token}`, 'Content-Type': type, 'X-Request-Id': requestId},
  }).then(async r => ({status: r.status, body: await r.json()}));
  const notes = () => fs.readdirSync(inboxDir).filter(f => f.endsWith('.md')).sort();
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64)]);

  assert.throws(() => createNotesServer(Object.assign({}, config, {token: 'short'})), /token/, 'weak tokens are refused');

  let r = await post(id(1), 'application/json', JSON.stringify({text: 'hi'}), 'x'.repeat(40));
  assert.equal(r.status, 401, 'a wrong token is rejected');
  r = await post('not-a-uuid', 'application/json', JSON.stringify({text: 'hi'}));
  assert.equal(r.status, 400, 'a request id is required');

  // Typed note.
  r = await post(id(1), 'application/json', JSON.stringify({text: 'Remember the dentist on Friday! Bring the card.'}));
  assert.equal(r.status, 201);
  assert.equal(r.body.summary, 'Remember the dentist on Friday!');
  assert.deepEqual(notes(), ['Nokia-Note-2026-10-29-070509.md']);
  const typed = fs.readFileSync(path.join(inboxDir, notes()[0]), 'utf8');
  assert.match(typed, /^---\ntype: note\nstatus: inbox\ncreated: 2026-10-29T07:05:09[+-]\d\d:\d\d\nsource: Nokia typed note\n/);
  assert.match(typed, /request_id: 00000000-0000-4000-8000-000000000001\n/);
  assert.match(typed, /\n# Remember the dentist on Friday!\n\nRemember the dentist on Friday! Bring the card.\n$/);

  // A resend with the same id returns the same note and writes nothing new.
  const again = await post(id(1), 'application/json', JSON.stringify({text: 'Remember the dentist on Friday! Bring the card.'}));
  assert.equal(again.status, 200, 'a resend is answered from the saved result');
  assert.deepEqual(again.body, r.body);
  assert.equal(notes().length, 1, 'a resend never duplicates a note');

  // Voice note: transcribed, same timestamp gets a suffixed file name.
  r = await post(id(2), 'audio/ogg', ogg);
  assert.equal(r.status, 201);
  assert.equal(r.body.summary, 'Buy oat milk tomorrow.');
  assert.equal(r.body.file, 'Nokia-Note-2026-10-29-070509-2.md');
  const voice = fs.readFileSync(path.join(inboxDir, r.body.file), 'utf8');
  assert.match(voice, /source: Nokia voice note\n/);
  assert.match(voice, /language: en\nduration_s: 4.2\n/);
  assert.match(voice, /Buy oat milk tomorrow. Also call the garage about the Opel.\n$/);
  assert.equal(calls, 1);

  // Transcriber down: 503 so the phone keeps the clip; a later resend succeeds once.
  reply = null;
  r = await post(id(3), 'audio/ogg', ogg);
  assert.equal(r.status, 503);
  assert.equal(notes().length, 2, 'no note without a transcript');
  reply = {text: 'Second try works.'};
  r = await post(id(3), 'audio/ogg', ogg);
  assert.equal(r.status, 201);
  assert.equal(r.body.summary, 'Second try works.');

  // Silence and junk.
  reply = {text: '   '};
  assert.equal((await post(id(4), 'audio/ogg', ogg)).status, 422, 'no speech is reported, not saved');
  assert.equal((await post(id(5), 'audio/ogg', Buffer.from('nope'))).status, 400);
  assert.equal((await post(id(6), 'text/plain', 'x')).status, 415);
  assert.equal(notes().length, 3);

  // Idempotency survives a service restart.
  await new Promise(resolve => server.close(resolve));
  server = createNotesServer(config, () => date);
  base = `http://127.0.0.1:${await listen(server)}`;
  r = await post(id(2), 'audio/ogg', ogg);
  assert.equal(r.status, 200);
  assert.equal(r.body.file, 'Nokia-Note-2026-10-29-070509-2.md');
  assert.equal(notes().length, 3);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600, 'the state file is private');

  assert.equal(summarize('x'.repeat(200)).length, 80, 'summaries are one short line');
  assert.equal(summarize('No full stop here'), 'No full stop here');

  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => whisper.close(resolve));
  fs.rmSync(dir, {recursive: true, force: true});
  console.log('Nokia notes inbox (auth, idempotency, transcription, note files) checks passed');
}

main().catch(error => { console.error(error); process.exit(1); });
