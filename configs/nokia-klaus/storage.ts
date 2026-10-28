// Session model, localStorage persistence and the IndexedDB store for unsent clips.
namespace Klaus {
  // "cancelling": cancel POST fired, poll continues until server confirms.
  export type SessionState = "idle" | "pending" | "complete" | "error" | "cancelled" | "uncertain" | "cancelling";

  export type ApiMessage = { role: "user" | "assistant"; text: string };

  export type LocalSession = {
    id: string;                 // local stable key (may be legacy non-UUID)
    title: string;
    clientId: string;           // UUID for server dedup; also X-Request-Id on POST /sessions
    serverId: string | null;    // server-assigned session id once created
    serverState: SessionState;
    messages: ApiMessage[];
    runId: string | null;
    lastRequestId: string | null;   // UUID for POST /turns, persisted for uncertain recovery
    cancelRequestId: string | null; // UUID for POST .../cancel, generated once per attempt
    archived: boolean;          // hidden from navigation but retained
    pendingSince: number;       // ms epoch when the current turn started (thinking timer)
    lastText: string | null;    // last typed turn, for Retry and the pending echo bubble
    pollTimer: any;             // setTimeout handle
    pollXhr: XMLHttpRequest | null; // at-most-one concurrent poll XHR per session
    uploadPending: boolean;     // audio blob waiting for connection (persisted; blob lives in IndexedDB)
    uploadBlob: Blob | null;
  };

  export var STORAGE_KEY = "klaus.sessions.v2";
  var LEGACY_V1_KEY = "klaus.local.sessions.v1";
  export var MAX_SESSIONS = 128;
  var STORE_CAP = 1048576;

  export function isBusyState(state: SessionState): boolean {
    return state === "pending" || state === "uncertain" || state === "cancelling";
  }

  export function makeUUID(): string {
    var bytes = new Uint8Array(16);
    try {
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(bytes);
      } else {
        for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
    } catch (_e) {
      for (var j = 0; j < 16; j++) bytes[j] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var out = "";
    for (var k = 0; k < 16; k++) {
      if (k === 4 || k === 6 || k === 8 || k === 10) out += "-";
      out += (bytes[k] < 16 ? "0" : "") + bytes[k].toString(16);
    }
    return out;
  }

  function makeLegacyId(): string { return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2); }

  export function blankSession(title: string): LocalSession {
    return {
      id: makeLegacyId(), title: title,
      clientId: makeUUID(), serverId: null,
      serverState: "idle", messages: [], runId: null,
      lastRequestId: null, cancelRequestId: null,
      archived: false, pendingSince: 0, lastText: null,
      pollTimer: null, pollXhr: null,
      uploadPending: false, uploadBlob: null
    };
  }

  // Bounded: 128 messages per session, 65536 chars per message, 64k aggregate chars per session.
  export function validateMessages(arr: any[]): ApiMessage[] {
    var out: ApiMessage[] = [];
    var totalChars = 0;
    for (var mi = 0; mi < arr.length && mi < 128; mi++) {
      var m = arr[mi];
      if (m && (m.role === "user" || m.role === "assistant") &&
          typeof m.text === "string" && m.text.length <= 65536) {
        totalChars += m.text.length;
        if (totalChars > 65536) break;
        out.push({ role: m.role, text: m.text });
      }
    }
    return out;
  }

  function mapStoredSession(item: any): LocalSession {
    var s = blankSession(item.title);
    s.id = item.id;
    if (typeof item.clientId === "string" && item.clientId) s.clientId = item.clientId;
    s.serverId = typeof item.serverId === "string" ? item.serverId : null;
    s.serverState = (item.serverState || "idle") as SessionState;
    s.messages = Array.isArray(item.messages) ? validateMessages(item.messages) : [];
    s.runId = typeof item.runId === "string" ? item.runId : null;
    s.lastRequestId = typeof item.lastRequestId === "string" ? item.lastRequestId : null;
    s.cancelRequestId = typeof item.cancelRequestId === "string" ? item.cancelRequestId : null;
    s.archived = item.archived === true;
    s.pendingSince = typeof item.pendingSince === "number" ? item.pendingSince : 0;
    s.lastText = typeof item.lastText === "string" ? item.lastText : null;
    s.uploadPending = item.uploadPending === true;
    return s;
  }

  function filterDedup(arr: any[]): any[] {
    return arr.filter(function (item: any, idx: number, a: any[]): boolean {
      return item && typeof item.id === "string" && !!item.id &&
             typeof item.title === "string" && !!item.title &&
             !a.slice(0, idx).some(function (o: any): boolean { return o && o.id === item.id; });
    });
  }

