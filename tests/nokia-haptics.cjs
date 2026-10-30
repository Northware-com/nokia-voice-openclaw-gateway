// nokia-haptics.cjs — short, distinct vibrations: one light tick per acting key, record
// start, pause, send, arrival and errors, switched off and on from the menu and
// remembered across restarts.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';
const NOTES = 'http://192.168.1.20:8790';

function respond(req, status, body) {
  req.req.status = status;
  req.req.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  req.req.onload();
}

// ── Patterns are short and distinguishable by rhythm ───────────────────────
{
  const K = harness().context.Klaus;
  const p = K.HAPTICS;
  const kinds = ['key', 'start', 'pause', 'send', 'arrived', 'error'];
  const shapes = kinds.map(k => JSON.stringify(p[k]));
  assert.equal(new Set(shapes).size, kinds.length, 'every event has its own pattern');
  for (const k of kinds) {
    const total = p[k].reduce((a, b) => a + b, 0);
    assert.ok(total <= 600, `${k} stays short (${total} ms)`);
  }
  assert.ok(p.key.reduce((a, b) => a + b, 0) <= 40, 'the key tick is very light');
  assert.ok(p.pause.length > p.start.length, 'pause is a double tick, start a single one');
  assert.ok(p.arrived.length > p.pause.length, 'arrival is the triple tick');
}

// ── Recording: start, pause, resume and send each vibrate ─────────────────
{
  const h = harness(new Map(), BRIDGE);
  const K = JSON.parse(JSON.stringify(h.context.Klaus.HAPTICS));
  h.key('Enter'); h.grant();
  assert.deepEqual(h.vibrations, [K.key, K.start], 'start buzzes once the microphone is really open, after its key tick');
  const rec = h.recorders[0];
  rec.pause = () => { rec.state = 'paused'; }; rec.resume = () => { rec.state = 'recording'; };
  // canResume is read when the recorder starts; this fake gained pause() later, so OK stops-and-keeps.
  h.key('Enter');
  assert.deepEqual(h.vibrations.slice(-2), [K.key, K.pause], 'pause keeps its double tick after its own key tick');
  h.key('Call');
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  assert.deepEqual(h.vibrations.at(-1), K.send, 'Call buzzes once the clip is handed over');
}

// ── Typed text and quick replies buzz on send; a reply buzzes on arrival ───
{
  const h = harness(new Map(), BRIDGE);
  const K = JSON.parse(JSON.stringify(h.context.Klaus.HAPTICS));
  h.key('SoftLeft'); h.composer.value = 'hello'; h.key('Enter');
  assert.deepEqual(h.vibrations, [K.key, K.key, K.send], 'each acting key ticks; send keeps its firm pulse');
  respond(h.xhrRequests.find(r => r.url === BRIDGE + '/sessions' && r.method === 'POST'), 201, {id: 's1'});
  respond(h.xhrRequests.find(r => r.url.endsWith('/turns')), 202, {runId: 'r1', state: 'pending'});
  h.activePolls().forEach(id => h.pollTimers[id].fn());
  respond(h.xhrRequests.filter(r => r.method === 'GET' && r.url === BRIDGE + '/sessions/s1').at(-1), 200,
    {state: 'complete', runId: 'r1', messages: [{role: 'user', text: 'hello'}, {role: 'assistant', text: 'Hi there.'}]});
  assert.deepEqual(h.vibrations.at(-1), K.arrived, 'a new reply gives the triple tick');
  const count = h.vibrations.length;
  h.key('0'); h.key('1');
  assert.equal(h.vibrations.length, count + 3, 'open tick, then the send key tick and its send pulse');
  assert.deepEqual(h.vibrations.at(-1), K.send, 'a quick reply buzzes like any send');
}

// ── Errors buzz, but a burst of errors buzzes once ─────────────────────────
{
  const h = harness();
  const K = JSON.parse(JSON.stringify(h.context.Klaus.HAPTICS));
  h.key('Enter');
  h.requests[0].fail(new Error('denied'));
  assert.match(h.status(), /denied/);
  assert.deepEqual(h.vibrations, [K.key, K.error], 'the key tick came first; the error keeps its pattern');
  h.key('Enter'); h.requests[1].fail(new Error('denied'));
  assert.equal(h.vibrations.length, 3, 'a second error within 4 s stays quiet (its key tick still fires)');
  h.clock.t += 5000;
  h.key('Enter'); h.requests[2].fail(new Error('denied'));
  assert.equal(h.vibrations.length, 5);
}

// ── Notes: saved notes tick, rejected notes buzz the error ────────────────
{
  const h = harness(new Map(), BRIDGE, {config: {notesUrl: NOTES, notesToken: 'notes-token'}});
  const K = JSON.parse(JSON.stringify(h.context.Klaus.HAPTICS));
  h.key('*');
  h.key('SoftLeft'); h.composer.value = 'buy milk'; h.key('Enter');
  respond(h.xhrRequests.filter(r => r.url === NOTES + '/notes').at(-1), 201, {file: 'x.md', summary: 'buy milk'});
  assert.deepEqual(h.vibrations.slice(-2), [K.send, K.arrived]);
  h.clock.t += 5000;
  h.key('SoftLeft'); h.composer.value = 'x'; h.key('Enter');
  respond(h.xhrRequests.filter(r => r.url === NOTES + '/notes').at(-1), 400, {error: 'invalid_text'});
  assert.deepEqual(h.vibrations.at(-1), K.error);
}

// ── Menu › Vibrate toggles, persists, and silences every pattern ──────────
{
  const storage = new Map();
  const h = harness(storage);
  h.key('SoftRight');
  const items = h.nodes['overlay-list'].children.map(c => c.textContent);
  assert.ok(items.includes('6Vibrate: on'), 'the menu shows the current state');
  h.key('6');
  assert.equal(h.status(), 'Vibrate off.');
  assert.equal(h.nodes.status.className, 'ok');
  assert.equal(storage.get('klaus.haptics'), '0');
  assert.equal(h.vibrations.length, 2, 'both opening key presses ticked before the switch took effect');
  h.key('Enter'); h.grant();
  assert.equal(h.vibrations.length, 2, 'switched off: the recording and its keys stay silent');

  const again = harness(storage);
  again.key('Enter'); again.grant();
  assert.equal(again.vibrations.length, 0, 'the setting survives a restart');
  again.key('SoftLeft');
  again.key('SoftRight'); again.key('6');
  assert.equal(again.status(), 'Vibrate on.');
  assert.deepEqual(again.vibrations, [Array.from(again.context.Klaus.HAPTICS.start)], 'switching on gives a sample tick');
}

// ── A phone without navigator.vibrate keeps working ────────────────────────
{
  const h = harness(new Map(), '', {noVibrate: true});
  h.key('Enter'); h.grant();
  assert.equal(h.recorders[0].state, 'recording');
}

console.log('Nokia haptics (patterns, events, error throttle, menu toggle) checks passed');