// nokia-v08-live.cjs — green Call starts a live talk loop: record, send, hear the
// reply, the mic opens again. Back (or Call when idle) hangs up. Not a duplex
// phone call; a walkie-talkie conversation on Gecko 48.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';
const last = (h, pred) => h.xhrRequests.filter(pred).at(-1);
const isCreate = r => r.method === 'POST' && r.url.endsWith('/sessions');
const isTurn = r => r.url.endsWith('/turns');
const isPoll = id => r => r.method === 'GET' && r.url.endsWith('/sessions/' + id);
function respond(h, req, status, body) {
  req.req.status = status;
  req.req.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  req.req.onload();
}

{
  const K = harness().context.Klaus;
  assert.equal(K.mapKey('idle', 'Call', true), 'live');
}

{
  const h = harness(new Map(), BRIDGE);
  h.key('Call');
  assert.match(h.status(), /Live/, 'Call announces live talk');
  h.grant();
  assert.equal(h.recorders[0].state, 'recording', 'live opens the microphone at once');
  h.key('Escape');
  assert.match(h.status(), /Live off/, 'Back hangs up');
  assert.equal(h.softkeys()[1], 'Talk', 'idle again after hang up');
}

{
  const h = harness(new Map(), BRIDGE);
  h.key('Call'); h.grant();
  h.key('Call');
  const rec = h.recorders[0];
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  respond(h, last(h, isCreate), 201, {id: 'srv-live'});
  respond(h, last(h, isTurn), 202, {runId: 'r-live', state: 'pending'});
  h.pollTimers[h.activePolls().at(-1)].fn();
  respond(h, last(h, isPoll('srv-live')), 200, {
    state: 'complete', runId: 'r-live',
    messages: [{role: 'user', text: 'hi'}, {role: 'assistant', text: 'Hello there.'}],
  });
  h.finishSpeech();
  assert.ok(h.requests.length >= 2, 'live asks for the microphone again after the reply');
  h.grant();
  assert.equal(h.recorders.length, 2, 'after the reply is spoken, live opens the mic again');
  assert.equal(h.recorders[1].state, 'recording');
}

console.log('Nokia v08 live (Call loop, hang up, resume after reply) checks passed');