  function readArray(key: string): LocalSession[] {
    try {
      var raw = localStorage.getItem(key);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return filterDedup(parsed).map(mapStoredSession);
      }
    } catch (_e) { /* corrupt store: start fresh */ }
    return [];
  }

  // Load sessions (v2, else migrate v1) and the active index. Always returns at least one open session.
  export function loadSessions(): { sessions: LocalSession[]; active: number } {
    var sessions = readArray(STORAGE_KEY);
    if (!sessions.length) sessions = readArray(LEGACY_V1_KEY);
    if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(0, MAX_SESSIONS);
    if (!sessions.length) sessions = [blankSession("Conversation 1")];
    var active = 0;
    try {
      var savedActive = localStorage.getItem(STORAGE_KEY + ".active") ||
                        localStorage.getItem(LEGACY_V1_KEY + ".active");
      sessions.forEach(function (s: LocalSession, i: number): void { if (s.id === savedActive) active = i; });
    } catch (_e) { /* default */ }
    if (sessions[active].archived) {
      active = 0;
      for (var i = 0; i < sessions.length; i++) { if (!sessions[i].archived) { active = i; break; } }
    }
    return { sessions: sessions, active: active };
  }

  function storable(s: LocalSession): any {
    return {
      id: s.id, title: s.title, clientId: s.clientId,
      serverId: s.serverId, serverState: s.serverState,
      messages: s.messages.slice(), runId: s.runId,
      lastRequestId: s.lastRequestId, cancelRequestId: s.cancelRequestId,
      archived: s.archived, pendingSince: s.pendingSince, lastText: s.lastText,
      uploadPending: s.uploadPending
    };
  }

  // Returns false when storage is unavailable. Store is capped at 1 MiB by dropping the
  // oldest messages of the largest sessions; ids and metadata are always kept.
  export function persistSessions(sessions: LocalSession[], active: number): boolean {
    try {
      var toStore = sessions.map(storable);
      var raw = JSON.stringify(toStore);
      var iter = 0;
      while (raw.length > STORE_CAP && iter < 1000) {
        iter++;
        var maxI = 0;
        for (var si = 1; si < toStore.length; si++) {
          if (toStore[si].messages.length > toStore[maxI].messages.length) maxI = si;
        }
        if (!toStore[maxI].messages.length) break;
        toStore[maxI].messages.shift();
        raw = JSON.stringify(toStore);
      }
      localStorage.setItem(STORAGE_KEY, raw);
      localStorage.setItem(STORAGE_KEY + ".active", sessions[active].id);
      return true;
    } catch (_e) { return false; }
  }

  export function loadSetting(name: string, fallback: boolean): boolean {
    try {
      var v = localStorage.getItem("klaus." + name);
      return v === null ? fallback : v === "1";
    } catch (_e) { return fallback; }
  }

  export function saveSetting(name: string, value: boolean): void {
    try { localStorage.setItem("klaus." + name, value ? "1" : "0"); } catch (_e) { /* ignore */ }
  }

  // ── Unsent clip store (IndexedDB) ─────────────────────────────────────────
  // Keeps one unsent recording per session across reloads. Missing IndexedDB
  // degrades to in-memory only.
  var db: IDBDatabase | null = null;
  var dbWaiters: Array<(d: IDBDatabase | null) => void> = [];
  var dbState = 0; // 0 unopened, 1 opening, 2 settled

  function withDb(cb: (d: IDBDatabase | null) => void): void {
    if (dbState === 2) { cb(db); return; }
    dbWaiters.push(cb);
    if (dbState === 1) return;
    dbState = 1;
    function settle(d: IDBDatabase | null): void {
      db = d; dbState = 2;
      var waiters = dbWaiters; dbWaiters = [];
      for (var i = 0; i < waiters.length; i++) waiters[i](d);
    }
    try {
      if (typeof indexedDB === "undefined" || !indexedDB) { settle(null); return; }
      var req = indexedDB.open("klaus-clips", 1);
      req.onupgradeneeded = function (): void { req.result.createObjectStore("clips"); };
      req.onsuccess = function (): void { settle(req.result); };
      req.onerror = function (): void { settle(null); };
    } catch (_e) { settle(null); }
  }

  export function clipPut(sessionId: string, blob: Blob): void {
    withDb(function (d: IDBDatabase | null): void {
      if (!d) return;
      try { d.transaction("clips", "readwrite").objectStore("clips").put(blob, sessionId); } catch (_e) { /* best effort */ }
    });
  }

  export function clipGet(sessionId: string, cb: (blob: Blob | null) => void): void {
    withDb(function (d: IDBDatabase | null): void {
      if (!d) { cb(null); return; }
      try {
        var req = d.transaction("clips", "readonly").objectStore("clips").get(sessionId);
        req.onsuccess = function (): void { cb(req.result || null); };
        req.onerror = function (): void { cb(null); };
      } catch (_e) { cb(null); }
    });
  }

  export function clipDelete(sessionId: string): void {
    withDb(function (d: IDBDatabase | null): void {
      if (!d) return;
      try { d.transaction("clips", "readwrite").objectStore("clips").delete(sessionId); } catch (_e) { /* best effort */ }
    });
  }
}
