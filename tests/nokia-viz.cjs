// nokia-viz.cjs — reply mini-visuals: bar charts, checklists and timelines drawn inside
// received replies; anything that does not match the mini-syntax stays plain text.
'use strict';
const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');

const BRIDGE = 'https://bridge.example.test/nokia/v1';
// The Klaus namespace runs in its own vm context; normalise prototypes so deepStrictEqual holds.
const norm = o => o === null ? null : JSON.parse(JSON.stringify(o));

// ── Pure parser ────────────────────────────────────────────────────────────
{
  const K = harness().context.Klaus;
  // Bar charts: 'x%' and 'Label: N' pairs.
  assert.deepEqual(norm(K.parseViz('Milk 80%\nEggs 40%')), {kind: 'bars', items: [
    {label: 'Milk', value: 80, pct: true}, {label: 'Eggs', value: 40, pct: true}]}, 'percent lines');
  assert.deepEqual(norm(K.parseViz('Milk: 80\nEggs: 40')), {kind: 'bars', items: [
    {label: 'Milk', value: 80, pct: false}, {label: 'Eggs', value: 40, pct: false}]}, 'Label: N lines');
  assert.equal(K.parseViz('80% Milk\n40% Eggs').items[0].label, 'Milk', 'percent-first lines');
  assert.ok(K.parseViz('Hello there\nNo numbers here') === null, 'ordinary text is no visual');
  assert.ok(K.parseViz('Milk 80%\nand eggs too') === null, 'one bad line demotes the whole reply to text');
  assert.ok(K.parseViz('Milk 80%') === null, 'a single line is too small to chart');
  assert.ok(K.parseViz('') === null && K.parseViz('   ') === null, 'empty text stays empty');
  assert.ok(K.parseViz('a 1%\nb 1%\nc 1%\nd 1%\ne 1%\nf 1%\ng 1%') === null, 'more than six bars stay plain text at 240x320');
  // Checklists: - [ ], - [x], - [✓], also numbered.
  const checks = K.parseViz('- [ ] Pay the plumber\n- [x] Emails sent\n- [✓] Call mum');
  assert.equal(checks.kind, 'checks');
  assert.deepEqual(norm(checks.items.map(c => c.done)), [false, true, true], 'box mark, x and check all parse');
  assert.deepEqual(norm(checks.items.map(c => c.text)), ['Pay the plumber', 'Emails sent', 'Call mum']);
  assert.equal(K.parseViz('1. [ ] a\n2. [x] b').items[1].done, true, 'numbered checklist items');
  assert.ok(K.parseViz('- [ ] ok\nplain line') === null, 'a plain line inside is plain text');
  // Timelines: HH:MM lines, optional trailing text.
  const times = K.parseViz('09:30 Plumber arrives\n15:00\n17:45 Bins go out');
  assert.equal(times.kind, 'times');
  assert.deepEqual(norm(times.items), [
    {time: '09:30', text: 'Plumber arrives'},
    {time: '15:00', text: ''},
    {time: '17:45', text: 'Bins go out'}]);
  assert.ok(K.parseViz('Pick it up at 09:30 today') === null, 'a time embedded in prose is not a timeline');
  // Bar width caps and value text.
  assert.equal(K.vizBarWidth(140), 100, 'values cap at the full track');
  assert.equal(K.vizBarWidth(0.5), 2, 'a sliver still shows');
  assert.equal(K.vizBarWidth(37), 37);
  assert.equal(K.vizBarText({label: 'a', value: 80, pct: true}), '80%');
  assert.equal(K.vizBarText({label: 'a', value: 12.5, pct: false}), '12.5');
}

