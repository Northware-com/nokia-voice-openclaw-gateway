const assert = require('node:assert/strict');
const {harness} = require('./nokia-audio.cjs');
function record(h) {
  h.key('Enter'); h.grant(); h.key('Call');
  const recorder = h.recorders.at(-1);
  recorder.ondataavailable({data: new Blob(['voice'])}); recorder.onstop();
  return h.nodes.player.src;
}
{
  const h = harness();
  const first = record(h);
  h.key('3');
  assert.equal(h.nodes['session-title'].textContent, 'Conversation 2');
  assert.equal(h.nodes.player.src, undefined, 'New session has no inherited recording');
  h.key('5'); assert.equal(h.nodes.player.paused, true);
  const second = record(h);
  h.key('ArrowLeft');
  assert.match(h.nodes.chat.className, /slide-prev/, 'previous chat slides in from the left');
  assert.equal(h.nodes.player.src, first, 'Switching must preserve source recording');
  h.key('5'); assert.equal(h.nodes.player.paused, false);
  h.key('ArrowRight'); assert.equal(h.nodes.player.src, second);
  assert.deepEqual(h.revoked, [], 'Navigation must not discard recordings');
  const reload = harness(h.storage);
  assert.equal(reload.nodes['session-title'].textContent, 'Conversation 2', 'Active selection persists');
  assert.equal(reload.nodes['session-index'].textContent, '2/2');
  assert.equal(reload.nodes.player.src, undefined, 'Only metadata persists, not audio');
  h.handlers.unload();
  assert.deepEqual(h.revoked.sort(), [first, second].sort());
}
{
  const h = harness();
  const first = record(h);
  h.key('Enter'); h.grant();
  const stale = h.recorders.at(-1);
  const lateData = stale.ondataavailable, lateStop = stale.onstop, lateError = stale.onerror;
  h.key('3');
  assert.equal(h.nodes['session-index'].textContent, '1/1', 'Digits are ignored while recording');
  h.key('Backspace'); h.key('3'); h.key('Enter'); h.grant();
  lateData({data: new Blob(['old'])}); lateStop(); lateError();
  assert.equal(h.stopped, 2, 'Stale callbacks cannot stop new session microphone');
  h.key('Backspace'); h.key('ArrowLeft');
  assert.equal(h.nodes.player.src, first, 'Cancelled replacement preserves previous audio');
}
{
  const h = harness();
  h.key('Enter'); h.key('Backspace'); h.key('3'); h.grant();
  assert.equal(h.recorders.length, 0, 'Late permission grant cannot attach to new session');
  assert.equal(h.stopped, 1);
}
// H1: v1 storage with broken/null/duplicate values must not crash
for (const value of ['{broken', 'null', '[{"id":"x","title":"A"},{"id":"x","title":"B"}]']) {
  const h = harness(new Map([['klaus.local.sessions.v1', value]]));
  assert.ok(h.nodes['session-title'].textContent);
  h.key('3'); h.key('ArrowLeft');
}
{
  const h = harness();
  const old = record(h), replacement = record(h);
  assert.deepEqual(h.revoked, [old], 'Only successful replacement revokes old audio');
  h.context.document.hidden = true; h.handlers.visibilitychange();
  assert.equal(h.nodes.player.src, replacement, 'Hiding preserves completed recording');
  h.key('Enter'); h.requests.at(-1).fail(new Error('denied'));
  assert.equal(h.nodes.player.src, replacement, 'Permission denial preserves completed recording');
}
// Exercise generated launcher JavaScript via its physical-key consumer path.
{
  const fs = require('node:fs'), vm = require('node:vm');
  const buttons = Array.from({length: 3}, () => ({setAttribute() {}, addEventListener() {}}));
  const handlers = {}, activities = [], launched = [];
  const discovery = {};
  const context = {document: {querySelectorAll() {return buttons;}, getElementById() {return {};}, addEventListener(name, fn) {handlers[name] = fn;}}, window: {navigator: {mozApps: {mgmt: {getAll() {return discovery;}}}}, MozActivity: function(options) {activities.push(options);}}};
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../configs/nokia-launcher/app.js'), 'utf8'), context);
  const key = key => handlers.keydown({key, preventDefault() {}});
  key('2');
  assert.equal(activities.length, 1, 'Phone works even while app discovery is pending');
  assert.equal(JSON.stringify(activities[0]), JSON.stringify({name: 'dial', data: {type: 'webtelephony/number', number: ''}}), 'Phone opens blank stock activity, never a call');
  discovery.result = ['app://huginn-klaus-audio-proof/manifest.webapp', 'app://sms.gaiamobile.org/manifest.webapp', 'app://communications.gaiamobile.org/manifest.webapp'].map(manifestURL => ({manifestURL, launch() {launched.push(manifestURL); return {};}}));
  discovery.onsuccess();
  key('3'); key('1'); key('ArrowDown'); key('Enter');
  assert.deepEqual(launched, ['app://sms.gaiamobile.org/manifest.webapp', 'app://huginn-klaus-audio-proof/manifest.webapp']);
  assert.equal(activities.length, 2, 'Centre on Phone uses activity, never communications app.launch');
}
// H1: v1 migration — sessions and active index carried forward
{
  const v1Sessions = [{id: 'v1-a', title: 'Old Chat'}, {id: 'v1-b', title: 'Old Chat 2'}];
  const v1Store = new Map([
    ['klaus.local.sessions.v1', JSON.stringify(v1Sessions)],
    ['klaus.local.sessions.v1.active', 'v1-b']
  ]);
  const h = harness(v1Store);
  // Should have migrated both sessions
  assert.equal(h.nodes['session-index'].textContent, '2/2', 'v1 active selection migrated');
  assert.equal(h.nodes['session-title'].textContent, 'Old Chat 2', 'v1 active title migrated');
  // v2 key must now be written
  assert.ok(h.storage.get('klaus.sessions.v2'), 'v2 key written after migration');
  const v2 = JSON.parse(h.storage.get('klaus.sessions.v2'));
  assert.equal(v2.length, 2, 'both v1 sessions migrated to v2');
  assert.equal(v2[0].id, 'v1-a', 'v1 session ids preserved');
  assert.ok(v2[0].clientId && /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(v2[0].clientId), 'clientId assigned on migration');
}

// H1: v2 takes precedence over v1 when both exist
{
  const store = new Map([
    ['klaus.sessions.v2', JSON.stringify([{id: 'v2-a', title: 'V2 Session', clientId: 'aabbccdd-0000-4000-8000-000000000001'}])],
    ['klaus.sessions.v2.active', 'v2-a'],
    ['klaus.local.sessions.v1', JSON.stringify([{id: 'v1-only', title: 'V1 Only'}])]
  ]);
  const h = harness(store);
  assert.equal(h.nodes['session-title'].textContent, 'V2 Session', 'v2 takes precedence over v1');
}

// H5: single session — Left/Right must explain rather than wrap
{
  const h = harness();
  assert.equal(h.nodes['session-index'].textContent, '1/1');
  h.key('ArrowLeft');
  assert.ok(h.nodes.status.textContent.includes('Only one') || h.nodes.status.textContent.includes('Press 3'),
    'Single session Left must explain: ' + h.nodes.status.textContent);
  h.key('ArrowRight');
  assert.ok(h.nodes.status.textContent.includes('Only one') || h.nodes.status.textContent.includes('Press 3'),
    'Single session Right must explain: ' + h.nodes.status.textContent);
  assert.equal(h.nodes['session-index'].textContent, '1/1', 'Index unchanged after single-session nav');
}

console.log('Nokia session switch/create/reload and media isolation checks passed');
