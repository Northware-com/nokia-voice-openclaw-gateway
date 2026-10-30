// nokia-v08-upload.cjs — the voice-upload progress bar: hidden until the XHR actually
// reports bytes (lengthComputable events only), tracks loaded/total as a width, hides on
// a clean 2xx acknowledgement and on failure without breaking the queued-resend path.
// Typed text produces no upload progress at all.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';
const fill = h => h.nodes.upload.firstElementChild.style.width;
const last = (h, pred) => h.xhrRequests.filter(pred).at(-1);
const isCreate = r => r.method === 'POST' && r.url.endsWith('/sessions');
const isTurn = r => r.url.endsWith('/turns');
function respond(h, req, status, body) {
  req.req.status = status;
  req.req.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  req.req.onload();
}
// Record a clip and send it, then answer the session create so the audio turns POST is
// issued and left pending for the upload events to be dispatched against.
function recordAndSend(h, serverId) {
  h.key('Enter'); h.grant();
  h.key('Call');
  const rec = h.recorders[0];
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  respond(h, last(h, isCreate), 201, {id: serverId});
}

// ── Voice upload: hidden until bytes, then the fill tracks the bytes ─────────────
{
  const h = harness(new Map(), BRIDGE);
  assert.ok(h.nodes.upload.hidden, 'the bar is hidden before any upload');
  recordAndSend(h, 'srv-up');
  const turn = last(h, isTurn);
  assert.ok(turn, 'the clip is POSTed to the session turns endpoint');
  assert.ok(turn.body instanceof Blob, 'the upload body is the recorded clip, not JSON');
  assert.ok(h.nodes.upload.hidden, 'still hidden before the XHR reports bytes');
  turn.req.upload.onprogress({lengthComputable: false, loaded: 0, total: 0});
  assert.ok(h.nodes.upload.hidden, 'an indeterminate event neither lights nor fakes the bar');
  turn.req.upload.onprogress({lengthComputable: true, loaded: 25, total: 100});
  assert.ok(!h.nodes.upload.hidden, 'the bar appears on the first measurable event');
  assert.equal(fill(h), '25%', 'a quarter of the clip lights a quarter of the width');
  turn.req.upload.onprogress({lengthComputable: true, loaded: 33, total: 100});
  assert.equal(fill(h), '33%', 'the fill follows the transport, not a guess');
  turn.req.upload.onprogress({lengthComputable: true, loaded: 100, total: 100});
  assert.equal(fill(h), '100%', 'a complete upload shows full width');
  respond(h, turn, 202, {runId: 'r-up', state: 'pending'});
  assert.ok(h.nodes.upload.hidden, 'the bar hides once the bridge acknowledges');
  h.finishSpeech();
}
// ── Failure: the bar hides and the clip stays queued for the honest resend ────────
{
  const h = harness(new Map(), BRIDGE);
  recordAndSend(h, 'srv-up2');
  const turn = last(h, isTurn);
  turn.req.upload.onprogress({lengthComputable: true, loaded: 10, total: 200});
  assert.equal(fill(h), '5%', 'a partial upload shows its true fraction');
  turn.req.onerror();
  assert.ok(h.nodes.upload.hidden, 'a failed upload hides the bar without a hang');
  assert.match(h.status(), /Will resend when back online/, 'the queued resend is reported by the notice');
  h.finishSpeech();
}
// ── Typed text: no upload progress surface is involved ───────────────────────────
{
  const h = harness(new Map(), BRIDGE);
  h.key('SoftLeft'); h.composer.value = 'hello'; h.key('Enter');
  respond(h, last(h, isCreate), 201, {id: 'srv-ut'});
  const turn = last(h, isTurn);
  assert.ok(turn, 'the text turn is POSTed');
  assert.notStrictEqual(typeof turn.req.upload.onprogress, 'function', 'typed text installs no upload progress handler');
  assert.ok(h.nodes.upload.hidden, 'the bar is untouched by a text turn');
  respond(h, turn, 202, {runId: 'r-ut', state: 'pending'});
  assert.ok(h.nodes.upload.hidden, 'still untouched after the acknowledgment');
  h.finishSpeech();
}

console.log('Nokia v08 upload (byte tracking, hide on resolve, no text progress) checks passed');