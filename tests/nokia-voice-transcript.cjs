// nokia-voice-transcript.cjs — sent clips show as placeholders until the bridge returns a transcript.
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
function record(h, ms) {
  h.key('Enter'); h.grant(); h.clock.t += ms; h.key('Call');
  const rec = h.recorders.at(-1);
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
}
const rows = h => h.nodes.transcript.children.filter(c => /\bmsg\b/.test(c.className))
  .map(c => (/\bvoice\b/.test(c.className) ? 'voice:' : /\buser\b/.test(c.className) ? 'user:' : 'bot:') + c.textContent);
const u = text => ({role: 'user', text});
const a = text => ({role: 'assistant', text});

// ── Pure merge ─────────────────────────────────────────────────────────────
{
  const K = harness().context.Klaus;
  const merge = (server, turns) => Array.from(K.mergeVoice(server, turns)).map(m => (m.voice ? 'voice:' : m.role + ':') + m.text);
  assert.equal(K.voiceLabel(7000), 'Voice clip · 0:07');
  assert.deepEqual(merge([u('hi'), a('hello')], []), ['user:hi', 'assistant:hello'], 'no clips, no change');
  assert.deepEqual(merge([], [{at: 0, ms: 3000}]), ['voice:Voice clip · 0:03'], 'pending clip shows at once');
  assert.deepEqual(merge([a('Sure.')], [{at: 0, ms: 3000}]), ['voice:Voice clip · 0:03', 'assistant:Sure.'],
    'the clip sits before its reply');
  assert.deepEqual(merge([u('lights off'), a('Done.')], [{at: 0, ms: 3000}]), ['user:lights off', 'assistant:Done.'],
    'a returned transcript replaces the placeholder');
  assert.deepEqual(merge([a('One.'), u('typed'), a('Two.')], [{at: 0, ms: 1000}, {at: 3, ms: 2000}]),
    ['voice:Voice clip · 0:01', 'assistant:One.', 'user:typed', 'assistant:Two.', 'voice:Voice clip · 0:02'],
    'clips interleave with typed turns');
  assert.deepEqual(merge([a('x')], [{at: 9, ms: 1000}]), ['assistant:x', 'voice:Voice clip · 0:01'],
    'a clip past a trimmed history goes last');
  assert.deepEqual(K.serverMessages([u('a'), {role: 'user', text: 'Voice clip · 0:01', voice: true}]).length, 1);
}

// ── A clip without a transcript, then one with a transcript ────────────────
{
  const h = harness(new Map(), BRIDGE);
  record(h, 7000);
  assert.deepEqual(rows(h), ['voice:Voice clip · 0:07'], 'the clip shows in the chat as soon as it is sent');
  respond(last(h, isCreate), 201, {id: 'srv-v'});
  respond(last(h, isTurn), 202, {runId: 'r1', state: 'pending'});
  firePoll(h);
  respond(last(h, isPoll('srv-v')), 200, {state: 'pending', messages: []});
  assert.deepEqual(rows(h), ['voice:Voice clip · 0:07'], 'placeholder survives an empty poll');
  firePoll(h);
  respond(last(h, isPoll('srv-v')), 200, {state: 'complete', messages: [a('Lights are off.')]});
  assert.deepEqual(rows(h), ['voice:Voice clip · 0:07', 'bot:Lights are off.']);
  assert.equal(h.nodes['session-title'].textContent, 'Lights are off.', 'the reply titles a chat that started by voice');
  assert.equal(h.utterances.at(-1).text, 'Lights are off.', 'only the reply is read aloud');
  assert.ok(!h.utterances.some(x => /Voice clip/.test(x.text)), 'placeholders are never spoken');

  // 5 on the focused placeholder plays the recording instead of reading a reply.
  h.finishSpeech();
  h.key('ArrowUp'); h.key('ArrowUp');
  h.key('5');
  assert.equal(h.nodes.player.paused, false, 'the clip plays');
  assert.match(h.status(), /Playing your recording/);
  h.key('5');

  record(h, 2000);
  assert.deepEqual(rows(h), ['voice:Voice clip · 0:07', 'bot:Lights are off.', 'voice:Voice clip · 0:02']);
  respond(last(h, isTurn), 202, {runId: 'r2', state: 'pending'});
  firePoll(h);
  respond(last(h, isPoll('srv-v')), 200, {state: 'complete', messages: [a('Lights are off.'), u('and the heating'), a('Heating at 19.')]});
  assert.deepEqual(rows(h), ['voice:Voice clip · 0:07', 'bot:Lights are off.', 'user:and the heating', 'bot:Heating at 19.'],
    'transcript first: the returned transcript takes the placeholder\'s place');
  assert.equal(h.nodes['session-title'].textContent, 'Lights are off.', 'a later typed turn does not retitle a voice-first chat');

  // Placeholders persist; after a restart there is no recording to play.
  const stored = JSON.parse(h.storage.get('klaus.sessions.v2'))[0];
  assert.deepEqual(stored.voiceTurns, [{at: 0, ms: 7000}, {at: 1, ms: 2000}]);
  const reload = harness(h.storage);
  assert.deepEqual(rows(reload), rows(h), 'the transcript reloads with its placeholders');
  reload.key('1'); reload.key('5');
  assert.equal(reload.status(), 'No transcript for this clip yet.');
}

// ── Back discards an unsent clip and its placeholder ───────────────────────
{
  const h = harness();
  record(h, 4000);
  assert.deepEqual(rows(h), ['voice:Voice clip · 0:04']);
  h.key('Backspace');
  assert.equal(h.status(), 'Unsent clip discarded.');
  assert.deepEqual(rows(h), [], 'the placeholder goes with the clip');
  assert.deepEqual(JSON.parse(h.storage.get('klaus.sessions.v2'))[0].voiceTurns, []);
}

// ── Stored placeholders are validated ──────────────────────────────────────
{
  const bad = [{id: 'x', title: 'T', messages: [a('ok')], voiceTurns: [{at: -1, ms: 5}, null, {at: 0}, {at: 1, ms: 1000, extra: 1}]}];
  const h = harness(new Map([['klaus.sessions.v2', JSON.stringify(bad)]]));
  assert.deepEqual(JSON.parse(h.storage.get('klaus.sessions.v2'))[0].voiceTurns, [{at: 1, ms: 1000}]);
}

console.log('Nokia voice placeholders and transcript-first checks passed');