// Deliver one reply through the real send/turn/poll path so makeRow is exercised end to end.
function deliverReply(h, text) {
  h.key('SoftLeft'); h.composer.value = 'show me the plan'; h.key('Enter');
  const create = h.xhrRequests.filter(r => r.method === 'POST' && r.url.endsWith('/sessions')).at(-1);
  create.req.status = 201; create.req.responseText = JSON.stringify({id: 'srv-viz'}); create.req.onload();
  const turn = h.xhrRequests.filter(r => r.url.endsWith('/turns')).at(-1);
  turn.req.status = 202; turn.req.responseText = JSON.stringify({runId: 'r1', state: 'pending'}); turn.req.onload();
  const id = Object.keys(h.pollTimers).find(id => h.pollTimers[id].active);
  assert.ok(id, 'a poll must be scheduled'); h.pollTimers[id].fn();
  const poll = h.xhrRequests.filter(r => r.method === 'GET' && r.url.endsWith('/sessions/srv-viz')).at(-1);
  poll.req.status = 200;
  poll.req.responseText = JSON.stringify({state: 'complete', messages: [
    {role: 'user', text: 'show me the plan'}, {role: 'assistant', text}]});
  poll.req.onload();
}
const bubbles = h => h.nodes.transcript.children.map(c => c.children[0]);

// ── Rendering: DOM structure per kind, and the plain-text fallback ─────────
{
  const h = harness(new Map(), BRIDGE);
  deliverReply(h, 'Milk 80%\nEggs 40%');
  const bubble = bubbles(h)[1];
  const box = bubble.children[0];
  assert.ok(box && box.className.includes('viz'), 'a chart reply renders a viz container');
  assert.deepEqual(box.children.map(l => l.className), ['vline vbar', 'vline vbar'], 'one flex row per bar');
  const rowA = box.children[0];
  assert.equal(rowA.children[0].className, 'vlabel');
  assert.equal(rowA.children[0].textContent, 'Milk');
  const track = rowA.children[1];
  assert.equal(track.className, 'vtrack');
  assert.equal(track.children[0].className, 'vfill');
  assert.equal(track.children[0].style.width, '80%');
  assert.equal(rowA.children[2].textContent, '80%');
}
{
  const h = harness(new Map(), BRIDGE);
  deliverReply(h, '- [ ] Pay the plumber\n- [x] Emails sent');
  const box = bubbles(h)[1].children[0];
  assert.equal(box.className, 'viz vchecks');
  assert.deepEqual(box.children.map(l => l.className), ['vline vchk off', 'vline vchk on']);
  assert.equal(box.children[1].children[0].textContent, '✓');
  assert.equal(box.children[1].children[1].textContent, 'Emails sent');
}
{
  const h = harness(new Map(), BRIDGE);
  deliverReply(h, '09:30 Plumber arrives\n17:45 Bins go out');
  const box = bubbles(h)[1].children[0];
  assert.equal(box.className, 'viz vtimes');
  assert.deepEqual(box.children.map(l => l.className), ['vline vtim', 'vline vtim']);
  assert.equal(box.children[0].children[0].textContent, '09:30');
  assert.equal(box.children[0].children[1].textContent, 'Plumber arrives');
}
{
  // A mixed or conversational reply must degrade to plain text, unchanged.
  const h = harness(new Map(), BRIDGE);
  deliverReply(h, "Here is the plan:\nFirst the gate, then the cells.\n\nIt's done by Friday.");
  const bubble = bubbles(h)[1];
  assert.equal(bubble.children.length, 0, 'no viz container for ordinary replies');
  assert.equal(bubble.textContent, "Here is the plan:\nFirst the gate, then the cells.\n\nIt's done by Friday.",
    'plain text survives byte for byte');
  // User-side text is never parsed, even if it looks like a chart.
  const h2 = harness(new Map(), BRIDGE);
  deliverReply(h2, 'Milk 80%');
  assert.equal(bubbles(h2)[1].children.length, 0, 'one line is too small to chart anyway');
  h2.key('SoftLeft'); h2.composer.value = 'Eggs 40%\nMilk 80%'; h2.key('Enter');
  assert.equal(bubbles(h2).at(-1).children.length, 0, 'your own lines never become a chart');
}
console.log('Nokia reply visualisation (bars, checks, timelines, fallback) checks passed');