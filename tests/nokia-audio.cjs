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

const PRIME_MS = 300;

// Request objects fire their handler as soon as it is assigned, which keeps tests synchronous.
function fakeRequest(run) {
  const req = {result: run()};
  for (const name of ['onsuccess', 'onupgradeneeded']) Object.defineProperty(req, name, {set(fn) { if (fn) fn(); }});
  return req;
}
function fakeIndexedDB(clips) {
  const store = {
    put(blob, key) { clips.set(key, blob); return fakeRequest(() => key); },
    get(key) { return fakeRequest(() => clips.get(key)); },
    delete(key) { clips.delete(key); return fakeRequest(() => undefined); },
  };
  const db = {createObjectStore() {}, transaction() { return {objectStore() { return store; }}; }};
  return {open() { return fakeRequest(() => db); }};
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
  const primeTimers = {};
  const tickers = {};
  let nextTimer = 1;
  const utterances = [];
  const vibrations = [];
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
    localStorage: {getItem(key) {return storage.has(key) ? storage.get(key) : null;}, setItem(key, value) {storage.set(key, value);}, removeItem(key) {storage.delete(key);}},
    document,
    window: {addEventListener(name, fn) {handlers[name] = fn;}},
    navigator: Object.assign({getUserMedia(_constraints, ok, fail) {requests.push({ok, fail});}},
      options.noVibrate ? {} : {vibrate(pattern) { vibrations.push(Array.from(pattern)); return true; }}),
    URL: {createObjectURL() {return `blob:test-${++nextUrl}`;}, revokeObjectURL(url) {revoked.push(url);}},
    Blob,
    crypto: {getRandomValues(arr) { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; }},
    // The 300 ms microphone-prime timer is kept apart so poll tests only see polls.
    setTimeout(fn, ms) { const id = nextTimer++; if (ms === PRIME_MS) { primeTimers[id] = {fn, active: true}; return id; } pollTimers[id] = {fn() { pollTimers[id].active = false; fn(); }, ms, active: true}; return id; },
    clearTimeout(id) { if (pollTimers[id]) pollTimers[id].active = false; if (primeTimers[id]) primeTimers[id].active = false; },
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
    MediaRecorder: function(_stream, opts) {
      if (opts && options.recorderRejectsOptions) throw new Error('NotSupportedError');
      this.options = opts; this.state = 'inactive'; this.mimeType = 'audio/ogg';
      this.start = () => {this.state = 'recording';};
      this.stop = () => {this.state = 'inactive';};
      recorders.push(this);
    },
    // Optional synchronous IndexedDB stand-in; pass the same Map to simulate a restart.
    indexedDB: options.idb ? fakeIndexedDB(options.idb) : undefined,
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
  const banner = () => (nodes.banner.hidden ? '' : nodes.banner.textContent);
  const transcript = () => nodes.transcript.textContent;
  const thinking = () => (nodes.thinking.hidden ? '' : nodes.thinking.textContent);
  const softkeys = () => ['sk-left', 'sk-center', 'sk-right'].map(id => nodes[id].textContent);
  const conn = () => nodes.connection.getAttribute('data-state');
  // Fire pending microphone-prime timers (app launch, after a recording, on visible).
  const firePrime = () => Object.keys(primeTimers).forEach(id => { if (primeTimers[id].active) { primeTimers[id].active = false; primeTimers[id].fn(); } });
  const activePolls = () => Object.keys(pollTimers).filter(id => pollTimers[id].active);
  // End every utterance now (the fake speechSynthesis otherwise ends them on a later tick);
  // stale callbacks are ignored by tts.ts, and queued items start and end in turn.
  const finishSpeech = () => { for (let done = 0; done < utterances.length;) { const u = utterances[done++]; if (u.onend) u.onend(); } };
  return {context, nodes, requests, xhrRequests, recorders, key, grant, handlers, storage, revoked, utterances, vibrations,
    intervals: pollTimers, pollTimers, tickers, clock, status, banner, transcript, thinking, softkeys, conn, activePolls, finishSpeech, composer, firePrime, primeTimers,
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
{
  const h = harness();
  h.key('Enter'); h.grant();
  assert.equal(h.recorders[0].options.audioBitsPerSecond, 16000, 'Speech is recorded at 16 kbps');
  const old = harness(new Map(), '', {recorderRejectsOptions: true});
  old.key('Enter'); old.grant();
  assert.equal(old.recorders.length, 1, 'A recorder that rejects options still records with defaults');
  assert.equal(old.recorders[0].state, 'recording');
}
{
  // Launch primes the microphone; Centre then records without a new permission request.
  const h = harness();
  assert.equal(h.requests.length, 0, 'The microphone is not opened before the first paint');
  h.firePrime();
  assert.equal(h.requests.length, 1, 'Launch primes the microphone');
  h.grant();
  h.key('Enter');
  assert.equal(h.requests.length, 1, 'Centre reuses the primed stream');
  assert.equal(h.recorders.length, 1, 'Centre starts the recorder at once');
  assert.equal(h.recorders[0].state, 'recording');
  assert.equal(h.status(), '', 'No "Requesting microphone" notice when primed');
  h.key('Call'); h.recorders[0].ondataavailable({data: new Blob(['a'])}); h.recorders[0].onstop();
  assert.equal(h.stopped, 1, 'The used stream is stopped with its recording');
  h.firePrime();
  assert.equal(h.requests.length, 2, 'The microphone is primed again after a recording');
}
{
  // Centre while the prime request is still pending waits for it instead of asking twice.
  const h = harness();
  h.firePrime();
  h.key('Enter');
  assert.equal(h.requests.length, 1, 'No second permission request while priming');
  h.grant();
  assert.equal(h.recorders.length, 1, 'The pending prime feeds the recording');
}
{
  // Hiding the app releases the primed microphone; showing it primes again.
  const h = harness();
  h.firePrime(); h.grant();
  h.context.document.hidden = true; h.handlers.visibilitychange();
  assert.equal(h.stopped, 1, 'A hidden app does not hold the microphone');
  h.firePrime();
  assert.equal(h.requests.length, 1, 'No priming while hidden');
  h.context.document.hidden = false; h.handlers.visibilitychange(); h.firePrime();
  assert.equal(h.requests.length, 2, 'Visible again primes the microphone');
}
console.log('Nokia audio lifecycle checks passed');
module.exports = {harness};
