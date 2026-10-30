// nokia-v08-feel.cjs — the marvellous pass: synthesized interface blips (muted from the
// menu, absent WebAudio degrades to silence), the light per-key haptic, the half-second
// launch card that any key skips at once AND still acts, the reply pop class, and the
// short CSS animations (pop under 300 ms, night palette on the new surfaces).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';
const css = () => fs.readFileSync(path.join(__dirname, '../configs/nokia-klaus/style.css'), 'utf8');
const last = (h, pred) => h.xhrRequests.filter(pred).at(-1);
const isCreate = r => r.method === 'POST' && r.url.endsWith('/sessions');
const isTurn = r => r.url.endsWith('/turns');
const isPoll = id => r => r.method === 'GET' && r.url.endsWith('/sessions/' + id);
function respond(h, req, status, body) {
  req.req.status = status;
  req.req.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  req.req.onload();
}
// A fake WebAudio context that records the frequency of every oscillator start, so the
// blip sequences (key 660, start 520-780, pause 440, send 660-990, reply 1046-1318,
// note 880) are assertable by value without exposing the sound table.
function soundFake() {
  const log = [];
  const Ctor = function () {
    return {
      currentTime: 0,
      destination: {},
      createOscillator() {
        return { type: '', frequency: {value: 0}, connect() {}, start() { log.push(this.frequency.value); }, stop() {} };
      },
      createGain() { return { gain: {value: 0}, connect() {} }; },
    };
  };
  return {Ctor, log};
}

