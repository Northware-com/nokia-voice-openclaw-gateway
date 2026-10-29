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
    ['1', 'top'], ['9', 'bottom'], ['2', 'pageUp'], ['8', 'pageDown'], ['5', 'read'], ['0', 'quick'], ['#', 'sessions']]) {
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
  assert.deepEqual(Array.from(K.softkeysFor('recording', '0:07')), ['Delete', 'Pause', 'Send'], 'clip states share Delete/Send');
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
  assert.deepEqual(h.softkeys(), ['Delete', 'Pause', 'Send']);
  assert.equal(h.banner(), '\u25cf Recording 0:00');
  assert.equal(h.nodes.bar.className, 'rec');
  assert.ok(h.composer.hidden, 'banner replaces the composer while recording');
  h.grant(); h.clock.t += 7000; tick(h);
  assert.equal(h.banner(), '\u25cf Recording 0:07', 'recording timer is live');
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
  assert.equal(h.banner(), '\u275a\u275a Paused 0:07');
  assert.equal(h.nodes.bar.className, 'paused', 'paused bar is distinct from recording');
  h.clock.t += 60000; tick(h);
  assert.equal(h.banner(), '\u275a\u275a Paused 0:07', 'timer frozen while paused');
  h.key('Enter');
  assert.equal(rec.state, 'recording', 'Centre resumes');
  h.clock.t += 2000; tick(h);
  assert.equal(h.banner(), '\u25cf Recording 0:09', 'timer continues from paused time');
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
  assert.equal(h.banner(), '\u275a\u275a Paused 0:04');
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
  assert.match(h.banner(), /Delete 0:0\d clip\? Back again/);
  assert.match(h.nodes.banner.className, /discard/);
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
  assert.equal(h.nodes.transcript.children[1].className, 'msg bot reading', 'the new reply is outlined while it is read aloud');
  h.finishSpeech();
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
  h.key('SoftRight'); for (let i = 0; i < 4; i++) h.key('ArrowDown'); h.key('Enter');
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
  const chats = () => h.nodes['overlay-list'].children.filter(c => /\bitem\b/.test(c.className));
  assert.equal(chats().length, 3);
  assert.equal(chats()[0].className, 'item chat sel', 'list starts on current chat, most recent first');
  assert.match(h.nodes['overlay-title'].textContent, /Chats · 3/);
  // Opened order 1 (now), 3, 2: the second row is always the previous chat.
  h.key('ArrowDown'); h.key('Enter');
  assert.equal(h.nodes['session-index'].textContent, '3/3');
  h.key('#'); h.key('ArrowDown'); h.key('Enter');
  assert.equal(h.nodes['session-index'].textContent, '1/3', 'Down + OK toggles between the last two chats');
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
  h.key('SoftRight'); h.key('4'); // Retry last (item 4)
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
  h.key('SoftRight'); h.key('4'); // Retry last
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

// ── The empty-chat placeholder hides while the first turn is pending ───────
{
  const h = harness(new Map(), BRIDGE);
  const placeholder = () => h.nodes.transcript.children.find(c => c.className.includes('empty'));
  assert.equal(placeholder().hidden, false, 'an empty idle chat shows the hint');
  h.key('SoftLeft'); h.composer.value = 'hello'; h.key('Enter');
  assert.match(h.thinking(), /sending/);
  assert.equal(placeholder().hidden, true, 'no "No messages yet" next to a pending turn');
  respond(h, last(h, isCreate), 201, {id: 'srv-empty'});
  respond(h, last(h, isTurn), 202, {runId: 'run-empty', state: 'pending'});
  firePoll(h);
  respond(h, last(h, isPoll('srv-empty')), 200, {state: 'pending', messages: []});
  assert.equal(placeholder().hidden, true, 'still hidden while Klaus thinks');
  h.key('Backspace');
  firePoll(h);
  respond(h, last(h, isPoll('srv-empty')), 200, {state: 'cancelled', messages: []});
  assert.equal(h.thinking(), '');
  assert.equal(placeholder().hidden, false, 'the hint returns once nothing is pending');
  h.key('3');
  assert.equal(placeholder().hidden, false, 'a new chat shows the hint');
}

// ── At-a-glance state: banner, notice colours, chat list markers, key feedback ──
{
  const K = harness().context.Klaus;
  const b = st => { const r = K.stateBanner(st); return r && r.kind + '|' + r.icon + ' ' + r.text; };
  assert.equal(b({mode: 'recording', elapsed: '0:05'}), 'rec|● Recording 0:05');
  assert.equal(b({mode: 'recording', elapsed: '0:05', notes: true}), 'rec|● Note 0:05');
  assert.equal(b({mode: 'paused', elapsed: '0:05'}), 'paused|❚❚ Paused 0:05');
  assert.equal(b({mode: 'paused', elapsed: '0:05', discardArmed: true}), 'discard|✕ Delete 0:05 clip? Back again');
  assert.equal(b({mode: 'idle', elapsed: '', sending: true}), 'sending|↑ Sending…');
  assert.equal(b({mode: 'idle', elapsed: '', queued: 1, connected: false}), 'offline|↻ Offline · message queued');
  assert.equal(b({mode: 'idle', elapsed: '', queued: 2, connected: true, notes: true}), 'queued|↻ 2 notes queued · sending soon');
  assert.equal(b({mode: 'idle', elapsed: '', failed: true, queued: 1}), 'failed|! Failed · Menu › Retry last', 'failure outranks queue');
  assert.equal(b({mode: 'idle', elapsed: '', stalled: true}), 'failed|! No reply yet · Menu › Retry');
  assert.equal(b({mode: 'idle', elapsed: ''}), null, 'nothing to report: composer hint instead');
  assert.equal(b({mode: 'menu', elapsed: '', failed: true}), null, 'overlays carry their own state');
  assert.equal(K.noticeKind('Microphone unavailable or permission denied.'), 'error');
  assert.equal(K.noticeKind('Offline. Messages will queue.'), 'warn');
  assert.equal(K.noticeKind('Renamed.'), 'ok');
  assert.equal(K.noticeKind('Reading aloud…'), 'info');
  assert.equal(K.sessionListLabel('Shop', false, true, true), '! Shop');
  assert.equal(K.sessionListLabel('Shop', true, false, false), '… Shop');
  assert.equal(K.sessionListLabel('Shop', false, false, true), '↻ Shop');
  assert.equal(K.sessionListLabel('Shop', false, false, false), 'Shop');
  assert.equal(K.mapKey('recording', 'SoftRight', true), 'send', 'right softkey sends in both clip states');
}
{
  // SoftRight sends a live recording; every mapped key lights its softkey until release.
  const h = harness(new Map(), BRIDGE);
  h.key('Enter');
  assert.equal(h.nodes['sk-center'].className, 'press', 'OK lights the centre softkey');
  h.handlers.keyup({key: 'Enter'});
  assert.equal(h.nodes['sk-center'].className, '');
  h.grant(); h.clock.t += 2000;
  h.key('Call');
  assert.equal(h.nodes['sk-right'].className, 'press', 'Call lights the Send softkey');
  h.handlers.keyup({key: 'Call'});
  h.recorders[0].ondataavailable({data: new Blob(['OggS'])}); h.recorders[0].onstop();
  respond(h, last(h, isCreate), 201, {id: 'srv-sk'});
  respond(h, last(h, isTurn), 202, {runId: 'run-sk', state: 'pending'});
  h.key('Enter'); h.handlers.keyup({key: 'Enter'});
  h.key('3'); // a new idle chat to record in
  h.key('Enter'); h.grant();
  h.key('SoftRight');
  assert.equal(h.recorders.at(-1).state, 'inactive', 'SoftRight sends while recording');
  h.key('4');
  assert.equal(h.nodes['sk-left'].className, '', 'digits do not light a softkey');
}
{
  // Offline clip: queued banner instead of the composer; typing brings the composer back.
  const h = harness();
  record(h);
  assert.equal(h.banner(), '↻ Offline · message queued');
  assert.ok(h.composer.hidden);
  h.key('SoftLeft');
  assert.equal(h.banner(), '', 'typing hides the banner');
  assert.ok(!h.composer.hidden);
  assert.equal(h.composer.getAttribute('placeholder'), 'Type a message');
  h.key('Escape');
  assert.equal(h.composer.getAttribute('placeholder'), 'OK: talk · Left: type');
  h.key('SoftRight');
  h.key('ArrowDown'); h.key('ArrowDown'); h.key('Enter');
  assert.match(h.nodes['overlay-list'].textContent, /OK archives, Back keeps it/, 'confirm explains itself on screen');
  assert.equal(h.nodes['overlay-list'].children[0].className, 'note');
  h.key('Backspace');
  h.key('#');
  const row = h.nodes['overlay-list'].children.find(c => /\bitem\b/.test(c.className));
  assert.equal(row.children[0].children[0].textContent, '↻ Conversation 1', 'chat list marks queued chats');
  assert.equal(row.children[1].textContent, 'Queued · sends when online');
  assert.match(row.className, /\bqueued\b/);
}
{
  // Notice colours and the connection word.
  const h = harness();
  h.key('SoftLeft'); h.key('Enter');
  assert.equal(h.status(), 'Type a message first.');
  assert.equal(h.nodes.status.className, 'warn');
  h.context.Klaus.uiConn('UNREACHABLE');
  assert.equal(h.nodes.connection.textContent, '● offline');
  h.context.Klaus.uiConn('CONNECTED');
  assert.equal(h.nodes.connection.textContent, '●');
}

console.log('Nokia chat UI, softkey, typing, menu and key-map checks passed');
