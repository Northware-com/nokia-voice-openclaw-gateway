// KaiOS privileged app — ES5 target, no external deps.
// Runtime config is injected via config.js (excluded from zip unless packaged
// with environment variables NOKIA_BRIDGE_URL and NOKIA_CONFIG_FILE).

type LegacyNavigator = Navigator & {
  getUserMedia?: (constraints: MediaStreamConstraints, success: (stream: MediaStream) => void, failure: (error: Error) => void) => void;
  mozAudioChannelManager?: { volumeControlChannel: string };
};

type RuntimeConfig = { bridgeUrl: string; bridgeToken: string };

declare var NOKIA_RUNTIME_CONFIG: RuntimeConfig | undefined;

// "cancelling": cancel POST fired, poll continues until server confirms.
type SessionState = "idle" | "pending" | "complete" | "error" | "cancelled" | "uncertain" | "cancelling";

type ApiMessage = { role: "user" | "assistant"; text: string };

type LocalSession = {
  id: string;                 // local stable key (may be legacy non-UUID)
  title: string;
  clientId: string;           // UUID for server dedup; also X-Request-Id on POST /sessions
  serverId: string | null;    // server-assigned session id once created
  serverState: SessionState;
  messages: ApiMessage[];
  runId: string | null;
  lastRequestId: string | null;   // H3: UUID for POST /turns, persisted for uncertain recovery
  cancelRequestId: string | null; // H4: UUID for POST .../cancel, generated once per attempt
  archived: boolean;          // H9: archived sessions hidden from navigation but retained
  pollTimer: any;             // setInterval handle
  pollXhr: XMLHttpRequest | null; // H4: at-most-one concurrent poll XHR per session
  uploadPending: boolean;     // audio blob waiting for connection
  uploadBlob: Blob | null;
  transcriptScroll: number;   // px offset for scroll
};

type SessionMedia = { url: string | null };

