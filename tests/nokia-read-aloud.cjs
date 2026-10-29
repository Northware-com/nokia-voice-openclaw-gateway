// nokia-read-aloud.cjs — 5 reads aloud and stops; banner and outline show what is being read.
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
function typedTurn(h, id, text, reply) {
  h.key('SoftLeft'); h.composer.value = text; h.key('Enter');
  if (id) respond(last(h, isCreate), 201, {id});
  respond(last(h, isTurn), 202, {runId: 'r-' + text, state: 'pending'});
  firePoll(h);
  respond(last(h, isPoll(id || h.srv)), 200, {state: 'complete', messages: reply});
}
const READING = ')))' + ' Reading · 5 stops';
const reading = h => h.nodes.transcript.children.map((c, i) => (/\breading\b/.test(c.className) ? i : -1)).filter(i => i >= 0);

// ── Pure helpers ───────────────────────────────────────────────────────────
{
  const K = harness().context.Klaus;
  const b = st => { const r = K.stateBanner(st); return r && r.kind + '|' + r.icon + ' ' + r.text; };
  assert.equal(b({mode: 'idle', elapsed: '', reading: true}), 'reading|' + READING);
  assert.equal(b({mode: 'idle', elapsed: '', reading: true, failed: true}).split('|')[0], 'failed', 'a failure outranks reading');
  assert.equal(b({mode: 'idle', elapsed: '', reading: true, sending: true}).split('|')[0], 'reading', 'reading outranks sending');
  assert.equal(b({mode: 'recording', elapsed: '0:01', reading: true}).split('|')[0], 'rec');
  assert.equal(b({mode: 'typing', elapsed: '', reading: true}), null);
  const msgs = [{text: 'a'}, {text: 'b'}, {text: 'a'}];
  assert.equal(K.readingIndex(msgs, 'a'), 2, 'the newest copy is the one being read');
  assert.equal(K.readingIndex(msgs, 'zzz'), -1);
  assert.equal(K.readingIndex(msgs, null), -1);
}

// ── Auto read-aloud shows itself; 5 stops it and drops the queue ───────────
{
  const h = harness(new Map(), BRIDGE);
  let cancels = 0;
  const realCancel = h.context.speechSynthesis.cancel;
  h.context.speechSynthesis.cancel = function () { cancels++; return realCancel.call(this); };
  typedTurn(h, 'srv-r', 'two things', [{role: 'user', text: 'two things'}, {role: 'assistant', text: 'First.'}, {role: 'assistant', text: 'Second.'}]);
  assert.equal(h.banner(), READING, 'the banner says a reply is being read and how to stop it');
  assert.deepEqual(reading(h), [1], 'the reply being read is outlined');
  assert.equal(h.utterances.length, 1, 'Second. waits its turn');
  h.key('5');
  assert.equal(h.status(), 'Stopped reading.');
  assert.equal(h.banner(), '');
  assert.deepEqual(reading(h), []);
  assert.ok(cancels >= 1, 'speech is cancelled');
  h.finishSpeech();
  assert.equal(h.utterances.length, 1, 'queued replies are dropped too, so silence means silence');

  // 5 again reads the latest reply; the outline follows; finishing clears both.
  h.key('5');
  assert.equal(h.utterances.at(-1).text, 'Second.');
  assert.equal(h.banner(), READING);
  assert.deepEqual(reading(h), [2]);
  h.finishSpeech();
  assert.equal(h.banner(), '');
  assert.deepEqual(reading(h), []);

  // A focused message is read and outlined.
  h.key('ArrowUp'); h.key('ArrowUp'); h.key('ArrowUp');
  h.key('5');
  assert.equal(h.utterances.at(-1).text, 'two things');
  assert.deepEqual(reading(h), [0]);
  // Recording interrupts reading and its banner.
  h.key('9'); h.key('Enter');
  assert.match(h.banner(), /Recording/);
  assert.deepEqual(reading(h), []);
  h.key('SoftLeft');
  assert.equal(h.banner(), '', 'nothing is read after the recording is discarded');
}

// ── Another chat's speech: no banner here, and 5 reads this chat instead ────
{
  const h = harness(new Map(), BRIDGE);
  typedTurn(h, 'srv-a', 'hi', [{role: 'user', text: 'hi'}, {role: 'assistant', text: 'Reply A.'}]);
  h.finishSpeech();
  h.key('3');
  typedTurn(h, 'srv-b', 'yo', [{role: 'user', text: 'yo'}, {role: 'assistant', text: 'Reply B.'}]);
  assert.equal(h.banner(), READING);
  h.key('ArrowLeft');
  assert.equal(h.banner(), '', 'chat A is not being read');
  assert.deepEqual(reading(h), []);
  h.key('5');
  assert.equal(h.utterances.at(-1).text, 'Reply A.', '5 reads this chat instead of stopping the other');
  assert.equal(h.banner(), READING);
  assert.deepEqual(reading(h), [1]);
}

// ── Turning auto read-aloud off stops what is being read ───────────────────
{
  const h = harness(new Map(), BRIDGE);
  typedTurn(h, 'srv-o', 'hi', [{role: 'user', text: 'hi'}, {role: 'assistant', text: 'Long answer.'}]);
  assert.equal(h.banner(), READING);
  h.key('SoftRight'); for (let i = 0; i < 4; i++) h.key('ArrowDown'); h.key('Enter');
  assert.equal(h.status(), 'Read aloud off.');
  assert.equal(h.banner(), '');
}

console.log('Nokia read-aloud key, banner and outline checks passed');