// ── The key haptic: one light pulse, unique, silent when haptics are off ─────────
{
  const K = harness().context.Klaus;
  const p = K.HAPTICS;
  assert.ok(Array.isArray(p.key) && p.key.length >= 1, 'a key pattern exists');
  const total = p.key.reduce((a, b) => a + b, 0);
  assert.ok(total >= 8 && total <= 40, `the key tick is very light (${total} ms)`);
  const shapes = Object.keys(p).map(kd => JSON.stringify(p[kd]));
  assert.equal(new Set(shapes).size, Object.keys(p).length, 'every haptic pattern stays unique with key added');
  for (const kd of Object.keys(p)) {
    assert.ok(p[kd].reduce((a, b) => a + b, 0) <= 600, `${kd} stays short`);
  }
  const h = harness(new Map(), BRIDGE);
  const K2 = JSON.parse(JSON.stringify(h.context.Klaus.HAPTICS));
  h.key('SoftLeft');
  assert.deepEqual(h.vibrations, [K2.key], 'one mapped key press fires exactly one light tick');
  h.key('SoftRight');
  assert.deepEqual(h.vibrations.at(-1), K2.key, 'the tick fires once per press, no cascade');
}
// ── Sounds: distinct blips per event, feature-detect, menu mute, persistence ──────
{
  const h = harness();
  const f = soundFake();
  h.context.window.AudioContext = f.Ctor;
  h.key('SoftLeft');
  assert.deepEqual(f.log, [660], 'an acting key gives the single light tick');
  h.key('Backspace'); // leave typing; that key also acts
  const b0 = f.log.length;
  h.key('Enter');
  h.grant();
  assert.deepEqual(f.log.slice(b0), [660, 520, 780], 'record start is the rising pair after its key tick');
  const before = f.log.length;
  h.key('Enter'); // pause (the fake recorder has no pause(), so this stops and keeps)
  assert.deepEqual(f.log.slice(before), [660, 440], 'pause is the low note');
  const before2 = f.log.length;
  h.key('Call');
  const rec = h.recorders[0];
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  assert.deepEqual(f.log.slice(before2), [660, 660, 990], 'send is the firm rising pair');
  h.finishSpeech();
}
{
  const h = harness(new Map(), BRIDGE);
  const f = soundFake();
  h.context.window.AudioContext = f.Ctor;
  h.key('SoftLeft'); h.composer.value = 'chime'; h.key('Enter');
  respond(h, last(h, isCreate), 201, {id: 'srv-feel'});
  respond(h, last(h, isTurn), 202, {runId: 'r-feel', state: 'pending'});
  const id = h.activePolls().at(-1);
  h.pollTimers[id].fn();
  const before = f.log.length;
  respond(h, last(h, isPoll('srv-feel')), 200, {state: 'complete', runId: 'r-feel', messages: [{role: 'user', text: 'chime'}, {role: 'assistant', text: 'here.'}]});
  assert.deepEqual(f.log.slice(before), [1046, 1318], 'a new reply gives the distinct two-note chime, not the save blip');
  h.finishSpeech();
}
{
  const h = harness();
  h.key('Enter'); h.grant();
  assert.equal(h.recorders.length, 1, 'no AudioContext: recording unaffected and nothing throws');
}
{
  const h = harness();
  h.context.window.AudioContext = function () { throw new Error('platform broke down'); };
  h.key('Enter');
  h.grant();
  assert.equal(h.recorders[0].state, 'recording', 'a throwing AudioContext degrades to silence, not an error');
  const before = h.vibrations.length;
  h.key('Enter'); // pause; the sound path must stay dead without breaking the flow
  assert.equal(h.vibrations.length, before + 2, 'key tick plus pause pattern still fire after the sound died');
}
{
  const storage = new Map();
  const h = harness(storage);
  h.key('SoftRight');
  for (let i = 0; i < 10; i++) h.key('ArrowDown');
  h.key('Enter');
  assert.equal(h.status(), 'Sound off.');
  assert.equal(storage.get('klaus.sound'), '0', 'the mute persists');
  const again = harness(storage);
  const f = soundFake();
  again.context.window.AudioContext = f.Ctor;
  again.key('SoftLeft');
  assert.equal(f.log.length, 0, 'switched off: a key press produces no blip');
  again.key('Backspace'); // leave typing (empty input exits), Sound is still off
  again.key('SoftRight');
  for (let i = 0; i < 10; i++) again.key('ArrowDown');
  again.key('Enter');
  assert.equal(again.status(), 'Sound on.');
  assert.equal(f.log.at(-1), 660, 'switching on gives a sample blip');
  assert.equal(storage.get('klaus.sound'), '1');
}
// ── Launch card: time + one line of the day, any key skips it and still acts ──────
{
  const h = harness();
  assert.ok(!h.nodes.launch.hidden, 'the card shows at launch before any key');
  const d = new Date(h.clock.t);
  const expectTime = d.getHours() + (d.getMinutes() < 10 ? ':0' : ':') + d.getMinutes();
  assert.equal(h.nodes['launch-time'].textContent, expectTime, 'the card carries the clock time');
  assert.equal(h.nodes['launch-line'].textContent, 'Conversation 1', 'an empty chat shows its title as the one line');
  assert.match(h.nodes['launch-hint'].textContent, /ready.*OK to talk/i, 'the ready hint invites the first press');
  assert.match(h.nodes.hhand.style.transform, /rotate\(/, 'the analog hour hand is set from the clock');
  const before = h.vibrations.length;
  h.key('Enter');
  assert.ok(h.nodes.launch.hidden, 'the first key press dismisses the card at once');
  assert.deepEqual(h.vibrations.slice(before), [JSON.parse(JSON.stringify(h.context.Klaus.HAPTICS)).key], 'the skipping key still gets its tick');
  assert.equal(h.requests.length, 1, 'and its action still runs: the microphone opened');
  h.grant();
  assert.equal(h.recorders[0].state, 'recording', '…all the way through to recording');
  // The card never reappears: its timer now only runs its one hide.
  const tick = Object.values(h.tickers).find(t => t.active && t.ms === 500);
  if (tick) tick.fn();
  assert.ok(h.nodes.launch.hidden, 'even if its timer fires late, the card stays down');
}
{
  const h = harness();
  assert.ok(!h.nodes.launch.hidden);
  const tick = Object.values(h.tickers).find(t => t.active && t.ms === 500);
  assert.ok(tick, 'the half-second timer is armed');
  tick.fn();
  assert.ok(h.nodes.launch.hidden, 'the card auto-dismisses after its half second');
  h.key('SoftLeft');
  assert.equal(h.composer, h.context.document.activeElement, 'the app underneath is usable in the meantime');
}
{
  const SKEY = 'klaus.sessions.v2';
  const NOW = 1700000000000;
  const storage = new Map();
  const text = 'check the oven and then water the ferns on the balcony';
  const fullLine = 'Plan \u00b7 ' + text;
  storage.set(SKEY, JSON.stringify([{
    id: 'a', title: 'Plan', clientId: 'c-a', serverId: null, serverState: 'idle',
    messages: [{role: 'user', text: text}],
    pinned: false, named: true, archived: false, updatedAt: NOW,
    runId: null, lastRequestId: null, cancelRequestId: null, pendingSince: 0, lastText: null,
    uploadPending: false, textPending: false, voiceTurns: [], outboxId: null,
  }]));
  storage.set(SKEY + '.active', 'a');
  const h = harness(storage);
  const clipped = fullLine.length > 44 ? fullLine.slice(0, 43) + '\u2026' : fullLine;
  assert.equal(clipped.length, 44, 'the clip target is one screen line');
  assert.equal(h.nodes['launch-line'].textContent, clipped, 'the one line is the newest message, clipped for the screen');
}
// ── Reply pop: the newest arriving assistant row pops once, then settles ──────────
{
  const h = harness(new Map(), BRIDGE);
  h.key('SoftLeft'); h.composer.value = 'pop'; h.key('Enter');
  respond(h, last(h, isCreate), 201, {id: 'srv-pop'});
  respond(h, last(h, isTurn), 202, {runId: 'r-pop', state: 'pending'});
  h.pollTimers[h.activePolls().at(-1)].fn();
  respond(h, last(h, isPoll('srv-pop')), 200, {state: 'pending', messages: [{role: 'user', text: 'pop'}]});
  const userRows = () => h.nodes.transcript.children.filter(c => /\bmsg\b/.test(c.className));
  assert.ok(!userRows().some(c => /\bpop\b/.test(c.className)), 'no pop before a reply arrives');
  h.pollTimers[h.activePolls().at(-1)].fn();
  respond(h, last(h, isPoll('srv-pop')), 200, {state: 'complete', runId: 'r-pop', messages: [{role: 'user', text: 'pop'}, {role: 'assistant', text: 'settled.'}]});
  const rows = userRows();
  assert.ok(/\bpop\b/.test(rows.at(-1).className), 'the newest assistant row pops in');
  assert.ok(!/\bpop\b/.test(rows.at(-2).className), 'the older row is untouched');
  const tick = Object.values(h.tickers).find(t => t.active && t.ms === 250);
  assert.ok(tick, 'the pop is cleared by its own short timer');
  tick.fn();
  assert.ok(!userRows().some(c => /\bpop\b/.test(c.className)), 'the class is gone once the pop settles');
  h.finishSpeech();
}
// ── CSS: one pop and one slide animation, both short, night on the new surfaces ──
{
  const c = css();
  assert.match(c, /@keyframes row-pop \{ from \{ opacity: 0\.4; transform: scale\(0\.98\); \} to \{ opacity: 1; transform: scale\(1\); \} \}/, 'the pop keyframe exists');
  assert.match(c, /\.msg\.bot\.pop \.bubble \{ animation: row-pop 220ms ease-out; \}/, 'the pop is on the new reply bubble only, 220 ms');
  assert.match(c, /#overlay:not\(\.hidden\) \{ animation: overlay-slide 160ms ease-out; \}/, 'the overlay slides in for 160 ms');
  const durations = [...c.matchAll(/animation: [a-z-]+ (\d+)ms/g)].map(m => Number(m[1]));
  assert.ok(durations.length >= 2 && durations.every(ms => ms <= 300), 'every animation stays under 300 ms: ' + durations.join(','));
  assert.match(c, /\.night #launch \{[^}]*\}/, 'the launch card has a night palette');
  assert.match(c, /\.night #upload \{[^}]*\}/, 'the upload bar has a night palette');
  assert.match(c, /#clock \{/, 'the launch card carries an analog clock');
  assert.match(c, /@keyframes mint-flash/, 'a reply flash keyframe exists');
}
// ── Hold-to-talk: a long Centre press sends on release ─────────────────────────
{
  const h = harness(new Map(), BRIDGE);
  h.key('Enter'); h.grant();
  assert.equal(h.recorders[0].state, 'recording');
  h.clock.t += 500;
  h.handlers.keyup({key: 'Enter'});
  const rec = h.recorders[0];
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  assert.ok(h.xhrRequests.some(r => r.url.endsWith('/sessions') || r.url.endsWith('/turns')),
    'releasing a held Centre key sends the clip');
}
{
  const h = harness(new Map(), BRIDGE);
  h.key('Enter'); h.grant();
  h.handlers.keyup({key: 'Enter'}); // a tap: too short to send
  assert.equal(h.recorders[0].state, 'recording', 'a short tap still starts a recording you can pause');
  assert.ok(!h.xhrRequests.some(r => r.url.endsWith('/turns')), 'a tap does not send');
}
// ── Arrival flash ─────────────────────────────────────────────────────────────
{
  const h = harness(new Map(), BRIDGE);
  h.key('SoftLeft'); h.composer.value = 'flash'; h.key('Enter');
  respond(h, last(h, isCreate), 201, {id: 'srv-fl'});
  respond(h, last(h, isTurn), 202, {runId: 'r-fl', state: 'pending'});
  h.pollTimers[h.activePolls().at(-1)].fn();
  respond(h, last(h, isPoll('srv-fl')), 200, {state: 'complete', runId: 'r-fl', messages: [{role: 'user', text: 'flash'}, {role: 'assistant', text: 'boom'}]});
  assert.match(h.nodes.flash.className, /\bon\b/, 'a new reply flashes the screen');
  h.finishSpeech();
}

console.log('Nokia v08 feel (sounds, key tick, launch card, reply pop, motion) checks passed');