(function (): void {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  var statusEl = document.getElementById("status") as HTMLElement;
  var player = document.getElementById("player") as HTMLAudioElement & { mozAudioChannelType?: string };
  player.mozAudioChannelType = "content";
  var softkeyEl = document.getElementById("softkey") as HTMLElement;
  var titleNode = document.getElementById("session-title") as HTMLElement;
  var indexNode = document.getElementById("session-index") as HTMLElement;
  var transcriptEl = document.getElementById("transcript") as HTMLElement;
  var connectionEl = document.getElementById("connection") as HTMLElement;
  var nav = navigator as LegacyNavigator;
  if (nav.mozAudioChannelManager) nav.mozAudioChannelManager.volumeControlChannel = "content";

  // ── Runtime config ────────────────────────────────────────────────────────
  var cfg: RuntimeConfig = { bridgeUrl: "", bridgeToken: "" };
  try {
    if (typeof NOKIA_RUNTIME_CONFIG !== "undefined" && NOKIA_RUNTIME_CONFIG) {
      cfg = NOKIA_RUNTIME_CONFIG;
    }
  } catch (_e) { /* config not injected — offline mode */ }
  var connected = !!(cfg.bridgeUrl && cfg.bridgeToken);

  // ── UUID generation ───────────────────────────────────────────────────────
  function makeUUID(): string {
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
    function hex(b: number): string { return (b < 16 ? "0" : "") + b.toString(16); }
    return hex(bytes[0]) + hex(bytes[1]) + hex(bytes[2]) + hex(bytes[3]) + "-" +
           hex(bytes[4]) + hex(bytes[5]) + "-" +
           hex(bytes[6]) + hex(bytes[7]) + "-" +
           hex(bytes[8]) + hex(bytes[9]) + "-" +
           hex(bytes[10]) + hex(bytes[11]) + hex(bytes[12]) + hex(bytes[13]) + hex(bytes[14]) + hex(bytes[15]);
  }

  function makeLegacyId(): string { return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2); }

  // ── Persistent storage ────────────────────────────────────────────────────
  var storageKey = "klaus.sessions.v2";
  var legacyV1Key = "klaus.local.sessions.v1"; // H1: migration source
  var sessions: LocalSession[] = [];

  function blankSession(title: string): LocalSession {
    return {
      id: makeLegacyId(), title: title,
      clientId: makeUUID(), serverId: null,
      serverState: "idle", messages: [], runId: null,
      lastRequestId: null, cancelRequestId: null,
      archived: false,
      pollTimer: null, pollXhr: null,
      uploadPending: false, uploadBlob: null,
      transcriptScroll: 0
    };
  }

  // H3/H4: validate messages from server — role, text bounds, and aggregate session cap.
  // Bounded: 128 messages per session, 65536 chars per message text,
  // 64k aggregate chars per session. Persisted store capped at 1MiB total.
  function validateMessages(arr: any[]): ApiMessage[] {
    var out: ApiMessage[] = [];
    var totalChars = 0;
    for (var mi = 0; mi < arr.length && mi < 128; mi++) {
      var m = arr[mi];
      if (m && (m.role === "user" || m.role === "assistant") &&
          typeof m.text === "string" && m.text.length <= 65536) {
        totalChars += m.text.length;
        if (totalChars > 65536) break; // 64k aggregate chars per session
        out.push({ role: m.role, text: m.text });
      }
    }
    return out;
  }

  function mapStoredSession(item: any): LocalSession {
    return {
      id: item.id,
      title: item.title,
      clientId: typeof item.clientId === "string" && item.clientId ? item.clientId : makeUUID(),
      serverId: typeof item.serverId === "string" ? item.serverId : null,
      serverState: (item.serverState || "idle") as SessionState,
      messages: Array.isArray(item.messages) ? validateMessages(item.messages) : [],
      runId: typeof item.runId === "string" ? item.runId : null,
      lastRequestId: typeof item.lastRequestId === "string" ? item.lastRequestId : null,
      cancelRequestId: typeof item.cancelRequestId === "string" ? item.cancelRequestId : null,
      archived: item.archived === true,
      pollTimer: null,
      pollXhr: null,
      uploadPending: false,
      uploadBlob: null,
      transcriptScroll: 0
    };
  }

  function filterDedup(arr: any[]): any[] {
    return arr.filter(function (item: any, idx: number, a: any[]): boolean {
      return item && typeof item.id === "string" && !!item.id &&
             typeof item.title === "string" && !!item.title &&
             !a.slice(0, idx).some(function (o: any): boolean { return o && o.id === item.id; });
    });
  }

  try {
    var stored = localStorage.getItem(storageKey);
    if (stored) {
      var parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        sessions = filterDedup(parsed as any[]).map(mapStoredSession);
      }
    }
  } catch (_e) { sessions = []; }

  // H1: Migrate legacy v1 storage when v2 is empty ─────────────────────────
  if (!sessions.length) {
    try {
      var v1raw = localStorage.getItem(legacyV1Key);
      if (v1raw) {
        var v1parsed = JSON.parse(v1raw);
        if (Array.isArray(v1parsed)) {
          sessions = filterDedup(v1parsed as any[]).map(mapStoredSession);
        }
      }
    } catch (_e2) { sessions = []; }
  }

  // Cap at 128 total sessions (open + archived)
  if (sessions.length > 128) sessions = sessions.slice(0, 128);

  if (!sessions.length) sessions = [blankSession("Conversation 1")];

  var active = 0;
  try {
    // H1: check v2 active key first, then legacy v1 active key
    var savedActive = localStorage.getItem(storageKey + ".active") ||
                      localStorage.getItem(legacyV1Key + ".active");
    sessions.forEach(function (s: LocalSession, i: number): void { if (s.id === savedActive) active = i; });
  } catch (_e) { /* use default */ }

  // Ensure active points to a non-archived session
  function findFirstOpen(): number {
    for (var fi = 0; fi < sessions.length; fi++) {
      if (!sessions[fi].archived) return fi;
    }
    return -1; // all archived — shouldn't happen due to createFresh guard
  }
  if (sessions[active].archived) {
    var fo = findFirstOpen();
    active = fo >= 0 ? fo : 0;
  }

  function persist(): void {
    try {
      var toStore = sessions.map(function (s: LocalSession): any {
        return {
          id: s.id, title: s.title, clientId: s.clientId,
          serverId: s.serverId, serverState: s.serverState,
          messages: s.messages, runId: s.runId,
          lastRequestId: s.lastRequestId,
          cancelRequestId: s.cancelRequestId,   // H4: persist for retry
          archived: s.archived
        };
      });
      // H4: Cap persisted store at 1MiB total. If exceeded, trim oldest messages from
      //     sessions (keeping all IDs and metadata) until under limit.
      var raw = JSON.stringify(toStore);
      if (raw.length > 1048576) {
        var trimmed = toStore.map(function (s: any): any {
          return {
            id: s.id, title: s.title, clientId: s.clientId,
            serverId: s.serverId, serverState: s.serverState,
            messages: s.messages ? s.messages.slice() : [],
            runId: s.runId, lastRequestId: s.lastRequestId,
            cancelRequestId: s.cancelRequestId,
            archived: s.archived
          };
        });
        var iter = 0;
        while (JSON.stringify(trimmed).length > 1048576 && iter < 1000) {
          iter++;
          // Find session with most messages and drop its oldest message
          var maxI = 0;
          for (var si = 1; si < trimmed.length; si++) {
            if (trimmed[si].messages.length > trimmed[maxI].messages.length) maxI = si;
          }
          if (!trimmed[maxI].messages.length) break;
          trimmed[maxI].messages.shift();
        }
        raw = JSON.stringify(trimmed);
      }
      localStorage.setItem(storageKey, raw);
      localStorage.setItem(storageKey + ".active", sessions[active].id);
    } catch (_e) { say("Storage unavailable; labels may not persist."); }
  }

  // ── In-memory media per session ──────────────────────────────────────────
  var sessionMedia: { [id: string]: SessionMedia } = Object.create(null);

  // ── Per-session recording state (local capture only) ─────────────────────
  var stream: MediaStream | null = null;
  var recorder: MediaRecorder | null = null;
  var chunks: Blob[] = [];
  var generation = 0;
  var busy = false;

  // ── Archive confirmation state ────────────────────────────────────────────
  // pendingArchive: true when user pressed 7 once and we're awaiting confirmation.
  // A second 7 confirms; Back/Escape cancels.
  var pendingArchive = false;

  // ── TTS queue ─────────────────────────────────────────────────────────────
  // Serialized utterance queue. Replies are bound to their session at enqueue time.
  // Switching sessions does not abort pending utterances already in the queue.
  var ttsQueue: Array<{ text: string; sessionId: string; token: number }> = [];
  var ttsSpeaking = false;
  var ttsToken = 0; // H7: generation token to guard stale onend callbacks

  function speakNext(): void {
    if (ttsSpeaking || !ttsQueue.length) return;
    var item = ttsQueue.shift()!;
    var myToken = ++ttsToken;
    try {
      var utter = new SpeechSynthesisUtterance(item.text);
      utter.lang = "en-US";
      utter.onend = function (): void {
        // H7: only advance if this utterance's token is still current
        if (ttsToken === myToken) { ttsSpeaking = false; speakNext(); }
      };
      utter.onerror = function (): void {
        if (ttsToken === myToken) { ttsSpeaking = false; speakNext(); }
      };
      ttsSpeaking = true;
      speechSynthesis.speak(utter);
    } catch (_e) { ttsSpeaking = false; speakNext(); }
  }

  function enqueueReply(text: string, sessionId: string): void {
    // H7: deduplicate — don't re-enqueue the same text for same session if already queued
    for (var qi = 0; qi < ttsQueue.length; qi++) {
      if (ttsQueue[qi].sessionId === sessionId && ttsQueue[qi].text === text) return;
    }
    ttsQueue.push({ text: text, sessionId: sessionId, token: 0 });
    speakNext();
  }

  // H7: Replay last assistant reply for selected session only.
  // Serializes replay at head of queue WITHOUT discarding other pending utterances.
  // Cancels current speech only; other sessions' queued items survive and play after.
  function replaySelectedReply(): void {
    var sess = sessions[active];
    var lastAssistant: string | null = null;
    for (var i = sess.messages.length - 1; i >= 0; i--) {
      if (sess.messages[i].role === "assistant") { lastAssistant = sess.messages[i].text; break; }
    }
    if (!lastAssistant) { say("No reply in this session yet."); return; }
    // H7: Cancel current speech only, bump token to invalidate its onend callback.
    // Do NOT clear ttsQueue — other sessions' queued utterances must survive.
    try { speechSynthesis.cancel(); } catch (_e) {}
    ttsToken++; // invalidate current utterance's onend only
    ttsSpeaking = false;
    // Remove any existing queued entry for this text+session (dedup before unshift)
    for (var qi = ttsQueue.length - 1; qi >= 0; qi--) {
      if (ttsQueue[qi].sessionId === sess.id && ttsQueue[qi].text === lastAssistant) {
        ttsQueue.splice(qi, 1);
      }
    }
    // Insert replay item at head of queue (plays next, before other queued items)
    ttsQueue.unshift({ text: lastAssistant, sessionId: sess.id, token: 0 });
    speakNext();
    say("Replaying last reply…");
  }

  // ── XHR helper (mozSystem privileged) ────────────────────────────────────
  // Use constructor form new XMLHttpRequest({mozSystem:true}) per Gecko 48 spec.
  // After construction verify req.mozSystem === true: if the permission was not
  // granted (old install without new manifest) the flag stays false and the cross-
  // origin request would silently fail or be blocked. Surface an honest error;
  // never fall back to query-param tokens.
  function xhr(method: string, url: string, opts: {
    body?: string | Blob | null;
    contentType?: string;
    requestId?: string;
    onSuccess: (status: number, text: string) => void;
    onError: (err: string) => void;
  }): XMLHttpRequest | null {
    var XHRCtor = XMLHttpRequest as any;
    var req: XMLHttpRequest & { mozSystem?: boolean };
    try {
      req = new XHRCtor({ mozSystem: true });
    } catch (_e) {
      req = new XMLHttpRequest() as XMLHttpRequest & { mozSystem?: boolean };
    }
    if (!req.mozSystem) {
      // Permission not granted — manifest not reinstalled with systemXHR.
      opts.onError("systemXHR permission not active. Reinstall app with updated manifest.");
      return null;
    }
    req.open(method, url, true);
    req.setRequestHeader("Authorization", "Bearer " + cfg.bridgeToken);
    if (opts.contentType) req.setRequestHeader("Content-Type", opts.contentType);
    if (opts.requestId) req.setRequestHeader("X-Request-Id", opts.requestId);
    req.onload = function (): void { opts.onSuccess(req.status, req.responseText); };
    req.onerror = function (): void { opts.onError("Network error"); };
    req.ontimeout = function (): void { opts.onError("Request timed out"); };
    req.timeout = 30000;
    req.send(opts.body || null);
    return req;
  }

  // ── Connection indicator ──────────────────────────────────────────────────
  // H2: CONNECTED requires both an authenticated GET /sessions (HTTP non-401/403) and
  //     a healthy /health (HTTP 200 + connected===true). GET /sessions triggers the
  //     gateway cold start; /health alone cannot. 401/403 on GET /sessions → AUTH ERROR.
  function updateConnectionIndicator(): void {
    if (!connected) { connectionEl.textContent = "NOT CONNECTED"; return; }
    // Step 1: authenticated GET /sessions — auth probe + cold-start trigger
    xhr("GET", cfg.bridgeUrl + "/sessions", {
      onSuccess: function (sessStatus: number, _text: string): void {
        if (sessStatus === 401 || sessStatus === 403) {
          connectionEl.textContent = "AUTH ERROR"; return;
        }
        // Step 2: health check
        xhr("GET", cfg.bridgeUrl + "/health", {
          onSuccess: function (healthStatus: number, text: string): void {
            if (healthStatus !== 200) { connectionEl.textContent = "GATEWAY DOWN"; return; }
            try {
              var r = JSON.parse(text);
              connectionEl.textContent = r.connected === true ? "CONNECTED" : "GATEWAY DOWN";
            } catch (_e) { connectionEl.textContent = "GATEWAY DOWN"; }
          },
          onError: function (): void { connectionEl.textContent = "UNREACHABLE"; }
        });
      },
      onError: function (): void { connectionEl.textContent = "UNREACHABLE"; }
    });
  }

  // ── Transcript UI ─────────────────────────────────────────────────────────
  var SCROLL_STEP = 40; // px per key press

  function renderTranscript(): void {
    var sess = sessions[active];
    if (!sess.messages.length) {
      transcriptEl.innerHTML = '<p class="tx-empty">No messages yet.</p>';
    } else {
      var html = "";
      for (var i = 0; i < sess.messages.length; i++) {
        var msg = sess.messages[i];
        var cls = msg.role === "user" ? "tx-user" : "tx-bot";
        var label = msg.role === "user" ? "You" : "Klaus";
        html += '<p class="' + cls + '"><span class="tx-label">' + label + '</span> ' +
                escapeHtml(msg.text) + '</p>';
      }
      transcriptEl.innerHTML = html;
    }
    // Restore scroll position
    transcriptEl.scrollTop = sess.transcriptScroll;
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // H8: Clamp scroll to [0, scrollHeight - clientHeight] to prevent unbounded offset
  function clampedScrollMax(): number {
    var sh = transcriptEl.scrollHeight || 0;
    var ch = (transcriptEl as any).clientHeight || 0;
    return Math.max(0, sh - ch);
  }

  function scrollTranscript(delta: number): void {
    var sess = sessions[active];
    var maxScroll = clampedScrollMax();
    sess.transcriptScroll = Math.min(maxScroll, Math.max(0, sess.transcriptScroll + delta));
    transcriptEl.scrollTop = sess.transcriptScroll;
  }

  function transcriptScrollToBottom(): void {
    var sess = sessions[active];
    // H8: use actual scrollHeight rather than storing it unbounded
    sess.transcriptScroll = clampedScrollMax();
    transcriptEl.scrollTop = sess.transcriptScroll;
  }

  // ── Status + soft key ─────────────────────────────────────────────────────
  function say(message: string): void { statusEl.textContent = message; }

  function updateSoftkey(): void {
    var sess = sessions[active];
    var hasBotReply = sess.messages.some(function (m: ApiMessage): boolean { return m.role === "assistant"; });
    if (!player.paused) { softkeyEl.textContent = "Stop"; return; }
    if (hasBotReply) { softkeyEl.textContent = "Replay reply"; return; }
    var media = sessionMedia[sess.id];
    if (media && media.url) { softkeyEl.textContent = "Replay audio"; return; }
    softkeyEl.textContent = "Replay";
  }

  // ── Open session navigation helpers ───────────────────────────────────────
  // Count non-archived sessions for header display
  function openCount(): number {
    var n = 0;
    for (var oi = 0; oi < sessions.length; oi++) { if (!sessions[oi].archived) n++; }
    return n;
  }

  // Return the 1-based index of `active` among open sessions only
  function openIndex(): number {
    var n = 0;
    for (var oi = 0; oi < sessions.length; oi++) {
      if (!sessions[oi].archived) { n++; if (oi === active) return n; }
    }
    return 1;
  }

  // ── Session display update ────────────────────────────────────────────────
  function updateSession(): void {
    var sess = sessions[active];
    titleNode.textContent = sess.title;
    // H9: header index/count reflects open sessions only
    indexNode.textContent = "SESSION " + openIndex() + " / " + openCount();
    var media = sessionMedia[sess.id];
    var recordingUrl = media ? media.url : null;
    player.pause(); player.removeAttribute("src");
    if (recordingUrl) player.src = recordingUrl;
    updateSoftkey();
    renderTranscript();
    // Show pending state
    if (sess.serverState === "pending" || sess.serverState === "uncertain" ||
        sess.serverState === "cancelling") {
      say("Waiting for Klaus reply…");
    } else if (sess.serverState === "error") {
      say("Error: " + (sess.messages.length ? "see transcript." : "request failed."));
    } else if (sess.uploadPending) {
      say("Audio queued — not sent (offline). Centre retries.");
    } else {
      say("Ready. Centre records; 5 replays; ↑↓ scroll.");
    }
  }

  // ── Local recording helpers ───────────────────────────────────────────────
  function stopTracks(): void {
    if (stream) { stream.getTracks().forEach(function (t: MediaStreamTrack): void { t.stop(); }); stream = null; }
  }

  function clearRecording(): void {
    player.pause(); player.removeAttribute("src");
    var sess = sessions[active];
    var current = sessionMedia[sess.id];
    if (current && current.url) URL.revokeObjectURL(current.url);
    delete sessionMedia[sess.id];
    chunks = [];
    updateSoftkey();
  }

  // cancelLocalCapture: cancel only local recording/mic, NOT server requests or polls
  function cancelLocalCapture(message?: string): void {
    generation++;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try { recorder.stop(); } catch (_e) { /* already stopped */ }
    }
    recorder = null;
    stopTracks();
    busy = false;
    chunks = [];
    player.pause();
    if (message) say(message);
  }

  // cancelSession: cancel a specific session's server poll.
  // H4: fire cancel POST whenever serverId is known; keep polling until server confirms.
  // Uses "cancelling" state so poll loop continues (not "cancelled" which stops it).
  // Cancel body: {turnRequestId: sess.lastRequestId} to target only the current run.
  function cancelSession(sessIdx: number): void {
    var sess = sessions[sessIdx];
    if (sess.serverState === "pending" || sess.serverState === "uncertain") {
      // H4: Use "cancelling" so poll loop continues waiting for server confirmation.
      // Poll transitions to "cancelled" when server confirms state.
      sess.serverState = "cancelling";
      if (connected && sess.serverId) {
        if (!sess.cancelRequestId) {
          sess.cancelRequestId = makeUUID();
          persist();
        }
        // H4: send lastRequestId so backend only cancels this specific run, not a future one.
        var cancelBody = JSON.stringify({ turnRequestId: sess.lastRequestId || null });
        xhr("POST", cfg.bridgeUrl + "/sessions/" + sess.serverId + "/cancel", {
          contentType: "application/json",
          requestId: sess.cancelRequestId,
          body: cancelBody,
          onSuccess: function (): void { /* best-effort; poll will confirm */ },
          onError: function (): void { /* best-effort; poll will confirm */ }
        });
        // H4: keep polling until server confirms cancellation; don't clear timer here
      } else {
        // No server session known — safe to stop polling immediately and mark cancelled
        if (sess.pollTimer) { clearInterval(sess.pollTimer); sess.pollTimer = null; }
        sess.serverState = "cancelled";
      }
      persist();
      if (sessIdx === active) say("Cancelled.");
    } else {
      // Not pending/uncertain — just clear the timer
      if (sess.pollTimer) { clearInterval(sess.pollTimer); sess.pollTimer = null; }
    }
  }

  // Back key: cancel active session's server request + local capture.
  // Also cancels a pending archive confirmation.
  function cancelActiveAll(): void {
    if (pendingArchive) {
      pendingArchive = false;
      updateSession(); // restore normal status
      return;
    }
    cancelLocalCapture();
    cancelSession(active);
    if (sessions[active].uploadPending) {
      sessions[active].uploadPending = false;
      sessions[active].uploadBlob = null;
    }
    say("Cancelled. Centre records; 5 replays; ↑↓ scroll.");
  }

  // ── switchSession: navigate to adjacent open (non-archived) session ───────
  function switchSession(direction: number): void {
    if (openCount() === 1) {
      say("Only one session. Press 3 for new.");
      return;
    }
    // Only cancel local microphone capture — not any session's server state
    cancelLocalCapture();
    pendingArchive = false;
    // Walk in direction until we find the next non-archived session
    var next = active;
    var step = direction > 0 ? 1 : -1;
    for (var wi = 0; wi < sessions.length; wi++) {
      next = (next + step + sessions.length) % sessions.length;
      if (!sessions[next].archived) break;
    }
    active = next;
    persist();
    updateSession();
    // Announce wrap-around (wrap detected if we passed start/end)
    var didWrap = (direction > 0 && next <= sessions.indexOf(sessions[active]) && active !== next) ||
                  false; // simple: always show index, wrap is cosmetic
    // (wrap announcement is implicit from the SESSION X/Y display)
  }

  // ── newSession ────────────────────────────────────────────────────────────
  function newSession(): void {
    // H5: cap at 128 total sessions (open + archived)
    if (sessions.length >= 128) {
      say("Maximum 128 sessions reached. Archive or use Left/Right.");
      return;
    }
    cancelLocalCapture();
    pendingArchive = false;
    var newIdx = openCount() + 1;
    sessions.push(blankSession("Conversation " + newIdx));
    active = sessions.length - 1;
    persist();
    updateSession();
    say("Created Conversation " + newIdx + ". Centre to record.");
  }

  // ── H9: Archive ───────────────────────────────────────────────────────────
  // 7 → first press shows confirmation prompt via status bar.
  // 7 again → confirms archive: hides from Left/Right, creates fresh if last open.
  // Back → cancels confirmation (no side effect).
  // Archived sessions continue polling and serialized TTS; no server RPC.
  function archiveConfirmOrExecute(): void {
    if (!pendingArchive) {
      // First press — show confirmation via status UI
      pendingArchive = true;
      say("Archive \"" + sessions[active].title + "\"? Press 7 again to confirm, Back to cancel.");
      return;
    }
    // Second press — execute archive
    pendingArchive = false;
    var oc = openCount();
    if (oc <= 1) {
      // Last open session — create a fresh one before archiving
      if (sessions.length >= 128) {
        say("At 128-session cap. Cannot archive last session (would exceed cap with new one).");
        return;
      }
      var freshIdx = openCount() + 1; // = 1 after archive
      sessions[active].archived = true;
      sessions.push(blankSession("Conversation " + freshIdx));
      active = sessions.length - 1;
    } else {
      // There are other open sessions — archive and move to next open
      sessions[active].archived = true;
      persist();
      // Find next open session
      var nextOpen = -1;
      for (var ai = (active + 1) % sessions.length; ; ai = (ai + 1) % sessions.length) {
        if (!sessions[ai].archived) { nextOpen = ai; break; }
        if (ai === active) break; // full loop — shouldn't happen
      }
      active = nextOpen >= 0 ? nextOpen : active;
    }
    persist();
    updateSession();
    say("Archived. Use ← / → to switch sessions.");
  }

  // ── Server API: ensure session exists on server ───────────────────────────
  function ensureServerSession(sess: LocalSession, cb: (ok: boolean) => void): void {
    if (!connected) { cb(false); return; }
    if (sess.serverId) { cb(true); return; }
    xhr("POST", cfg.bridgeUrl + "/sessions", {
      contentType: "application/json",
      requestId: sess.clientId,  // stable per-session; backend requires X-Request-Id on all POSTs
      body: JSON.stringify({ title: sess.title, clientId: sess.clientId }),
      onSuccess: function (status: number, text: string): void {
        if (status === 200 || status === 201) {
          try {
            var r = JSON.parse(text);
            sess.serverId = r.id;
            persist();
            cb(true);
          } catch (_e) { say("Server error: bad response."); cb(false); }
        } else {
          say("Server error: " + status + ". Not connected.");
          cb(false);
        }
      },
      onError: function (err: string): void { say("Network error: " + err + "."); cb(false); }
    });
  }

  // ── Polling ───────────────────────────────────────────────────────────────
  var POLL_INTERVAL = 2500;
  var POLL_MAX = 60; // max poll cycles ~2.5min

  // H4: poll with sequence/generation guards and at-most-one concurrent XHR per session.
  // Continues polling while state is "pending", "uncertain", OR "cancelling".
  // Archived sessions continue polling — no auto-unarchive.
  function startPolling(sess: LocalSession): void {
    if (sess.pollTimer) return; // already polling
    var pollCount = 0;
    var pollGen = 0; // monotonic generation to detect overlapping polls
    sess.pollTimer = setInterval(function (): void {
      if (!sess.serverId) { clearInterval(sess.pollTimer); sess.pollTimer = null; return; }
      if (sess.serverState !== "pending" && sess.serverState !== "uncertain" &&
          sess.serverState !== "cancelling") {
        // State became complete/error/cancelled/idle — stop polling
        clearInterval(sess.pollTimer); sess.pollTimer = null; return;
      }
      pollCount++;
      if (pollCount > POLL_MAX) {
        clearInterval(sess.pollTimer); sess.pollTimer = null;
        sess.serverState = "uncertain";
        persist();
        if (sess.id === sessions[active].id) say("No reply yet — session uncertain. Back to cancel.");
        return;
      }
      // H4: at-most-one concurrent poll XHR per session
      if (sess.pollXhr) return;
      var myPollGen = ++pollGen;
      sess.pollXhr = xhr("GET", cfg.bridgeUrl + "/sessions/" + sess.serverId, {
        onSuccess: function (pollStatus: number, text: string): void {
          sess.pollXhr = null;
          // H4: stale response guard
          if (myPollGen !== pollGen) return;
          // H2/H4: auth errors must surface, not be silently dropped
          if (pollStatus === 401 || pollStatus === 403) {
            clearInterval(sess.pollTimer); sess.pollTimer = null;
            sess.serverState = "error";
            persist();
            if (sess.id === sessions[active].id) say("Auth error (" + pollStatus + ") during poll. Check bridge config.");
            return;
          }
          if (pollStatus !== 200) {
            // Non-200 non-auth: keep polling (transient error)
            if (sess.id === sessions[active].id) say("Poll error " + pollStatus + ". Retrying…");
            return;
          }
          try {
            var r = JSON.parse(text);
            var wasActive = (sess.id === sessions[active].id);
            var newMsgs: ApiMessage[] = Array.isArray(r.messages)
              ? validateMessages(r.messages) : [];
            // H4: sequence guard — only update if new message count >= current
            // (prevents older poll overwriting a newer run's completion)
            if (newMsgs.length < sess.messages.length && sess.serverState === "complete") return;
            var oldCount = sess.messages.length;
            sess.messages = newMsgs;
            if (r.runId) sess.runId = r.runId;
            var newState = (r.state || "idle") as SessionState;
            // H4: don't let an older pending response overwrite a later completed/cancelled state
            var overwriteAllowed = true;
            if ((sess.serverState === "complete" || sess.serverState === "cancelled") &&
                (newState === "pending" || newState === "idle")) {
              overwriteAllowed = false;
            }
            if (overwriteAllowed) sess.serverState = newState;
            persist();
            // Enqueue new assistant replies for TTS (only if not recording)
            if (!busy) {
              for (var i = oldCount; i < newMsgs.length; i++) {
                if (newMsgs[i].role === "assistant") {
                  enqueueReply(newMsgs[i].text, sess.id);
                }
              }
            }
            if (sess.serverState !== "pending" && sess.serverState !== "uncertain" &&
                sess.serverState !== "cancelling") {
              clearInterval(sess.pollTimer); sess.pollTimer = null;
            }
            if (wasActive) {
              renderTranscript();
              transcriptScrollToBottom();
              updateSoftkey();
              if (sess.serverState === "complete") {
                say("Klaus replied. 5 to replay; ↑↓ scroll.");
              } else if (sess.serverState === "error") {
                say("Error from Klaus: " + (r.error || "unknown") + ".");
              } else if (sess.serverState === "cancelled" || sess.serverState === "cancelling") {
                say("Request cancelled.");
              }
            }
          } catch (_e) {
            if (sess.id === sessions[active].id) say("Poll parse error. Still waiting…");
          }
        },
        onError: function (): void {
          sess.pollXhr = null;
          // transient network error — keep polling
          if (sess.id === sessions[active].id) say("Network error while waiting. Retrying…");
        }
      });
    }, POLL_INTERVAL);
  }

  // ── Submit audio turn ─────────────────────────────────────────────────────
  // H3: Set serverState = "pending" and persist lastRequestId BEFORE ensureServerSession
  //     to prevent concurrent duplicate captures for the same session.
  //     Guard: if session is already pending/uncertain/cancelling, block resubmit.
  function submitAudio(blob: Blob, sess: LocalSession): void {
    if (!connected) {
      sess.uploadPending = true;
      sess.uploadBlob = blob;
      say("Not connected — audio saved locally. Configure bridge to send.");
      persist();
      return;
    }
    // H3: Guard same-session concurrent/uncertain/cancelling — don't allow resubmit
    if (sess.serverState === "pending" || sess.serverState === "uncertain" ||
        sess.serverState === "cancelling") {
      say("Request already in progress. Back to cancel, then retry.");
      return;
    }
    var requestId = makeUUID();
    // H4: Clear stale cancelRequestId so next cancel attempt gets a fresh UUID
    sess.cancelRequestId = null;
    // H3: Set pending and store requestId BEFORE the async ensureServerSession call
    sess.serverState = "pending";
    sess.lastRequestId = requestId;
    sess.runId = null;
    sess.uploadPending = false;
    sess.uploadBlob = null;
    persist();
    if (sess.id === sessions[active].id) say("Waiting for Klaus reply…");
    ensureServerSession(sess, function (ok: boolean): void {
      if (!ok) {
        // If we never got a server session, revert to idle so user can retry
        if (sess.serverState === "pending" && sess.lastRequestId === requestId) {
          sess.serverState = "idle";
          sess.uploadPending = true;
          sess.uploadBlob = blob;
        }
        say("Could not create server session. Audio saved locally.");
        persist();
        return;
      }
      // Double-check session wasn't cancelled while ensureServerSession was in-flight
      if (sess.lastRequestId !== requestId) return;
      if (sess.id === sessions[active].id) say("Sending to Klaus…");
      xhr("POST", cfg.bridgeUrl + "/sessions/" + sess.serverId + "/turns", {
        contentType: "audio/ogg",
        requestId: requestId,
        body: blob,
        onSuccess: function (status: number, text: string): void {
          if (status === 202 || status === 200) {
            try {
              var r = JSON.parse(text);
              sess.runId = r.runId || null;
              sess.serverState = (r.state || "pending") as SessionState;
            } catch (_e) {
              sess.serverState = "pending";
            }
            persist();
            startPolling(sess);
            if (sess.id === sessions[active].id) say("Waiting for Klaus reply…");
          } else if (status === 401 || status === 403) {
            sess.serverState = "error";
            persist();
            if (sess.id === sessions[active].id) say("Auth error (" + status + "). Check bridge config.");
          } else {
            // H3: network/server error AFTER submission — state is uncertain (backend may have received)
            sess.serverState = "uncertain";
            persist();
            startPolling(sess); // H3: poll to discover actual state
            if (sess.id === sessions[active].id)
              say("Submit error: " + status + ". Checking server state…");
          }
        },
        onError: function (err: string): void {
          // H3: network/timeout after submission — uncertain, poll ownedServerId
          if (sess.lastRequestId === requestId) {
            sess.serverState = "uncertain";
            persist();
            if (sess.serverId) startPolling(sess);
          }
          if (sess.id === sessions[active].id)
            say("Network error: " + err + ". Checking server state…");
        }
      });
    });
  }

  // ── Recording ─────────────────────────────────────────────────────────────
  function startRecording(): void {
    if (busy) return;
    var sess = sessions[active];
    // Guard: if a server request is in-flight or cancelling, give clear feedback
    // before requesting mic permission.
    if (sess.serverState === "pending" || sess.serverState === "uncertain" ||
        sess.serverState === "cancelling") {
      say("Request in progress. Back to cancel, then record.");
      return;
    }
    pendingArchive = false;
    player.pause(); busy = true; chunks = [];
    var requestId = ++generation;
    // Inhibit TTS while recording to avoid transcribing Klaus's voice.
    // Bump ttsToken to invalidate the current utterance's onend callback only.
    try { speechSynthesis.cancel(); } catch (_e) {}
    ttsToken++;
    ttsSpeaking = false;
    say("Requesting microphone permission…");

    function onStream(value: MediaStream): void {
      if (requestId !== generation) { value.getTracks().forEach(function (t: MediaStreamTrack): void { t.stop(); }); return; }
      stream = value;
      try {
        var activeRecorder = new MediaRecorder(value); recorder = activeRecorder; chunks = [];
        activeRecorder.ondataavailable = function (event: BlobEvent): void {
          if (requestId === generation && event.data && event.data.size) chunks.push(event.data);
        };
        activeRecorder.onerror = function (): void {
          if (requestId !== generation) return;
          cancelLocalCapture("Recording failed. Press Centre to retry.");
        };
        activeRecorder.onstop = function (): void {
          if (requestId !== generation) return;
          stopTracks(); recorder = null; busy = false; generation++;
          if (!chunks.length) { say("No audio captured. Centre retries."); return; }
          try {
            var blob = new Blob(chunks, { type: activeRecorder.mimeType || "audio/ogg" });
            var url = URL.createObjectURL(blob);
            clearRecording();
            sessionMedia[sess.id] = { url: url }; player.src = url;
            updateSoftkey();
            say("Recording ready. Centre records again; 5 replays; ↑↓ scroll.");
            // Resume TTS for any queued replies now that recording is done
            speakNext();
            // Auto-submit if configured
            submitAudio(blob, sess);
          } catch (_e) { chunks = []; say("Could not save audio. Centre retries."); }
        };
        recorder.start();
        say("Recording… Press Centre to stop, Back to cancel.");
      } catch (_e) { cancelLocalCapture("Recorder unavailable on this device."); }
    }

    function onFailure(_error: Error): void {
      if (requestId !== generation) return;
      busy = false;
      say("Microphone unavailable or permission denied. Press Centre to retry.");
    }

    try {
      if (nav.mediaDevices && nav.mediaDevices.getUserMedia)
        nav.mediaDevices.getUserMedia({ audio: true }).then(onStream, onFailure);
      else if (nav.getUserMedia)
        nav.getUserMedia({ audio: true }, onStream, onFailure);
      else { busy = false; say("Microphone capture is unsupported."); }
    } catch (_e) { onFailure(_e as Error); }
  }

  function toggleRecording(): void {
    if (recorder && recorder.state === "recording") {
      say("Finishing recording…");
      try { recorder.stop(); } catch (_e) { cancelLocalCapture("Recording failed. Centre retries."); }
    } else if (!busy) {
      startRecording();
    }
  }

  // ── Replay ────────────────────────────────────────────────────────────────
  function replayAudio(): void {
    var media = sessionMedia[sessions[active].id];
    if (!media || !media.url || busy) { say("No recording in this session yet."); return; }
    try {
      var result = player.play() as any;
      if (result && typeof result.catch === "function")
        result.catch(function (): void { say("Playback failed. Press Replay to try again."); });
      say("Playing audio… 5 to stop.");
      updateSoftkey();
    } catch (_e) { say("Playback unavailable. Press Replay to try again."); }
  }

  function handleSoftAction(): void {
    if (!player.paused) { player.pause(); say("Playback stopped."); updateSoftkey(); return; }
    var sess = sessions[active];
    var hasBotReply = sess.messages.some(function (m: ApiMessage): boolean { return m.role === "assistant"; });
    if (hasBotReply) { replaySelectedReply(); return; }
    replayAudio();
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  document.addEventListener("keydown", function (event: KeyboardEvent): void {
    if (event.repeat) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); toggleRecording();
    } else if (event.key === "Backspace" || event.key === "Escape") {
      event.preventDefault(); cancelActiveAll();
    } else if (event.key === "ArrowLeft" || (event as any).keyCode === 37) {
      event.preventDefault(); switchSession(-1);
    } else if (event.key === "ArrowRight" || (event as any).keyCode === 39) {
      event.preventDefault(); switchSession(1);
    } else if (event.key === "ArrowUp" || (event as any).keyCode === 38) {
      event.preventDefault(); scrollTranscript(-SCROLL_STEP);
    } else if (event.key === "ArrowDown" || (event as any).keyCode === 40) {
      event.preventDefault(); scrollTranscript(SCROLL_STEP);
    } else if (event.key === "3") {
      event.preventDefault(); newSession();
    } else if (event.key === "5" || event.key === "SoftLeft" || event.key === "SoftRight" || event.key === "r" || event.key === "R") {
      event.preventDefault(); handleSoftAction();
    } else if (event.key === "7") {
      event.preventDefault(); archiveConfirmOrExecute();
    }
  });

  // ── Player events ─────────────────────────────────────────────────────────
  player.addEventListener("ended", function (): void { say("Playback finished. Centre to record."); updateSoftkey(); });
  player.addEventListener("error", function (): void {
    var media = sessionMedia[sessions[active].id];
    if (media && media.url) say("Playback failed on this device.");
    updateSoftkey();
  });

  // ── Visibility / unload ───────────────────────────────────────────────────
  document.addEventListener("visibilitychange", function (): void {
    // Only cancel local capture, not server requests
    if (document.hidden) cancelLocalCapture();
  });

  window.addEventListener("unload", function (): void {
    cancelLocalCapture(); player.removeAttribute("src");
    Object.keys(sessionMedia).forEach(function (id: string): void {
      var m = sessionMedia[id]; if (m.url) URL.revokeObjectURL(m.url);
    });
  });

  // ── Resume polling for any sessions still pending/uncertain/cancelling ────
  sessions.forEach(function (sess: LocalSession): void {
    if (sess.serverState === "pending" || sess.serverState === "uncertain" ||
        sess.serverState === "cancelling") {
      if (connected && sess.serverId) startPolling(sess);
      else sess.serverState = "uncertain";
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  persist();
  updateSession();
  updateConnectionIndicator();
})();
