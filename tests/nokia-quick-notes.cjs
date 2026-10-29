// nokia-quick-notes.cjs — Notes screen ("*"): notes go to the Plato inbox service, never to Klaus,
// queue in order while unreachable and resend with the same request id after a restart.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';
const NOTES = 'http://192.168.1.20:8790';
const config = {notesUrl: NOTES, notesToken: 'notes-token'};

function respond(h, req, status, body) {
  req.req.status = status;
  req.req.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  req.req.onload();
}
const last = (h, pred) => h.xhrRequests.filter(pred).at(-1);
const isNote = r => r.url === NOTES + '/notes';
const toBridge = r => r.url.startsWith(BRIDGE);
function record(h) {
  h.key('Enter'); h.grant(); h.key('Call');
  const rec = h.recorders.at(-1);
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
}
function typeNote(h, text) { h.key('SoftLeft'); h.composer.value = text; h.key('Enter'); }
const title = h => h.nodes['session-title'].textContent;

{
  const h = harness(new Map(), BRIDGE);
  h.key('*');
  assert.match(h.status(), /not configured/, 'without a notes URL the key explains itself');
  assert.equal(title(h), 'Conversation 1');
}
{
  const h = harness(new Map(), BRIDGE, {config});
  h.key('*');
  assert.equal(title(h), 'Notes → Plato', '* opens the Notes screen');
  assert.equal(h.nodes.bar.className, 'notes');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Chat']);
  assert.match(h.transcript(), /No notes yet/);

  record(h);
  const note = last(h, isNote);
  assert.ok(note, 'a voice note is posted to the notes service');
  assert.equal(note.headers.Authorization, 'Bearer notes-token', 'with the notes token, not the Klaus token');
  assert.equal(note.headers['Content-Type'], 'audio/ogg');
  assert.ok(note.body instanceof Blob);
  assert.equal(h.xhrRequests.filter(r => toBridge(r) && r.method === 'POST').length, 0, 'Klaus never sees a note');
  assert.match(h.thinking(), /saving note/);
  respond(h, note, 201, {summary: 'Buy oat milk tomorrow.', file: 'Nokia-Note-x.md'});
  assert.match(h.transcript(), /Voice note.*Saved: Buy oat milk tomorrow\./, 'the one-line summary is echoed back');
  assert.equal(h.thinking(), '');

  typeNote(h, 'Call the garage');
  const typed = last(h, isNote);
  assert.deepEqual(JSON.parse(typed.body), {text: 'Call the garage'});
  assert.equal(typed.headers['Content-Type'], 'application/json');
  respond(h, typed, 200, {summary: 'Call the garage'});
  assert.match(h.transcript(), /Saved: Call the garage/);

  h.key('ArrowLeft');
  assert.match(h.status(), /returns to the chats/, 'chat navigation is paused in Notes');
  h.key('SoftRight');
  assert.equal(title(h), 'Conversation 1', 'Chat (SoftRight) returns to the chats');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu']);
  h.key('*'); h.key('Backspace');
  assert.equal(title(h), 'Conversation 1', 'Back also returns');
}
{
  // Unreachable: notes queue in order and resend with their own ids after a restart.
  const storage = new Map(), idb = new Map();
  const h = harness(storage, BRIDGE, {config, idb});
  h.key('*');
  record(h);
  const first = last(h, isNote);
  first.req.onerror();
  assert.match(h.status(), /queued/);
  assert.equal(h.thinking(), '1 note queued');
  h.firePrime();
  typeNote(h, 'second');
  assert.equal(h.xhrRequests.filter(isNote).length, 2, 'the queue retries from the oldest note');
  assert.equal(last(h, isNote).headers['X-Request-Id'], first.headers['X-Request-Id']);
  last(h, isNote).req.onerror();
  assert.equal(h.thinking(), '2 notes queued');

  const h2 = harness(storage, BRIDGE, {config, idb});
  const resent = last(h2, isNote);
  assert.ok(resent, 'queued notes are sent after a restart');
  assert.equal(resent.headers['X-Request-Id'], first.headers['X-Request-Id'], 'with the original request id');
  assert.ok(resent.body instanceof Blob, 'and the saved clip');
  respond(h2, resent, 200, {summary: 'first'});
  const next = last(h2, isNote);
  assert.notEqual(next, resent, 'then the next note');
  assert.deepEqual(JSON.parse(next.body), {text: 'second'});
  respond(h2, next, 422, {error: 'no_speech'});
  assert.equal(idb.size, 0, 'sent clips are deleted');
  assert.deepEqual(JSON.parse(storage.get('klaus.notes.v1')).queue, []);
  h2.key('*');
  assert.match(h2.transcript(), /Saved: first.*No speech heard/);
}
console.log('Nokia quick notes (Notes screen, queue, restart resend) checks passed');
