// nokia-display.cjs — Menu › Night mode and Menu › Large text: body classes, persisted settings,
// and a stylesheet that keeps every night-mode text colour readable.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {harness} = require('./nokia-audio.cjs');

const menu = h => h.nodes['overlay-list'].children.map(c => c.textContent);

// ── Menu items, toggles and persistence ────────────────────────────────────
{
  const storage = new Map();
  const h = harness(storage);
  const body = h.context.document.body;
  assert.equal(body.className, '', 'day palette and normal text by default');
  h.key('SoftRight');
  assert.deepEqual(menu(h).slice(6), ['7Night mode: off', '8Large text: off', '9Keys']);
  h.key('7');
  assert.equal(body.className, 'night');
  assert.equal(h.status(), 'Night mode on.');
  assert.equal(h.nodes.status.className, 'ok');
  assert.equal(storage.get('klaus.night'), '1');
  h.key('SoftRight'); h.key('8');
  assert.equal(body.className, 'night large');
  assert.equal(h.status(), 'Large text on.');
  h.key('SoftRight');
  assert.deepEqual(menu(h).slice(6, 8), ['7Night mode: on', '8Large text: on']);
  h.key('Backspace');

  const again = harness(storage);
  assert.equal(again.context.document.body.className, 'night large', 'both survive a restart');
  again.key('SoftRight'); again.key('7');
  assert.equal(again.context.document.body.className, 'large');
  again.key('SoftRight'); again.key('8');
  assert.equal(again.context.document.body.className, '');
  assert.equal(storage.get('klaus.large'), '0');
}

// ── Stylesheet: night overrides exist for every bright surface, and are readable ──
{
  const css = fs.readFileSync(path.join(__dirname, '../configs/nokia-klaus/style.css'), 'utf8');
  for (const sel of ['body.night', '.night .user .bubble', '.night .bot .bubble', '.night #bar', '.night #softkeys', '.night #overlay',
    '.night .item.sel', '.night #composer', '.night #status']) {
    assert.ok(css.includes(sel + ' {') || css.includes(sel + ','), `night style for ${sel}`);
  }
  for (const sel of ['body.large .bubble', 'body.large .item', 'body.large #status']) assert.ok(css.includes(sel), `large style for ${sel}`);
  assert.doesNotMatch(css.split('Night mode (Menu')[1], /#1bfc9e|#ffffff/i, 'no bright mint or white in night mode');

  // WCAG contrast of the main night text pairs.
  const lum = hex => {
    const c = hex.match(/[0-9a-f]{2}/gi).map(x => parseInt(x, 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [fg, bg, what] of [['#e0b98f', '#000000', 'body text'], ['#ffe2c2', '#5a3714', 'your bubbles'], ['#e0b98f', '#120b06', 'replies'],
    ['#000000', '#ffb36b', 'selected item'], ['#b8926b', '#000000', 'hints'], ['#c99a6b', '#0d0805', 'times']]) {
    assert.ok(ratio(fg, bg) >= 4.5, `${what}: ${ratio(fg, bg).toFixed(2)}:1`);
  }
}

console.log('Nokia display options (night mode, large text) checks passed');
