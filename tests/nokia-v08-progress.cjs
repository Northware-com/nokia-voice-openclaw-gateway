// nokia-v08-progress.cjs — honest live turn progress: the thinking bubble only ever shows
// transport phases the existing bridge can actually report (sending, thinking, writing,
// cancelling), never an invented tool status, with the right state transitions, and the
// palette stays on the muted read-only colours.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
function firePoll(h) { const id = h.activePolls().at(-1); assert.ok(id, 'a poll must be scheduled'); h.pollTimers[id].fn(); }
function tick(h) { Object.keys(h.tickers).filter(id => h.tickers[id].active).forEach(id => h.tickers[id].fn()); }
// The only words the bubble may lead with while a turn is live: honest transport phases.
const HONEST = /^(sending|thinking|writing|cancelling|no reply yet \u00b7 Menu \u203a Retry)/;

// ── Phases that may surface: sending, then thinking, then writing, then done ──
{
  const h = harness(new Map(), BRIDGE);
  h.key('SoftLeft'); h.composer.value = 'tell me'; h.key('Enter');
  assert.match(h.thinking(), /^sending \u00b7/, 'a fresh turn shows the sending phase and its timer');
  respond(h, last(h, isCreate), 201, {id: 'srv-pg'});
  respond(h, last(h, isTurn), 202, {runId: 'r-pg', state: 'pending'});
  assert.match(h.thinking(), /^thinking \u00b7/, 'once received the bubble says thinking, not a tool fake');
  firePoll(h);
  respond(h, last(h, isPoll('srv-pg')), 200, {state: 'pending', messages: [{role: 'user', text: 'tell me'}]});
  assert.match(h.thinking(), /^(thinking|writing) \u00b7/, 'the first streamed line may move it to writing');
  firePoll(h);
  respond(h, last(h, isPoll('srv-pg')), 200, {state: 'complete', runId: 'r-pg', messages: [{role: 'user', text: 'tell me'}, {role: 'assistant', text: 'Here you go.'}]});
  assert.equal(h.thinking(), '', 'the bubble is gone once the turn completes');
  h.finishSpeech();
}
// ── No invented tool status is ever shown, even with junk in the poll body ───────
{
  const h = harness(new Map(), BRIDGE);
  h.key('SoftLeft'); h.composer.value = 'go'; h.key('Enter');
  const create = last(h, isCreate);
  const poke = () => { const t = h.thinking(); if (t) assert.match(t, HONEST, 'only honest phases lead the bubble: ' + t); else assert.ok(true, 'bubble hidden'); };
  poke();
  create.req.onerror();
  assert.equal(h.thinking(), '', 'a send that never reached the bridge shows no fake phase while queued');
  assert.match(h.status(), /Queued; sends when back online/, 'the queue is reported by the notice, not the bubble');
  // Back online: the probe runs, the queued text resends, and every following state is honest.
  h.handlers.online();
  respond(h, last(h, r => r.method === 'GET' && r.url.endsWith('/sessions')), 200, []);
  respond(h, last(h, r => r.url.endsWith('/health')), 200, {connected: true});
  respond(h, last(h, isCreate), 201, {id: 'srv-p2'});
  respond(h, last(h, isTurn), 202, {runId: 'r-p2', state: 'pending'});
  poke();
  for (let i = 1; i <= 3; i++) {
    firePoll(h);
    respond(h, last(h, isPoll('srv-p2')), 200, {
      state: 'pending',
      toolCalls: 'this field is not part of the bridge contract',
      messages: i === 2 ? [{role: 'user', text: 'go'}] : [],
    });
    poke();
    tick(h);
    poke();
  }
  firePoll(h);
  respond(h, last(h, isPoll('srv-p2')), 200, {state: 'complete', runId: 'r-p2', messages: [{role: 'user', text: 'go'}, {role: 'assistant', text: 'Done.'}]});
  assert.equal(h.thinking(), '', 'a fake toolCalls field never becomes a visible status');
  h.finishSpeech();
}
// ── Transitions: thinking -> writing while growing, cancelling -> cleared ────────
{
  const h = harness(new Map(), BRIDGE);
  h.key('SoftLeft'); h.composer.value = 'phase'; h.key('Enter');
  respond(h, last(h, isCreate), 201, {id: 'srv-ph'});
  respond(h, last(h, isTurn), 202, {runId: 'r-ph', state: 'pending'});
  assert.match(h.thinking(), /^thinking/);
  firePoll(h);
  respond(h, last(h, isPoll('srv-ph')), 200, {state: 'pending', messages: [{role: 'user', text: 'phase'}, {role: 'assistant', text: 'part one'}]});
  assert.match(h.thinking(), /^writing/, 'a growing reply moves to writing while the turn is busy');
  h.key('Backspace');
  assert.match(h.thinking(), /^cancelling/, 'Back cancels and the bubble says cancelling');
  firePoll(h);
  respond(h, last(h, isPoll('srv-ph')), 200, {state: 'cancelled', runId: 'r-ph', messages: []});
  assert.equal(h.thinking(), '', 'the bubble clears once the server confirms the cancel');
  h.finishSpeech();
}
// ── Palette: the waiting bubble stays on the muted read-only colours ──────────────
{
  const css = fs.readFileSync(path.join(__dirname, '../configs/nokia-klaus/style.css'), 'utf8');
  const baseRule = css.split('#thinking .bubble {')[1].split('}')[0];
  assert.match(baseRule, /color:\s*#b6f2da/, 'the bubble text keeps its dim mint read colour');
  assert.doesNotMatch(baseRule, /#ffffff|#1bfc9e/i, 'no bright white or full mint is introduced on the progress bubble');
  // The phase key line (send > received > think > write) is present and dimmer than the bubble.
  assert.match(css, /#thinking \.bubble:before \{[^}]*content:\s*"Send > received > think > write[^}]*#8fd9bd/,
    'the visual key lists exactly the exposed phases in a dimmer tint');
}

console.log('Nokia v08 progress (honest phases, transitions, palette) checks passed');