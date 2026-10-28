// nokia-chat-ui.cjs — chat screen, softkey states, Centre pause / Call send, typing, menu and key-map checks.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';

function respond(h, req, status, body) {
  req.req.status = status;
  req.req.responseText = typeof body === 'string' ? body : JSON.stringify(body);
  req.req.onload();
}
const last = (h, pred) => h.xhrRequests.filter(pred).at(-1);
const isCreate = r => r.method === 'POST' && r.url.endsWith('/sessions');
const isTurn = r => r.url.endsWith('/turns');
const isPoll = id => r => r.method === 'GET' && r.url.endsWith('/sessions/' + id);
function firePoll(h) { const id = h.activePolls().at(-1); assert.ok(id, 'a poll must be scheduled'); h.pollTimers[id].fn(); }
function tick(h) { Object.keys(h.tickers).filter(id => h.tickers[id].active).forEach(id => h.tickers[id].fn()); }
function connectedTurn(h, id, sendKeys) {
  sendKeys();
  respond(h, last(h, isCreate), 201, {id});
  respond(h, last(h, isTurn), 202, {runId: 'run-' + id, state: 'pending'});
}
function record(h) {
  h.key('Enter'); h.grant(); h.key('Call');
  const rec = h.recorders.at(-1);
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
}

// ── Pure key map / helpers ─────────────────────────────────────────────────
{
  const K = harness().context.Klaus;
  assert.equal(K.mapKey('idle', 'SoftLeft', true), 'type');
  assert.equal(K.mapKey('idle', 'SoftRight', true), 'menu');
  assert.equal(K.mapKey('idle', 'Enter', true), 'talk');
  for (const [key, action] of [['4', 'prev'], ['6', 'next'], ['ArrowLeft', 'prev'], ['ArrowRight', 'next'],
    ['1', 'top'], ['9', 'bottom'], ['2', 'pageUp'], ['8', 'pageDown'], ['5', 'read'], ['0', 'autoread'], ['#', 'sessions']]) {
    assert.equal(K.mapKey('idle', key, true), action, `idle ${key}`);
  }
  assert.equal(K.mapKey('typing', '3', false), 'none', 'digits type into the composer');
  assert.equal(K.mapKey('typing', '5', true), 'none');
  assert.equal(K.mapKey('typing', 'Backspace', false), 'none', 'Backspace deletes text');
  assert.equal(K.mapKey('typing', 'Backspace', true), 'exitInput', 'Backspace on empty input leaves typing');
  assert.equal(K.mapKey('typing', 'SoftRight', false), 'voice');
  assert.equal(K.mapKey('typing', 'Call', false), 'send', 'Call sends typed text');
  assert.equal(K.mapKey('recording', 'Enter', true), 'pause');
  assert.equal(K.mapKey('recording', 'Call', true), 'send');
  assert.equal(K.mapKey('recording', 'SoftLeft', true), 'cancel');
  assert.equal(K.mapKey('recording', 'Backspace', true), 'discard');
  assert.equal(K.mapKey('paused', 'Enter', true, true), 'resume');
  assert.equal(K.mapKey('paused', 'Enter', true, false), 'send', 'Centre sends when pause is unsupported');
  assert.equal(K.mapKey('paused', 'Call', true, true), 'send');
  assert.equal(K.mapKey('paused', 'SoftRight', true, true), 'send', 'SoftRight is the fallback Send');
  assert.equal(K.mapKey('paused', 'SoftLeft', true, true), 'cancel');
  assert.equal(K.mapKey('paused', 'Backspace', true, true), 'discard');
  assert.equal(K.mapKey('idle', 'Call', true), 'none', 'Call is left to the system when idle');
  assert.equal(K.LONG_PRESS_MS, undefined, 'no long-press threshold');
  assert.equal(K.mapKey('recording', '3', true), 'none');
  assert.equal(K.mapKey('menu', 'Enter', true), 'select');
  assert.equal(K.mapKey('menu', 'Backspace', true), 'close');
  assert.equal(K.mapKey('confirm', '7', true), 'select');
  assert.deepEqual(Array.from(K.softkeysFor('idle', '')), ['Type', 'Talk', 'Menu']);
  assert.deepEqual(Array.from(K.softkeysFor('recording', '0:07')), ['Cancel', 'Pause', '0:07']);
  assert.deepEqual(Array.from(K.softkeysFor('paused', '0:07', true)), ['Delete', 'Resume', 'Send']);
  assert.deepEqual(Array.from(K.softkeysFor('paused', '0:07', false)), ['Delete', 'Send', 'Send']);
  assert.deepEqual(Array.from(K.softkeysFor('typing', '')), ['Clear', 'Send', 'Voice']);
  assert.deepEqual(Array.from(K.softkeysFor('menu', '')), ['Close', 'Select', '']);
  assert.equal(K.moveFocus(-1, 3, -1), 2, 'Up from live selects newest');
  assert.equal(K.moveFocus(0, 3, -1), 0, 'Up stops at oldest');
  assert.equal(K.moveFocus(2, 3, 1), -1, 'Down past newest returns to live');
  assert.equal(K.moveFocus(-1, 0, -1), -1);
  assert.equal(K.formatElapsed(7000), '0:07');
  assert.equal(K.formatElapsed(75000), '1:15');
  assert.ok(K.pollDelay(0) < K.pollDelay(1) && K.pollDelay(1) < K.pollDelay(3), 'poll delay backs off');
  assert.equal(K.pollDelay(50), 8000, 'poll delay is capped');
  assert.equal(K.detectLang('Hvad er klokken på Mars?'), 'da');
  assert.equal(K.detectLang('Jeg har ikke tid i dag'), 'da');
  assert.equal(K.detectLang('What time is it on Mars?'), 'en');
  assert.equal(K.ttsLang('Tak for hjælpen', [{lang: 'en-US'}, {lang: 'da-DK'}]), 'da-DK');
  assert.equal(K.ttsLang('Tak for hjælpen', [{lang: 'en-US'}]), 'en-US', 'falls back without a Danish voice');
  assert.equal(K.ttsLang('Thanks a lot', [{lang: 'da-DK'}]), 'en-US');
}

