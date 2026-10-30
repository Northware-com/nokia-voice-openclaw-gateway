// nokia-polish.cjs — numbered menu, Keys help screen, state-aware empty-chat hint, notices that
// keep the newest message in view, 0.8.0 manifest.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {harness} = require('./nokia-audio.cjs');

const empty = h => h.nodes.transcript.children.find(c => c.className.includes('empty'));
const menuRows = h => h.nodes['overlay-list'].children.filter(c => /\bitem\b/.test(c.className));

// ── Pure helpers ───────────────────────────────────────────────────────────
{
  const K = harness().context.Klaus;
  assert.equal(K.emptyHint('idle', false), 'No messages yet.\nOK talk · Left type\n0 quick reply · # chats');
  assert.equal(K.emptyHint('recording', false), 'Listening…\nCall sends · OK pauses');
  assert.equal(K.emptyHint('recording', true), 'Listening…\nCall saves the note');
  assert.equal(K.emptyHint('paused', false), 'Paused\nOK resumes · Call sends');
  assert.match(K.emptyHint('idle', true), /Plato's inbox/);
  assert.equal(K.mapKey('help', 'Enter', true), 'close');
  assert.equal(K.mapKey('help', 'Backspace', true), 'close');
  assert.equal(K.mapKey('help', '5', true), 'none', 'the help screen ignores other keys');
  assert.deepEqual(Array.from(K.softkeysFor('help', '')), ['Close', 'OK', '']);
  for (const line of K.KEY_HELP) assert.ok(line.length <= 24, `help line fits 240 px: ${line}`);
  assert.equal(K.KEY_HELP.length, 14, 'every idle key family is listed');
  assert.equal(K.KEY_HELP.includes('list right key: search'), true, 'the chat search entry is on the Keys screen');
}

// ── The empty-chat hint follows the first recording ────────────────────────
{
  const h = harness();
  assert.equal(empty(h).textContent, 'No messages yet.\nOK talk · Left type\n0 quick reply · # chats');
  h.key('Enter');
  assert.equal(empty(h).textContent, 'Listening…\nCall sends · OK pauses', 'no "Press OK to talk" while already recording');
  h.key('SoftLeft');
  assert.match(empty(h).textContent, /^No messages yet/, 'the hint returns after discarding');
}

// ── Numbered menu: digit shortcuts and the Keys screen ─────────────────────
{
  const h = harness();
  h.key('SoftRight');
  const rows = menuRows(h);
  assert.deepEqual(rows.map(r => r.textContent), ['1New chat', '2Rename', '3Archive', '4Retry last', '5Read aloud: on', '6Vibrate: on', '7Night mode: off', '8Large text: off', '9Keys', '10Backup chats']);
  assert.ok(rows.every(r => /\bnum\b/.test(r.className)), 'menu rows carry digit badges');
  h.key('0');
  assert.ok(!h.nodes.overlay.hidden, 'a digit past the last item does nothing');
  h.key('2');
  assert.deepEqual(h.softkeys(), ['Clear', 'Save', 'Cancel'], '2 opens Rename');
  h.key('Escape');
  h.key('SoftRight'); h.key('9');
  assert.equal(h.nodes['overlay-title'].textContent, 'Keys');
  assert.deepEqual(h.softkeys(), ['Close', 'OK', '']);
  const note = h.nodes['overlay-list'].children[0];
  assert.equal(note.className, 'note keys');
  assert.match(note.textContent, /0  quick replies/);
  h.key('5');
  assert.ok(!h.nodes.overlay.hidden, '5 does not leak through to read aloud');
  h.key('Enter');
  assert.ok(h.nodes.overlay.hidden);
  assert.deepEqual(h.softkeys(), ['Type', 'Talk', 'Menu']);
  h.key('SoftRight'); h.key('9'); h.key('Backspace');
  assert.ok(h.nodes.overlay.hidden, 'Back closes the Keys screen');
  h.key('SoftRight'); h.key('1');
  assert.equal(h.nodes['session-index'].textContent, '2/2', '1 creates a chat');
}

// ── A notice never hides the newest message ────────────────────────────────
{
  const h = harness();
  const chat = h.nodes.chat;
  chat.clientHeight = 50; // scrollHeight is 100 in the fake DOM, so the bottom is 50
  chat.scrollTop = 48;
  h.context.Klaus.uiStatus('Recording discarded.');
  assert.equal(chat.scrollTop, 50, 'a reader at the bottom stays at the bottom when the notice appears');
  chat.scrollTop = 10;
  h.context.Klaus.uiStatus('Request cancelled.');
  assert.equal(chat.scrollTop, 10, 'a reader scrolled up keeps their place');
  assert.ok(h.context.Klaus.KEY_HELP.includes('*  notes (0 = meeting)'), 'the Keys screen mentions meeting mode');
}

// ── Manifest version ───────────────────────────────────────────────────────
{
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../configs/nokia-klaus/manifest.webapp'), 'utf8'));
  assert.equal(manifest.version, '0.8.0');
}

console.log('Nokia polish (menu digits, Keys screen, empty hint, version) checks passed');
