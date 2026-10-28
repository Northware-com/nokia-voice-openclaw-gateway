// Minimal lifecycle checks, using Node's built-in assertions and VM only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../configs/nokia-klaus/app.js'), 'utf8');
function harness(storage = new Map(), bridgeUrl = '') {
  const handlers = {};
  const requests = [];
  const xhrRequests = [];
  const recorders = [];
  let stopped = 0;
  const revoked = [];
  let nextUrl = 0;
  const intervals = {};
  let nextInterval = 1;
  const utterances = [];
  const player = {paused: true, addEventListener() {}, pause() {this.paused = true;}, play() {this.paused = false; return {catch() {}};}, removeAttribute() {delete this.src;}};
  const transcript = {innerHTML: '', scrollTop: 0, get scrollHeight() { return 100; }};
  const connection = {textContent: ''};
  const nodes = {status: {}, softkey: {}, 'session-title': {}, 'session-index': {}, player, transcript, connection};
  const context = {
    localStorage: {getItem(key) {return storage.get(key) || null;}, setItem(key, value) {storage.set(key, value);}},
    document: {hidden: false, getElementById(id) {return nodes[id];}, addEventListener(name, fn) {handlers[name] = fn;}},
    window: {addEventListener(name, fn) {handlers[name] = fn;}},
    navigator: {getUserMedia(_constraints, ok, fail) {requests.push({ok, fail});}},
    URL: {createObjectURL() {return `blob:test-${++nextUrl}`;}, revokeObjectURL(url) {revoked.push(url);}},
    Blob,
    crypto: {getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; }},
    setInterval(fn, ms) { const id = nextInterval++; intervals[id] = {fn, ms, active: true}; return id; },
    clearInterval(id) { if (intervals[id]) intervals[id].active = false; },
    // Simulate Gecko 48 constructor: new XMLHttpRequest({mozSystem:true}) sets mozSystem=true.
    // Without the constructor arg (or with bridgeUrl='') mozSystem stays false.
    XMLHttpRequest: function(opts) {
      this.mozSystem = !!(opts && opts.mozSystem && bridgeUrl);
      const self = this;
      this.open = function(method, url) { self._method = method; self._url = url; };
      this.setRequestHeader = function() {};
      this.send = function(body) { xhrRequests.push({method: self._method, url: self._url, body, req: self}); };
      this.timeout = 30000;
    },
    SpeechSynthesisUtterance: function(text) { this.text = text; utterances.push(this); },
    speechSynthesis: { speak(u) { if (u.onend) setTimeout(() => { u.onend(); }, 0); }, cancel() {} },
    MediaRecorder: function() {
      this.state = 'inactive'; this.mimeType = 'audio/ogg';
      this.start = () => {this.state = 'recording';};
      this.stop = () => {this.state = 'inactive';};
      recorders.push(this);
    },
    NOKIA_RUNTIME_CONFIG: bridgeUrl ? {bridgeUrl, bridgeToken: 'test-token'} : {bridgeUrl: '', bridgeToken: ''},
  };
  vm.runInNewContext(source, context);
  const key = (key) => handlers.keydown({key, preventDefault() {}});
  const grant = () => requests.at(-1).ok({getTracks() {return [{stop() {stopped++;}}];}});
  return {context, nodes, requests, xhrRequests, recorders, key, grant, handlers, storage, revoked, utterances, intervals,
    get stopped() {return stopped;}};
}
{
  const h = harness();
  h.key('Enter'); h.grant(); h.key('Enter');
  h.recorders[0].ondataavailable({data: new Blob(['sample'])});
  h.recorders[0].onstop();
  h.key('Enter');
  assert.equal(h.requests.length, 2, 'Centre starts a new recording after a saved recording');
}
{
  const h = harness();
  h.key('Enter'); h.grant();
  const staleStop = h.recorders[0].onstop;
  h.key('Backspace'); h.key('Enter'); h.grant();
  staleStop();
  assert.equal(h.stopped, 1, 'Old recorder completion must not stop the new microphone');
}
{
  const h = harness();
  h.key('Enter'); h.key('Backspace'); h.grant();
  assert.equal(h.stopped, 1, 'Late permission grant is discarded and tracks stopped');
}
{
  const h = harness();
  assert.equal(h.nodes.player.mozAudioChannelType, 'content', 'Playback must use the stock recorder media channel');
  const manifest = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../configs/nokia-klaus/manifest.webapp'), 'utf8'));
  assert.ok(manifest.permissions['audio-channel-content'], 'Media channel permission must be declared');
}
for (const key of ['5', 'SoftLeft', 'SoftRight']) {
  const h = harness();
  h.key('Enter'); h.grant(); h.key('Enter');
  h.recorders[0].ondataavailable({data: new Blob(['sample'])}); h.recorders[0].onstop();
  h.key(key);
  assert.equal(h.nodes.player.paused, false, `${key} must play a saved recording`);
}
console.log('Nokia audio lifecycle checks passed');
module.exports = {harness};