// ── Screen chrome and softkeys per state ───────────────────────────────────
{
  const h = harness();
  assert.equal(h.nodes['session-index'].textContent, '1/1');
  assert.equal(h.nodes['session-title'].textContent, 'Conversation 1');
  assert.equal(h.conn(), 'NOT CONNECTED');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu']);
  assert.ok(h.nodes.status.hidden, 'No hint/status line when idle');
  h.key('Enter');
  assert.deepEqual(h.softkeys(), ['Cancel', 'Pause', '0:00']);
  h.grant(); h.clock.t += 7000; tick(h);
  assert.deepEqual(h.softkeys(), ['Cancel', 'Pause', '0:07'], 'recording timer is live');
  h.key('SoftLeft');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu'], 'SoftLeft cancels recording');
  assert.equal(h.recorders[0].state, 'inactive');
  h.key('SoftRight');
  assert.deepEqual(h.softkeys(), ['Close', 'Select', '']);
  assert.ok(!h.nodes.overlay.hidden);
  h.key('Backspace');
  assert.ok(h.nodes.overlay.hidden);
  h.key('SoftLeft');
  assert.deepEqual(h.softkeys(), ['Clear', 'Send', 'Voice']);
  assert.equal(h.context.document.activeElement, h.composer, 'SoftLeft focuses the composer');
}

