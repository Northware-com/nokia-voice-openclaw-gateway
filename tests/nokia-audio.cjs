// Minimal lifecycle checks, using Node's built-in assertions and VM only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../configs/nokia-klaus/app.js'), 'utf8');
// Minimal DOM element: enough of the API used by configs/nokia-klaus/ui.ts.
class FakeElement {
  constructor(id) { this.id = id || ''; this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {};
    this.className = ''; this._text = ''; this.scrollTop = 0; this.clientHeight = 200; this.offsetTop = 0; this.value = ''; }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get scrollHeight() { return 100 + this.children.length * 20; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); }
  appendChild(child) { child.parentNode = this; child.offsetTop = this.children.length * 20; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; return child; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  scrollIntoView() { this.scrolledIntoView = true; }
  get hidden() { return /\bhidden\b/.test(this.className); }
}

function harness(storage = new Map(), bridgeUrl = '', options = {}) {
  const handlers = {};
  const requests = [];
  const xhrRequests = [];
  const recorders = [];
  let stopped = 0;
  const revoked = [];
  let nextUrl = 0;
  // Poll scheduling uses setTimeout; the thinking/recording tickers use setInterval.
  const pollTimers = {};
  const tickers = {};
  let nextTimer = 1;
  const utterances = [];
  const clock = {t: 1700000000000};
  class FakeDate extends Date { static now() { return clock.t; } }
  const player = {paused: true, addEventListener() {}, pause() {this.paused = true;}, play() {this.paused = false; return {catch() {}};}, removeAttribute() {delete this.src;}};
  const nodes = {player};
  const document = {
    hidden: false, activeElement: null,
    getElementById(id) { if (!nodes[id]) nodes[id] = new FakeElement(id); return nodes[id]; },
    createElement() { return new FakeElement(); },
    addEventListener(name, fn) { handlers[name] = fn; },
  };
  const composer = document.getElementById('composer');
  composer.focus = function () { document.activeElement = this; if (this.listeners.focus) this.listeners.focus(); };
  composer.blur = function () { document.activeElement = null; if (this.listeners.blur) this.listeners.blur(); };
  const context = {
    Date: FakeDate,
    localStorage: {getItem(key) {return storage.has(key) ? storage.get(key) : null;}, setItem(key, value) {storage.set(key, value);}},
    document,
    window: {addEventListener(name, fn) {handlers[name] = fn;}},
    navigator: {getUserMedia(_constraints, ok, fail) {requests.push({ok, fail});}},
    URL: {createObjectURL() {return `blob:test-${++nextUrl}`;}, revokeObjectURL(url) {revoked.push(url);}},
    Blob,
    crypto: {getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; }},
    setTimeout(fn, ms) { const id = nextTimer++; pollTimers[id] = {fn() { pollTimers[id].active = false; fn(); }, ms, active: true}; return id; },
    clearTimeout(id) { if (pollTimers[id]) pollTimers[id].active = false; },
    setInterval(fn, ms) { const id = nextTimer++; tickers[id] = {fn, ms, active: true}; return id; },
    clearInterval(id) { if (tickers[id]) tickers[id].active = false; },
    // Simulate Gecko 48 constructor: new XMLHttpRequest({mozSystem:true}) sets mozSystem=true.
    // Without the constructor arg (or with bridgeUrl='') mozSystem stays false.
    XMLHttpRequest: function(opts) {
      this.mozSystem = options.oldInstall ? false : !!(opts && opts.mozSystem && bridgeUrl);
      const self = this;
      this.headers = {};
      this.open = function(method, url) { self._method = method; self._url = url; };
      this.setRequestHeader = function(k, v) { self.headers[k] = v; };
      this.send = function(body) { xhrRequests.push({method: self._method, url: self._url, body, req: self, headers: self.headers}); };
      this.timeout = 30000;
    },
    SpeechSynthesisUtterance: function(text) { this.text = text; utterances.push(this); },
    speechSynthesis: { speak(u) { if (u.onend) setTimeout(() => { u.onend(); }, 0); }, cancel() {}, getVoices() { return options.voices || []; } },
    MediaRecorder: function() {
      this.state = 'inactive'; this.mimeType = 'audio/ogg';
      this.start = () => {this.state = 'recording';};
      this.stop = () => {this.state = 'inactive';};
      recorders.push(this);
    },
    NOKIA_RUNTIME_CONFIG: bridgeUrl ? Object.assign({bridgeUrl, bridgeToken: 'test-token'}, options.config || {}) : {bridgeUrl: '', bridgeToken: ''},
  };
  vm.runInNewContext(source, context);
  const key = (key, extra = {}) => {
    let prevented = false;
    handlers.keydown(Object.assign({key, preventDefault() { prevented = true; }}, extra));
    return prevented;
  };
  const grant = () => requests.at(-1).ok({getTracks() {return [{stop() {stopped++;}}];}});
  const status = () => nodes.status.textContent;
  const transcript = () => nodes.transcript.textContent;
  const thinking = () => (nodes.thinking.hidden ? '' : nodes.thinking.textContent);
  const softkeys = () => ['sk-left', 'sk-center', 'sk-right'].map(id => nodes[id].textContent);
  const conn = () => nodes.connection.getAttribute('data-state');
  const activePolls = () => Object.keys(pollTimers).filter(id => pollTimers[id].active);
  return {context, nodes, requests, xhrRequests, recorders, key, grant, handlers, storage, revoked, utterances,
    intervals: pollTimers, pollTimers, tickers, clock, status, transcript, thinking, softkeys, conn, activePolls, composer,
    get stopped() {return stopped;}};
}
{
  const h = harness();
  h.key('Enter'); h.grant(); h.key('Call');
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
{
  const h = harness();
  h.key('Enter'); h.grant(); h.key('Call');
  h.recorders[0].ondataavailable({data: new Blob(['sample'])}); h.recorders[0].onstop();
  h.key('5');
  assert.equal(h.nodes.player.paused, false, '5 plays the saved recording when there is no reply to read');
  h.key('5');
  assert.equal(h.nodes.player.paused, true, '5 again stops playback');
}
console.log('Nokia audio lifecycle checks passed');
module.exports = {harness};
