// nokia-v08-meter.cjs — the recording level meter: feature-detected, the five bars map the
// input level, it hides on stop, and recording degrades silently when WebAudio is absent
// (KaiOS/Gecko 48 builds may lack AudioContext).
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';
const bars = h => Array.from(h.nodes.level.children).map(c => c.className);
const levelVisible = h => !h.nodes.level.hidden;
// A fake WebAudio context whose analyser serves a controlled deviation from silence.
// The engine computes level = min(1, mean|byte - 128| / 38).
function audioContext(deviations) {
  return function AudioContext() {
    let call = 0;
    const analyser = {
      fftSize: 32,
      get frequencyBinCount() { return Math.max(1, Math.floor((this.fftSize || 2) / 2)); },
      getByteTimeDomainData(data) {
        const d = deviations[Math.min(call, deviations.length - 1)]; call++;
        for (let i = 0; i < data.length; i++) data[i] = 128 + (i % 2 ? d : -d);
      },
      disconnect() {},
    };
    return {
      createAnalyser() { return analyser; },
      createMediaStreamSource() { return { connect() {} }; },
    };
  };
}

// ── Level value mapping: uiLevel maps [0,1] onto the five bars ─────────────────
{
  const h = harness();
  const K = h.context.Klaus;
  K.uiLevel(0);
  assert.ok(levelVisible(h), 'a zero level still shows the meter (quiet, not hidden)');
  assert.deepEqual(bars(h).map(c => (c ? 1 : 0)), [0, 0, 0, 0, 0], 'silence lights no bar');
  K.uiLevel(0.2);
  assert.deepEqual(bars(h).map(c => (c ? 1 : 0)), [1, 0, 0, 0, 0], '0.2 lights ceil(0.2*5)=ceil(1) = one bar');
  K.uiLevel(0.5);
  assert.deepEqual(bars(h).map(c => (c ? 1 : 0)), [1, 1, 1, 0, 0], '0.5 lights 3 bars');
  K.uiLevel(1);
  assert.ok(bars(h).every(c => c), 'full level lights all five bars');
  K.uiLevel(4);
  assert.ok(bars(h).every(c => c), 'values above 1 clamp to the full meter');
  K.uiLevel(null);
  assert.ok(h.nodes.level.hidden, 'null hides the meter again');
}
// ── No WebAudio: the meter never appears and recording is entirely unaffected ──
{
  const h = harness(new Map(), BRIDGE);
  assert.equal(h.context.window.AudioContext, undefined, 'the harness simulates a Gecko 48 build without AudioContext');
  h.key('Enter');
  assert.ok(h.nodes.level.hidden, 'no meter before the microphone');
  h.grant();
  const tick120 = Object.values(h.tickers).find(t => t.active && t.ms === 120);
  assert.equal(tick120, undefined, 'no meter timer without WebAudio');
  assert.ok(h.nodes.level.hidden, 'the meter stays hidden while recording without WebAudio');
  assert.equal(h.recorders[0].state, 'recording', 'recording itself proceeds normally');
  h.clock.t += 5000;
  h.key('Call');
  const rec = h.recorders[0];
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  assert.equal(rec.state, 'inactive', 'the clip still completes without a meter');
  assert.ok(h.nodes.level.hidden, 'still no meter after the recording');
  assert.ok(h.nodes.player.src, 'the saved clip is attached to the player');
  h.key('5');
  assert.equal(h.nodes.player.paused, false, '5 plays the recording even without WebAudio');
}
// ── With WebAudio: bars follow the input, the meter stops with the recording ──
{
  // Deviation 0, then 19 (level 0.5), then 38 (level 1): the meter tracks the input.
  // The re-armed meter below shares this array: each new AudioContext re-reads it from
  // index 0, so its first sample must be the array's 0, not the previous recording's peak.
  const h = harness(new Map(), BRIDGE);
  h.context.window.AudioContext = audioContext([0, 19, 38]);
  h.key('Enter'); h.grant();
  assert.equal(h.recorders[0].state, 'recording', 'the recorder is running');
  const tick = () => {
    const m = Object.values(h.tickers).find(t => t.active && t.ms === 120);
    assert.ok(m, 'the meter ticker runs while recording');
    m.fn();
  };
  tick();
  assert.ok(levelVisible(h), 'the meter appears on the first sample');
  assert.deepEqual(bars(h).map(c => (c ? 1 : 0)), [0, 0, 0, 0, 0], 'silence lights no bars');
  tick();
  assert.deepEqual(bars(h).map(c => (c ? 1 : 0)), [1, 1, 1, 0, 0], 'deviation 19 of 38 lights 3 bars');
  tick();
  assert.ok(bars(h).every(c => c), 'deviation 38 of 38 is full level');
  // Discarding stops the meter and releases the meter resources.
  h.key('Backspace');
  assert.ok(h.nodes.level.hidden, 'the meter hides when the recording stops');
  assert.equal(h.recorders[0].state, 'inactive', 'the recorder stops');
  const m = Object.values(h.tickers).find(t => t.active && t.ms === 120);
  assert.equal(m, undefined, 'the meter ticker is cleared with the recording');
  // A second recording re-arms the meter from a silent start.
  h.key('Enter'); h.grant();
  const tick2 = () => Object.values(h.tickers).find(t => t.active && t.ms === 120).fn();
  tick2();
  assert.ok(levelVisible(h), 'a new recording restarts the meter');
  assert.deepEqual(bars(h).map(c => (c ? 1 : 0)), [0, 0, 0, 0, 0], 're-armed from a silent start, no 38 leaked in');
  tick2();
  assert.deepEqual(bars(h).map(c => (c ? 1 : 0)), [1, 1, 1, 0, 0], 'the re-armed meter tracks its own sample (19 of 38 lights 3 bars)');
}
// ── WebAudio that throws still degrades to plain recording ─────────────────────
{
  const h = harness(new Map(), BRIDGE);
  h.context.window.AudioContext = function () { throw new Error('platform broke down'); };
  h.key('Enter');
  h.grant();
  assert.equal(h.recorders.length, 1, 'the stream still opened');
  assert.ok(h.nodes.level.hidden, 'a throwing AudioContext hides the meter, not the recording');
  h.clock.t += 2000;
  h.key('Call');
  const rec = h.recorders[0];
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  assert.equal(rec.state, 'inactive', 'a throwing WebAudio never breaks the clip');
  assert.ok(h.nodes.level.hidden);
}
// ── Silent clips never reach the bridge when the meter ran ─────────────────────
{
  const h = harness(new Map(), BRIDGE);
  h.context.window.AudioContext = audioContext([0, 0, 0]);
  h.key('Enter'); h.grant();
  const tick = () => Object.values(h.tickers).find(t => t.active && t.ms === 120).fn();
  tick(); tick(); tick();
  const before = h.xhrRequests.length;
  h.key('Call');
  const rec = h.recorders[0];
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  assert.match(h.status(), /No speech captured/, 'a silent meter refuses the send');
  assert.equal(h.xhrRequests.length, before, 'no turn is posted for a silent clip');
}
{
  const h = harness(new Map(), BRIDGE);
  h.context.window.AudioContext = audioContext([0, 19, 38]);
  h.key('Enter'); h.grant();
  const tick = () => Object.values(h.tickers).find(t => t.active && t.ms === 120).fn();
  tick(); tick(); tick();
  h.key('Call');
  const rec = h.recorders[0];
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  assert.ok(h.xhrRequests.some(r => r.url.endsWith('/turns') || r.url.endsWith('/sessions')),
    'a clip that lit the meter is still sent');
}

console.log('Nokia v08 meter (feature detection, level mapping, silent fallback) checks passed');