// ── Centre pauses / resumes, Call sends, Backspace discards ─────────────────
function pausable(rec) {
  rec.pause = () => { rec.state = 'paused'; };
  rec.resume = () => { rec.state = 'recording'; };
}
{
  // Gecko with pause(): Centre pauses and resumes; the timer excludes paused time.
  const h = harness(new Map(), BRIDGE);
  const RealMR = h.context.MediaRecorder;
  h.context.MediaRecorder = function(s) { RealMR.call(this, s); pausable(this); };
  h.key('Enter'); h.grant();
  const rec = h.recorders[0];
  h.clock.t += 7000; h.key('Enter');
  assert.equal(rec.state, 'paused', 'Centre pauses');
  assert.deepEqual(h.softkeys(), ['Delete', 'Resume', 'Send']);
  assert.equal(h.status(), 'Paused 0:07');
  h.clock.t += 60000; tick(h);
  assert.deepEqual(h.softkeys(), ['Delete', 'Resume', 'Send'], 'timer frozen while paused');
  h.key('Enter');
  assert.equal(rec.state, 'recording', 'Centre resumes');
  h.clock.t += 2000; tick(h);
  assert.deepEqual(h.softkeys(), ['Cancel', 'Pause', '0:09'], 'timer continues from paused time');
  h.key('Call');
  assert.equal(rec.state, 'inactive', 'Call stops to send');
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  respond(h, last(h, isCreate), 201, {id: 'srv-p'});
  assert.ok(last(h, isTurn), 'clip is uploaded');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu']);
}
{
  // Pause from paused via SoftRight fallback Send.
  const h = harness(new Map(), BRIDGE);
  const RealMR = h.context.MediaRecorder;
  h.context.MediaRecorder = function(s) { RealMR.call(this, s); pausable(this); };
  h.key('Enter'); h.grant(); h.key('Enter');
  h.key('SoftRight');
  assert.equal(h.recorders[0].state, 'inactive', 'SoftRight sends while paused');
}
{
  // No pause() support: Centre stops and keeps the clip; nothing is sent until Send.
  const h = harness(new Map(), BRIDGE);
  h.key('Enter'); h.grant();
  const rec = h.recorders[0];
  h.clock.t += 4000; h.key('Enter');
  assert.equal(rec.state, 'inactive', 'fallback pause stops the recorder');
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  assert.equal(h.xhrRequests.filter(isTurn).length, 0, 'held clip is not sent yet');
  assert.ok(!h.xhrRequests.some(isCreate), 'no session created yet');
  assert.deepEqual(h.softkeys(), ['Delete', 'Send', 'Send']);
  assert.equal(h.status(), 'Paused 0:04');
  h.key('Call');
  respond(h, last(h, isCreate), 201, {id: 'srv-held'});
  assert.ok(last(h, isTurn), 'Call sends the held clip');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu']);
}
{
  // Send pressed before the fallback stop completed still sends.
  const h = harness(new Map(), BRIDGE);
  h.key('Enter'); h.grant();
  const rec = h.recorders[0];
  h.key('Enter'); h.key('Call');
  rec.ondataavailable({data: new Blob(['OggS'])}); rec.onstop();
  respond(h, last(h, isCreate), 201, {id: 'srv-race'});
  assert.ok(last(h, isTurn), 'in-flight stop delivers the clip');
}
{
  // Call before mic permission still sends once the recorder starts.
  const h = harness();
  h.key('Enter'); h.key('Call');
  h.grant();
  assert.equal(h.recorders[0].state, 'inactive', 'Send before the mic opens stops once it starts');
}
{
  // Backspace discards short clips at once and asks again for clips over 3 s.
  const h = harness();
  h.key('Enter'); h.grant(); h.clock.t += 2000;
  h.key('Backspace');
  assert.equal(h.recorders[0].state, 'inactive', 'short clip discarded immediately');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu']);
  h.key('Enter'); h.grant(); h.clock.t += 5000;
  h.key('Backspace');
  assert.equal(h.recorders[1].state, 'recording', 'long clip needs confirmation');
  assert.match(h.status(), /Back again/);
  h.key('Backspace');
  assert.equal(h.recorders[1].state, 'inactive', 'second Backspace discards');
  assert.equal(h.status(), 'Recording discarded.');
}
{
  // Typing: Call sends the typed text.
  const h = harness(new Map(), BRIDGE);
  h.key('SoftLeft'); h.composer.value = 'via call';
  h.key('Call');
  respond(h, last(h, isCreate), 201, {id: 'srv-call'});
  assert.deepEqual(JSON.parse(last(h, isTurn).body), {text: 'via call'});
}

