#!/usr/bin/env node
'use strict';
// Offline launcher contract checks. Never accesses a device or places a call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../configs/nokia-launcher/app.js'), 'utf8');
function harness() {
  const listeners = {}, calls = [], activities = [];
  const buttons = [0, 1, 2].map(index => ({
    attrs: {'data-index': String(index)}, handlers: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(k, fn) { this.handlers[k] = fn; },
  }));
  const status = {textContent: ''};
  const discovery = {};
  const context = {document: {
    querySelectorAll() { return buttons; }, getElementById() { return status; },
    addEventListener(k, fn) { listeners[k] = fn; },
  }, navigator: {mozApps: {mgmt: {getAll() { return discovery; }}}},
  MozActivity: function(options) { activities.push(options); return {}; }};
  context.window = context;
  vm.runInNewContext(source, context);
  function key(value, code, repeat = false) {
    let prevented = false;
    listeners.keydown({key: value, keyCode: code, repeat, preventDefault() { prevented = true; }});
    return prevented;
  }
  function resolveApps() {
    discovery.result = [
      ['huginn-klaus-audio-proof', 'Klaus'], ['communications.gaiamobile.org', 'Call Log'], ['sms.gaiamobile.org', 'SMS'],
    ].map(([origin, name]) => ({manifestURL: 'app://' + origin + '/manifest.webapp', launch() { calls.push(name); return {}; }}));
    discovery.onsuccess();
  }
  return {key, resolveApps, buttons, status, calls, activities};
}
{
  const h = harness();
  assert.equal(h.key('2', 50), true);
  assert.equal(h.activities.length, 1, 'Phone must work before asynchronous app discovery');
  assert.deepEqual(JSON.parse(JSON.stringify(h.activities[0])), {name: 'dial', data: {type: 'webtelephony/number', number: ''}});
  assert.deepEqual(h.calls, [], 'Opening Phone must not launch Call Log or place a call');
  h.key('2', 50, true);
  assert.equal(h.activities.length, 1, 'Repeated key events must not open multiple activities');
}
{
  const h = harness();
  h.key('1', 49);
  assert.match(h.status.textContent, /loading/i);
  h.resolveApps(); h.key('1', 49); h.key('3', 51);
  assert.deepEqual(h.calls, ['Klaus', 'SMS']);
  assert.equal(h.activities.length, 0);
  h.key('ArrowDown', 40); h.key('Enter', 13);
  assert.deepEqual(h.calls, ['Klaus', 'SMS', 'Klaus'], 'Selection must wrap to Klaus');
  h.key('SoftLeft', 0);
  assert.deepEqual(h.calls, ['Klaus', 'SMS', 'Klaus', 'Klaus'], 'SoftLeft (Select) launches the highlighted app');
  h.key('ArrowUp', 38);
  assert.equal(h.buttons[2].attrs['aria-pressed'], 'true');
}
{
  const h = harness(); h.resolveApps();
  h.buttons[1].handlers.click({currentTarget: h.buttons[1]});
  assert.equal(h.activities.length, 1);
  assert.deepEqual(h.calls, []);
}
console.log('Nokia launcher navigation/dial activity contract checks passed');