// ── Typing: JSON text turn, Backspace semantics, digits not intercepted ────
{
  const h = harness(new Map(), BRIDGE);
  h.key('SoftLeft');
  assert.equal(h.key('3'), false, 'digit not intercepted while typing');
  assert.equal(h.nodes['session-index'].textContent, '1/1', 'no new session from 3 while typing');
  h.composer.value = 'hej med dig';
  assert.equal(h.key('Backspace'), false, 'Backspace with text is left to the input');
  h.key('Enter');
  respond(h, last(h, isCreate), 201, {id: 'srv-text'});
  const turn = last(h, isTurn);
  assert.equal(turn.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(turn.body), {text: 'hej med dig'});
  assert.equal(h.composer.value, '', 'composer cleared after send');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu'], 'back to idle after send');
  assert.equal(h.nodes.echo.textContent, 'hej med dig', 'typed text echoed while pending');
  assert.match(h.thinking(), /^sending/);
  respond(h, turn, 202, {runId: 'r1', state: 'pending'});
  assert.match(h.thinking(), /^thinking ·/);
  h.clock.t += 12000; tick(h);
  assert.match(h.thinking(), /0:12$/, 'thinking bubble shows elapsed time');
}
{
  const h = harness();
  h.key('SoftLeft');
  assert.equal(h.key('Backspace'), true, 'Backspace on empty input is consumed');
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu'], 'and exits typing');
  assert.equal(h.context.document.activeElement, null);
}

// ── Incremental transcript, thinking cleared, message focus ────────────────
{
  const h = harness(new Map(), BRIDGE);
  connectedTurn(h, 'srv-inc', () => record(h));
  firePoll(h);
  respond(h, last(h, isPoll('srv-inc')), 200, {state: 'pending', messages: [{role: 'user', text: 'one'}]});
  const firstRow = h.nodes.transcript.children[0];
  assert.equal(firstRow.className, 'msg user');
  firePoll(h);
  respond(h, last(h, isPoll('srv-inc')), 200, {state: 'complete',
    messages: [{role: 'user', text: 'one'}, {role: 'assistant', text: 'two'}]});
  assert.equal(h.nodes.transcript.children[0], firstRow, 'existing rows are kept, not re-rendered');
  assert.equal(h.nodes.transcript.children[1].className, 'msg bot');
  assert.equal(h.thinking(), '', 'thinking bubble hidden once complete');
  assert.equal(h.activePolls().length, 0, 'polling stops once complete');
  h.key('ArrowUp');
  assert.match(h.nodes.transcript.children[1].className, /\bsel\b/, 'Up focuses newest message');
  assert.ok(h.nodes.transcript.children[1].scrolledIntoView);
  h.key('1');
  assert.match(h.nodes.transcript.children[0].className, /\bsel\b/, '1 jumps to the top');
  assert.doesNotMatch(h.nodes.transcript.children[1].className, /\bsel\b/);
  const before = h.utterances.length;
  h.key('5');
  assert.equal(h.utterances.at(-1).text, 'one', '5 reads the selected message');
  assert.ok(h.utterances.length > before);
  h.key('9');
  assert.doesNotMatch(h.nodes.transcript.children[0].className, /\bsel\b/, '9 returns to newest/live');
}

// ── Auto-read toggle and Danish TTS ────────────────────────────────────────
{
  const h = harness(new Map(), BRIDGE, {voices: [{lang: 'en-US'}, {lang: 'da-DK'}]});
  h.key('0');
  assert.match(h.status(), /Read aloud off/);
  connectedTurn(h, 'srv-quiet', () => record(h));
  firePoll(h);
  respond(h, last(h, isPoll('srv-quiet')), 200, {state: 'complete',
    messages: [{role: 'user', text: 'q'}, {role: 'assistant', text: 'Hej, jeg er her og klar til at hjælpe.'}]});
  assert.equal(h.utterances.length, 0, 'auto-read off: reply not spoken');
  h.key('5');
  assert.equal(h.utterances.at(-1).lang, 'da-DK', 'Danish reply spoken with Danish voice');
  const reload = harness(h.storage);
  reload.key('SoftRight');
  assert.ok(reload.nodes['overlay-list'].textContent.includes('Read aloud: off'), 'setting persists');
}

// ── Sessions: 4/6 switch, # list overlay ───────────────────────────────────
{
  const h = harness();
  h.key('3'); h.key('3');
  assert.equal(h.nodes['session-index'].textContent, '3/3');
  h.key('4');
  assert.equal(h.nodes['session-index'].textContent, '2/3');
  h.key('6'); h.key('6');
  assert.equal(h.nodes['session-index'].textContent, '1/3', '6 wraps');
  h.key('#');
  assert.deepEqual(h.softkeys(), ['Close', 'Open', '']);
  assert.equal(h.nodes['overlay-list'].children.length, 3);
  assert.equal(h.nodes['overlay-list'].children[0].className, 'item sel', 'list starts on current chat');
  h.key('ArrowDown'); h.key('ArrowDown'); h.key('Enter');
  assert.equal(h.nodes['session-index'].textContent, '3/3');
  assert.ok(h.nodes.overlay.hidden);
}

// ── Menu: New chat, Rename, Archive with confirm, Retry last ───────────────
{
  const h = harness();
  h.key('SoftRight'); h.key('Enter'); // New chat
  assert.equal(h.nodes['session-index'].textContent, '2/2');
  h.key('SoftRight'); h.key('ArrowDown'); h.key('Enter'); // Rename
  assert.deepEqual(h.softkeys(), ['Clear', 'Save', 'Cancel']);
  assert.equal(h.composer.value, 'Conversation 2');
  h.composer.value = 'Shopping list';
  h.key('Enter');
  assert.equal(h.nodes['session-title'].textContent, 'Shopping list');
  assert.equal(h.composer.value, '');
  h.key('SoftRight'); h.key('ArrowDown'); h.key('ArrowDown'); h.key('Enter'); // Archive
  assert.deepEqual(h.softkeys(), ['Cancel', 'Archive', '']);
  h.key('Backspace');
  assert.equal(h.nodes['session-index'].textContent, '2/2', 'confirm cancelled');
  h.key('SoftRight'); h.key('ArrowDown'); h.key('ArrowDown'); h.key('Enter'); h.key('Enter');
  assert.equal(h.nodes['session-index'].textContent, '1/1', 'archived after confirm');
  const stored = JSON.parse(h.storage.get('klaus.sessions.v2'));
  assert.ok(stored.find(s => s.title === 'Shopping list').archived);
}
{
  const h = harness(new Map(), BRIDGE);
  h.key('SoftLeft'); h.composer.value = 'retry me'; h.key('Enter');
  last(h, isCreate).req.onerror();
  assert.match(h.status(), /Could not reach Klaus/);
  assert.equal(h.thinking(), '', 'no thinking bubble after failed send');
  h.key('SoftRight'); h.key('ArrowUp'); h.key('ArrowUp'); h.key('Enter'); // Retry last (index 3)
  const create = last(h, isCreate);
  respond(h, create, 201, {id: 'srv-retry'});
  assert.deepEqual(JSON.parse(last(h, isTurn).body), {text: 'retry me'}, 'Retry resends the last text');
}

// ── Poll timeout with backoff ──────────────────────────────────────────────
{
  const h = harness(new Map(), BRIDGE, {config: {pollTimeoutMs: 5000}});
  connectedTurn(h, 'srv-slow', () => record(h));
  const delays = [];
  for (let i = 0; i < 3; i++) {
    const id = h.activePolls().at(-1);
    delays.push(h.pollTimers[id].ms);
    firePoll(h);
    respond(h, last(h, isPoll('srv-slow')), 200, {state: 'pending', messages: []});
  }
  assert.ok(delays[0] < delays[1] && delays[1] < delays[2], 'poll interval backs off: ' + delays);
  h.clock.t += 6000;
  firePoll(h);
  assert.equal(h.activePolls().length, 0, 'polling stops after the configured timeout');
  assert.match(h.thinking(), /no reply yet/);
  const polls = h.xhrRequests.filter(isPoll('srv-slow')).length;
  h.key('SoftRight'); h.key('ArrowUp'); h.key('ArrowUp'); h.key('Enter'); // Retry last
  assert.equal(h.activePolls().length, 1, 'Retry last resumes polling');
  firePoll(h);
  assert.equal(h.xhrRequests.filter(isPoll('srv-slow')).length, polls + 1);
}

// ── Offline clip kept for retry; Back with nothing to cancel exits ─────────
{
  const h = harness();
  record(h);
  assert.match(h.status(), /Not connected/);
  assert.equal(JSON.parse(h.storage.get('klaus.sessions.v2'))[0].uploadPending, true, 'unsent clip flagged for retry');
  assert.equal(h.key('Backspace'), true, 'Back discards the unsent clip first');
  assert.equal(JSON.parse(h.storage.get('klaus.sessions.v2'))[0].uploadPending, false);
  assert.equal(h.key('Backspace'), false, 'Back with nothing pending is left to KaiOS (exit)');
}

console.log('Nokia chat UI, softkey, typing, menu and key-map checks passed');
