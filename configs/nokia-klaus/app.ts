// KaiOS privileged app — ES5 target, no external deps. Entry point and controller.
// Built with keys.ts, storage.ts, api.ts, tts.ts and ui.ts into one app.js (see build.sh).
// Runtime config is injected via config.js (blank template unless packaged with
// NOKIA_BRIDGE_URL and NOKIA_CONFIG_FILE).

type LegacyNavigator = Navigator & {
  getUserMedia?: (constraints: MediaStreamConstraints, success: (stream: MediaStream) => void, failure: (error: Error) => void) => void;
  mozAudioChannelManager?: { volumeControlChannel: string };
  vibrate?: (pattern: number[]) => boolean;
  requestWakeLock?: (topic: string) => { unlock: () => void };
};

declare var NOKIA_RUNTIME_CONFIG: Klaus.RuntimeConfig | undefined;

namespace Klaus {
  (function (): void {
    uiInit();
    var player = document.getElementById("player") as HTMLAudioElement & { mozAudioChannelType?: string };
    player.mozAudioChannelType = "content";
    var nav = navigator as LegacyNavigator;
    if (nav.mozAudioChannelManager) nav.mozAudioChannelManager.volumeControlChannel = "content";

    // ── Config ──────────────────────────────────────────────────────────────
    var cfg: RuntimeConfig = { bridgeUrl: "", bridgeToken: "" };
    try {
      if (typeof NOKIA_RUNTIME_CONFIG !== "undefined" && NOKIA_RUNTIME_CONFIG) cfg = NOKIA_RUNTIME_CONFIG;
    } catch (_e) { /* offline mode */ }
    var connected = !!(cfg.bridgeUrl && cfg.bridgeToken);
    var POLL_TIMEOUT = cfg.pollTimeoutMs && cfg.pollTimeoutMs > 0 ? cfg.pollTimeoutMs : 180000;
    // Opus speech bitrate: the lowest that kept a handset test transcript exact
    // (about 3.4 KB/s against 7.8 KB/s at the Gecko default; 12 kbps dropped words).
    var RECORD_BITRATE = 16000;

    // ── State ───────────────────────────────────────────────────────────────
    var loaded = loadSessions();
    var sessions = loaded.sessions;
    var active = loaded.active;
    var mode: Mode = "idle";
    var selected = -1;              // focused message index, -1 = live/newest
    var autoRead = loadSetting("autoread", true);
    var haptics = loadSetting("haptics", true);
    var night = loadSetting("night", false);  // dim warm palette for dark rooms
    var large = loadSetting("large", false);  // bigger message and list text
    var lastErrorBuzz = 0;
    var listIndex = 0;              // menu / session-list cursor
    var listTargets: number[] = []; // session-list item → session index
    var searchOpen = false;         // chat search over the phone-stored chats
    var searchQuery = "";
    var searchIndex = 0;
    var searchHits: SearchHit[] = [];
    var thinkingTicker: any = null;
    var dots = 0;
    var stalled: { [id: string]: boolean } = Object.create(null); // poll timed out
    var sending: { [id: string]: boolean } = Object.create(null); // turn POST in flight
    // The bridge exposes final state plus complete messages, not tool events or token
    // streaming. Keep this deliberately limited to honest transport phases.
    var progress: { [id: string]: string } = Object.create(null);
    var resend: { [id: string]: { requestId: string; blob: Blob | null; text: string | null; audio: boolean } } = Object.create(null);
    var sessionMedia: { [id: string]: string } = Object.create(null); // local recording URLs

    // Recording
    var stream: MediaStream | null = null;
    var analyser: AnalyserNode | null = null;
    var meterTimer: any = null;
    var recorder: MediaRecorder | null = null;
    var chunks: Blob[] = [];
    var generation = 0;
    var busy = false;
    var stopRequested = false;
    var recStart = 0; // start of the current running segment
    var recAccum = 0; // ms recorded in earlier segments
    var recTicker: any = null;
    var canResume = false; // recorder supports pause()/resume()
    var sendOnStop = true; // false: a stop is a pause fallback that keeps the clip
    var heldClip: Blob | null = null; // stopped-as-pause clip waiting for Send
    var discardArmed = false;
    // Primed microphone: opened while idle so Centre starts the recorder at once.
    var primed: MediaStream | null = null;
    var priming = false;
    var primeWaiter: { ok: (s: MediaStream) => void; fail: (e: Error) => void } | null = null;
    var primeTimer: any = null;

    // Connection monitor: re-probe periodically and on "online" so queued turns resend.
    var connState: ConnState = "NOT CONNECTED";
    var probing = false;
    var lastProbe = 0;

    // Quick notes for Plato (configs/nokia-notes); "*" toggles the Notes screen.
    var notesMode = false;
    var notesSess = blankSession("Notes \u2192 Plato");
    notesSess.id = "notes";
    var notes: NotesBox | null = cfg.notesUrl && cfg.notesToken
      ? createNotesBox(cfg.notesUrl, cfg.notesToken, notesChanged, function (text: string): void { if (notesMode) say(text); },
          function (saved: boolean, label: string, kind: string): void {
            buzz(saved ? "arrived" : "error");
            if (saved && notesMode) uiChip("\u2713 " + label, kind);
          })
      : null;
    if (notes) notesSess.messages = notes.log;

    // Meeting mode (Notes screen, 0): long recording in one-minute segments, queued as they end.
    var meeting: MeetingRecorder | null = notes ? createMeetingRecorder(RECORD_BITRATE,
      function (blob: Blob): void { if (notes) notes.meetingSegment(blob); refreshBanner(); },
      meetingEnded,
      function (): void { if (notes) notes.meetingFinish(meeting ? meeting.elapsed() : 0); endMeeting(); say("Recording failed. Saved parts are being sent."); }) : null;
    var wakeLock: { unlock: () => void } | null = null;

    function cur(): LocalSession { return notesMode ? notesSess : sessions[active]; }
    function isActive(sess: LocalSession): boolean { return sess.id === cur().id; }
    function say(message: string): void {
      uiStatus(message);
      if (message && noticeKind(message) === "error") buzz("error");
    }

    // Vibrate when enabled (Menu › Vibrate). Errors buzz at most every 4 s so a retry loop
    // cannot keep the phone shaking.
    function buzz(kind: Haptic): void {
      if (!haptics || !nav.vibrate) return;
      if (kind === "error") {
        if (Date.now() - lastErrorBuzz < 4000) return;
        lastErrorBuzz = Date.now();
      }
      try { nav.vibrate(HAPTICS[kind]); } catch (_e) { /* no vibrator */ }
    }
    function persist(): void {
      if (!persistSessions(sessions, active)) say("Storage unavailable; changes may not persist.");
    }

    // ── Chrome: softkeys, top bar, thinking bubble ──────────────────────────
    function setMode(next: Mode): void {
      mode = next;
      uiBarRecording(next === "recording" || next === "paused" || next === "meeting", notesMode, next === "paused");
      uiComposerHint(next, notesMode);
      uiEmptyHint(emptyHint(next, notesMode));
      refreshSoftkeys();
    }

    function recElapsed(): number {
      if (mode === "meeting" && meeting) return meeting.elapsed();
      return recAccum + (mode === "recording" ? Date.now() - recStart : 0);
    }

    function refreshSoftkeys(): void {
      var labels = softkeysFor(mode, formatElapsed(recElapsed()), canResume, notesMode);
      setSoftkeys(labels[0], labels[1], labels[2]);
      refreshBanner();
    }

    function refreshBanner(): void {
      var sess = cur();
      var state: BannerState = { mode: mode, elapsed: formatElapsed(recElapsed()), discardArmed: discardArmed, notes: notesMode, connected: connState === "CONNECTED",
        parts: meeting ? meeting.parts() : 0 };
      if (sess === notesSess) {
        state.sending = !!(notes && notes.sending);
        state.queued = notes ? notes.queue.length : 0;
      } else {
        state.failed = sess.serverState === "error";
        state.stalled = !!stalled[sess.id] && isBusyState(sess.serverState);
        state.sending = !!sending[sess.id];
        state.queued = (sess.uploadPending || resend[sess.id]) && !sending[sess.id] ? 1 : 0;
      }
      var speech = ttsCurrent();
      state.reading = !!speech && speech.sessionId === sess.id;
      uiBanner(stateBanner(state), mode === "typing" || mode === "rename");
    }

    function openCount(): number {
      var n = 0;
      for (var i = 0; i < sessions.length; i++) if (!sessions[i].archived) n++;
      return n;
    }

    function openIndex(): number {
      var n = 0;
      for (var i = 0; i < sessions.length; i++) {
        if (!sessions[i].archived) { n++; if (i === active) return n; }
      }
      return 1;
    }

    function refreshTopbar(): void {
      if (notesMode) uiTopbarLabel("\u270e", notesSess.title);
      else uiTopbar(openIndex(), openCount(), cur().title);
    }

    function thinkingLabel(sess: LocalSession): string | null {
      if (sess === notesSess) {
        if (!notes || !notes.queue.length) return null;
        var head = notes.queue[0];
        var what = head.finish ? "asking for the meeting note" : head.meeting ? "uploading meeting part " + head.seq : "saving note";
        if (notes.sending) return what + " " + ["·  ", "·· ", "···"][dots % 3];
        if (head.meeting) return notes.queue.length + " queued · " + queuedLabel(head);
        return notes.queue.length + (notes.queue.length === 1 ? " note" : " notes") + " queued";
      }
      if (!isBusyState(sess.serverState)) return null;
      if (stalled[sess.id]) return "no reply yet · Menu › Retry";
      var word = sess.serverState === "cancelling" ? "cancelling" : progress[sess.id] || (sending[sess.id] ? "sending" : "thinking");
      var trail = ["·  ", "·· ", "···"][dots % 3];
      if (word === "cancelling") return word + " " + trail + " " + formatElapsed(Date.now() - (sess.pendingSince || Date.now()));
      return word + " " + trail + " " + formatElapsed(Date.now() - (sess.pendingSince || Date.now()));
    }

    function refreshThinking(): void {
      var sess = cur();
      var label = thinkingLabel(sess);
      var last = sess.messages.length ? sess.messages[sess.messages.length - 1] : null;
      var echo = sess.lastText && !(last && last.role === "user" && last.text === sess.lastText) ? sess.lastText : null;
      if (sess === notesSess) echo = notes && notes.queue.length ? queuedLabel(notes.queue[0]) : null;
      uiThinking(label, echo);
      refreshBanner();
      if (label && !thinkingTicker) {
        thinkingTicker = setInterval(function (): void { dots++; refreshThinking(); }, 500);
      } else if (!label && thinkingTicker) {
        clearInterval(thinkingTicker); thinkingTicker = null;
      }
    }

    // Full refresh after switching session or loading.
    function updateView(): void {
      var sess = cur();
      refreshTopbar();
      player.pause(); player.removeAttribute("src");
      if (sessionMedia[sess.id]) player.src = sessionMedia[sess.id];
      uiMessages(sess.id, sess.messages, emptyHint(mode, notesMode));
      selected = -1;
      uiSelect(-1, true);
      refreshThinking();
      refreshSoftkeys();
      refreshReading();
    }

    // ── Notes ───────────────────────────────────────────────────────────────
    function notesChanged(): void {
      if (!notesMode || !notes) return;
      notesSess.messages = notes.log;
      uiMessages(notesSess.id, notesSess.messages);
      if (selected >= notesSess.messages.length) selected = -1;
      refreshThinking();
    }

    function toggleNotes(): void {
      if (!notes) { say("Notes are not configured in this build."); return; }
      cancelLocalCapture();
      notesMode = !notesMode;
      setMode("idle");
      updateView();
      if (notesMode) {
        say(notes.queue.length ? "" : "Notes go to Plato's inbox.");
        notes.flush();
      }
    }

    // ── Sessions ────────────────────────────────────────────────────────────
    function switchTo(index: number): void {
      cancelLocalCapture();
      active = index;
      touch(sessions[active]);
      persist();
      updateView();
    }

    function switchSession(direction: number): void {
      if (openCount() === 1) { say("Only one chat. Menu › New chat."); return; }
      var next = active;
      for (var i = 0; i < sessions.length; i++) {
        next = (next + (direction > 0 ? 1 : -1) + sessions.length) % sessions.length;
        if (!sessions[next].archived) break;
      }
      switchTo(next);
    }

    function newSession(): boolean {
      if (sessions.length >= MAX_SESSIONS) { say("Maximum " + MAX_SESSIONS + " chats. Archive one first."); return false; }
      var title = "Conversation " + (openCount() + 1);
      sessions.push(blankSession(title));
      switchTo(sessions.length - 1);
      say("Created " + title + ".");
      return true;
    }

    // The most recently used open chat other than the current one, or -1.
    function previousChat(): number {
      var best = -1;
      for (var i = 0; i < sessions.length; i++) {
        if (i === active || sessions[i].archived) continue;
        if (best < 0 || sessions[i].updatedAt > sessions[best].updatedAt) best = i;
      }
      return best;
    }

    // Chat list speed dial: 1 Notes, 2 new Klaus chat with the recorder running, 3 last chat, 4 Today.
    function speedDial(key: string): void {
      if (key === "1") {
        if (!notes) { say("Notes are not configured in this build."); return; }
        closeOverlay(); toggleNotes();
      } else if (key === "2") {
        closeOverlay();
        if (newSession()) startRecording();
      } else if (key === "4") {
        if (!notes) { say("Today needs the notes service in this build."); return; }
        closeOverlay(); openToday();
      } else {
        var prev = previousChat();
        if (prev < 0) { say("No other chat yet. 2 starts one."); return; }
        closeOverlay(); switchTo(prev);
      }
    }

    // Archived sessions keep polling and speaking; they are only hidden from navigation.
    function archiveActive(): void {
      if (openCount() <= 1) {
        if (sessions.length >= MAX_SESSIONS) { say("At " + MAX_SESSIONS + "-chat cap; cannot archive the last chat."); return; }
        sessions[active].archived = true;
        sessions.push(blankSession("Conversation 1"));
        switchTo(sessions.length - 1);
      } else {
        sessions[active].archived = true;
        var next = active;
        for (var i = 0; i < sessions.length; i++) {
          next = (next + 1) % sessions.length;
          if (!sessions[next].archived) break;
        }
        switchTo(next);
      }
      say("Archived. ←/→ or # to switch chats.");
    }

    // ── Server calls ────────────────────────────────────────────────────────
    function ensureServerSession(sess: LocalSession, cb: (ok: boolean, err: string) => void): void {
      if (sess.serverId) { cb(true, ""); return; }
      xhr(cfg, "POST", cfg.bridgeUrl + "/sessions", {
        contentType: "application/json",
        requestId: sess.clientId,
        body: JSON.stringify({ title: sess.title, clientId: sess.clientId }),
        onSuccess: function (status: number, text: string): void {
          if (status !== 200 && status !== 201) { cb(false, "server error " + status); return; }
          try { sess.serverId = JSON.parse(text).id; persist(); cb(true, ""); }
          catch (_e) { cb(false, "bad response"); }
        },
        onError: function (err: string): void { cb(false, err); }
      });
    }

    function keepClip(sess: LocalSession, blob: Blob): void {
      sess.uploadPending = true;
      sess.uploadBlob = blob;
      clipPut(sess.id, blob);
      if (isActive(sess)) refreshBanner();
    }

    function dropClip(sess: LocalSession): void {
      sess.uploadPending = false;
      sess.uploadBlob = null;
      clipDelete(sess.id);
      if (isActive(sess)) refreshBanner();
    }

    // The turn was accepted, cancelled or discarded: later turns get a new request id.
    function clearOutbox(sess: LocalSession): void {
      delete resend[sess.id];
      sess.outboxId = null;
      sess.outboxAudio = false;
      if (isActive(sess)) refreshBanner();
    }

    // Unnamed chats take their title from the first thing said (typed or transcribed).
    function retitle(sess: LocalSession): void {
      if (sess.named || sess === notesSess) return;
      var source: Array<{ role: string; text: string }> = sess.messages.length ? sess.messages
        : sess.lastText ? [{ role: "user", text: sess.lastText }] : [];
      var t = autoTitle(source);
      if (!t || t === sess.title) return;
      sess.title = t;
      if (isActive(sess)) refreshTopbar();
    }

    function afterStateChange(sess: LocalSession): void {
      retitle(sess);
      persist();
      if (isActive(sess)) refreshThinking();
    }

    // Submit a turn: an audio blob or typed text. The session is marked pending and the
    // request id persisted before any network call so a duplicate cannot start. A clip is
    // written to IndexedDB first so it survives a restart mid-request. Retries (fresh=false)
    // reuse the outbox request id, which the bridge deduplicates.
    function submitTurn(sess: LocalSession, blob: Blob | null, text: string | null, fresh: boolean): void {
      if (fresh || !sess.outboxId || sess.outboxAudio !== !!blob) sess.outboxId = makeUUID();
      sess.outboxAudio = !!blob;
      if (blob) clipPut(sess.id, blob);
      if (!connected) {
        if (blob) { keepClip(sess, blob); say("Not connected. Clip saved locally; Menu › Retry last."); }
        else { sess.lastText = text; say("Not connected. Message not sent; Menu › Retry last."); }
        persist();
        return;
      }
      if (isBusyState(sess.serverState)) { say("Request already in progress. Back cancels, then retry."); return; }
      var requestId = sess.outboxId as string;
      sess.cancelRequestId = null;
      sess.serverState = "pending";
      sess.lastRequestId = requestId;
      sess.runId = null;
      sess.pendingSince = Date.now();
      sess.lastText = text;
      sess.textPending = !blob;
      touch(sess);
      delete stalled[sess.id];
      if (blob) sess.uploadBlob = blob;
      sess.uploadPending = false;
      sending[sess.id] = true;
      progress[sess.id] = "sending";
      afterStateChange(sess);
      ensureServerSession(sess, function (ok: boolean, err: string): void {
        if (!ok) {
          delete sending[sess.id];
          if (sess.serverState === "pending" && sess.lastRequestId === requestId) sess.serverState = "idle";
          if (blob) keepClip(sess, blob);
          markOffline();
          if (isActive(sess)) say("Could not reach Klaus: " + err + ". Queued; sends when back online.");
          afterStateChange(sess);
          return;
        }
        if (sess.lastRequestId !== requestId) { delete sending[sess.id]; return; } // cancelled meanwhile
        postTurn(sess, requestId, blob, text);
      });
    }

    // POST the turn. A network failure keeps the same X-Request-Id for an idempotent resend
    // on reconnect (the bridge dedups by request id), while polling discovers the real state.
    function postTurn(sess: LocalSession, requestId: string, blob: Blob | null, text: string | null): void {
        sending[sess.id] = true;
        xhr(cfg, "POST", cfg.bridgeUrl + "/sessions/" + sess.serverId + "/turns", {
          contentType: blob ? "audio/ogg" : "application/json",
          requestId: requestId,
          body: blob ? blob : JSON.stringify({ text: text }),
          onUploadProgress: blob ? function (loaded: number, total: number): void {
            if (isActive(sess)) uiUpload(total ? loaded / total : null);
          } : undefined,
          onSuccess: function (status: number, body: string): void {
            if (isActive(sess)) uiUpload(null);
            delete sending[sess.id];
            delete resend[sess.id];
            if (status === 202 || status === 200) {
              try {
                var r = JSON.parse(body);
                sess.runId = r.runId || requestId;
                sess.serverState = (r.state || "pending") as SessionState;
              } catch (_e) { sess.runId = requestId; sess.serverState = "pending"; }
              if (blob) dropClip(sess);
              // The bridge acknowledges receipt but does not expose a stream. Its next
              // observable state is the normal polling/thinking phase.
              progress[sess.id] = "thinking";
              clearOutbox(sess);
              sess.textPending = false;
              afterStateChange(sess);
              startPolling(sess);
            } else if (status === 401 || status === 403) {
              sess.serverState = "error";
              if (blob) keepClip(sess, blob);
              afterStateChange(sess);
              if (isActive(sess)) say("Auth error (" + status + "). Check bridge config.");
            } else {
              // The bridge may still have accepted it; poll to discover the real state.
              sess.serverState = "uncertain";
              afterStateChange(sess);
              startPolling(sess);
              if (isActive(sess)) say("Submit error " + status + ". Checking server state…");
            }
          },
          onError: function (error: string): void {
            if (isActive(sess)) uiUpload(null);
            delete sending[sess.id];
            markOffline();
            if (sess.lastRequestId === requestId) {
              resend[sess.id] = { requestId: requestId, blob: blob, text: text, audio: !!blob };
              sess.textPending = false;
              sess.serverState = "uncertain";
              afterStateChange(sess);
              if (sess.serverId) startPolling(sess);
            }
            if (isActive(sess)) say(error + ". Will resend when back online.");
          }
        });
    }

    function cancelSession(sess: LocalSession): void {
      if (sess.outboxAudio) dropClip(sess);
      clearOutbox(sess);
      if (sess.serverState === "pending" || sess.serverState === "uncertain") {
        sess.serverState = "cancelling";
        if (connected && sess.serverId) {
          if (!sess.cancelRequestId) sess.cancelRequestId = makeUUID();
          persist();
          xhr(cfg, "POST", cfg.bridgeUrl + "/sessions/" + sess.serverId + "/cancel", {
            contentType: "application/json",
            requestId: sess.cancelRequestId,
            body: JSON.stringify({ turnRequestId: sess.lastRequestId || null }),
            onSuccess: function (): void { /* poll confirms */ },
            onError: function (): void { /* poll confirms */ }
          });
          if (!sess.pollTimer && !sess.pollXhr) startPolling(sess);
        } else {
          stopPolling(sess);
          sess.serverState = "cancelled";
        }
        afterStateChange(sess);
      } else {
        stopPolling(sess);
      }
    }

    function stopPolling(sess: LocalSession): void {
      if (sess.pollTimer) { clearTimeout(sess.pollTimer); sess.pollTimer = null; }
    }

    // Poll with backoff until the turn settles or POLL_TIMEOUT elapses. At most one poll
    // XHR per session; archived and background sessions keep polling.
    function startPolling(sess: LocalSession): void {
      if (sess.pollTimer || !sess.serverId) return;
      var attempt = 0;
      var started = Date.now();
      delete stalled[sess.id];
      function schedule(): void {
        if (isBusyState(sess.serverState)) sess.pollTimer = setTimeout(tick, pollDelay(attempt++));
      }
      function tick(): void {
        if (sess.pollXhr) return;
        sess.pollTimer = null;
        if (!sess.serverId || !isBusyState(sess.serverState)) return;
        if (Date.now() - started > POLL_TIMEOUT) {
          sess.serverState = "uncertain";
          stalled[sess.id] = true;
          afterStateChange(sess);
          return;
        }
        sess.pollXhr = xhr(cfg, "GET", cfg.bridgeUrl + "/sessions/" + sess.serverId, {
          onSuccess: function (status: number, text: string): void {
            sess.pollXhr = null;
            if (status === 401 || status === 403) {
              sess.serverState = "error";
              afterStateChange(sess);
              if (isActive(sess)) say("Auth error (" + status + ") while waiting. Check bridge config.");
              return;
            }
            if (status === 200) applyPoll(sess, text);
            else if (isActive(sess)) say("Poll error " + status + ". Retrying…");
            schedule();
          },
          onError: function (): void {
            sess.pollXhr = null;
            schedule();
          }
        });
      }
      schedule();
    }

    function applyPoll(sess: LocalSession, text: string): void {
      var r: any;
      try { r = JSON.parse(text); } catch (_e) { return; }
      // The bridge never saw a turn whose POST failed: resend it now that it is reachable.
      var again = resend[sess.id];
      if (again && sess.lastRequestId === again.requestId && r.runId !== again.requestId &&
          !isBusyState((r.state || "idle") as SessionState)) {
        if (!sending[sess.id] && (!again.audio || again.blob)) postTurn(sess, again.requestId, again.blob, again.text);
        return;
      }
      // The lost POST had reached the bridge after all: nothing left to resend.
      if (again && r.runId === again.requestId) {
        if (again.audio) dropClip(sess);
        clearOutbox(sess);
      }
      var msgs = mergeVoice(Array.isArray(r.messages) ? serverMessages(validateMessages(r.messages)) : [], sess.voiceTurns);
      // Never let an older response shrink a completed transcript.
      if (msgs.length < sess.messages.length && sess.serverState === "complete") return;
      var oldCount = sess.messages.length;
      sess.messages = msgs;
      if (msgs.length > oldCount && isBusyState(sess.serverState)) progress[sess.id] = "writing";
      else if (isBusyState(sess.serverState) && !sending[sess.id]) progress[sess.id] = "thinking";
      if (msgs.length !== oldCount) touch(sess);
      retitle(sess);
      if (r.runId) sess.runId = r.runId;
      var next = (r.state || "idle") as SessionState;
      var settled = sess.serverState === "complete" || sess.serverState === "cancelled";
      if (!(settled && (next === "pending" || next === "idle"))) sess.serverState = next;
      persist();
      for (var k = oldCount; k < msgs.length; k++) {
        if (msgs[k].role === "assistant") { buzz("arrived"); break; }
      }
      if (autoRead && !busy) {
        for (var i = oldCount; i < msgs.length; i++) {
          if (msgs[i].role === "assistant") ttsEnqueue(msgs[i].text, sess.id);
        }
      }
      if (!isActive(sess)) return;
      uiMessages(sess.id, sess.messages);
      if (selected >= sess.messages.length) selected = -1;
      refreshThinking();
      refreshReading();
      if (sess.serverState === "error") say("Klaus error: " + (r.error || "unknown") + ".");
      else if (sess.serverState === "cancelled") say("Request cancelled.");
      else if (sess.serverState === "complete" && oldCount !== msgs.length) say(""); // stale notices end with the reply
    }

    function retryLast(): void {
      var sess = cur();
      if (isBusyState(sess.serverState)) {
        if (connected && sess.serverId && !sess.pollTimer && !sess.pollXhr) {
          startPolling(sess); refreshThinking(); say("Checking again…");
        } else say("Still waiting for Klaus. Back cancels.");
        return;
      }
      if (sess.uploadPending) {
        if (sess.uploadBlob) { submitTurn(sess, sess.uploadBlob, null, false); return; }
        clipGet(sess.id, function (blob: Blob | null): void {
          if (blob) submitTurn(sess, blob, null, false);
          else { sess.uploadPending = false; persist(); say("Saved clip is no longer available."); }
        });
        return;
      }
      if (sess.lastText) { submitTurn(sess, null, sess.lastText, false); return; }
      say("Nothing to retry.");
    }

    // After reconnecting: resend queued clips/texts and resume stalled or idle polls.
    function retryAllQueued(): number {
      var n = 0;
      sessions.forEach(function (sess: LocalSession): void {
        var again = resend[sess.id];
        if (again && sess.lastRequestId === again.requestId && sess.serverState === "uncertain" && !sending[sess.id]) {
          if (!again.audio || again.blob) postTurn(sess, again.requestId, again.blob, again.text);
          n++;
        } else if (isBusyState(sess.serverState)) {
          if (sess.serverId && !sess.pollTimer && !sess.pollXhr) { startPolling(sess); n++; }
        } else if (sess.uploadPending) n++;
        else if (sess.textPending && sess.lastText) { submitTurn(sess, null, sess.lastText, false); n++; }
      });
      retryAllClips();
      if (n) refreshThinking();
      return n;
    }

    function retryAllClips(): void {
      sessions.forEach(function (sess: LocalSession): void {
        if (sess.uploadPending && !isBusyState(sess.serverState)) {
          clipGet(sess.id, function (blob: Blob | null): void {
            var b = sess.uploadBlob || blob;
            if (b) submitTurn(sess, b, null, false);
          });
        }
      });
    }

    // ── Recording ───────────────────────────────────────────────────────────
    function stopTracks(): void {
      if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
      if (analyser) { try { analyser.disconnect(); } catch (_e) { /* optional */ } analyser = null; }
      uiLevel(null);
      if (stream) { stream.getTracks().forEach(function (t: MediaStreamTrack): void { t.stop(); }); stream = null; }
    }

    function startLevelMeter(value: MediaStream): void {
      // Optional only: KaiOS/Gecko 48 builds without AudioContext retain recording.
      try {
        var Ctor: any = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return;
        var audio = new Ctor();
        var meter = audio.createAnalyser(); meter.fftSize = 32;
        analyser = meter;
        audio.createMediaStreamSource(value).connect(meter);
        var data = new Uint8Array(meter.frequencyBinCount);
        meterTimer = setInterval(function (): void {
          if (!analyser) return;
          meter.getByteTimeDomainData(data);
          var sum = 0;
          for (var i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
          uiLevel(Math.min(1, (sum / data.length) / 38));
        }, 120);
      } catch (_e) { uiLevel(null); }
    }

    function endRecordingMode(): void {
      if (recTicker) { clearInterval(recTicker); recTicker = null; }
      heldClip = null; discardArmed = false; recAccum = 0;
      if (mode === "recording" || mode === "paused") setMode("idle");
      schedulePrime();
    }

    function requestMic(ok: (s: MediaStream) => void, fail: (e: Error) => void): boolean {
      try {
        if (nav.mediaDevices && nav.mediaDevices.getUserMedia) nav.mediaDevices.getUserMedia({ audio: true }).then(ok, fail);
        else if (nav.getUserMedia) nav.getUserMedia({ audio: true }, ok, fail);
        else return false;
      } catch (e) { fail(e as Error); }
      return true;
    }

    function releasePrimed(): void {
      if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
      if (primed) { primed.getTracks().forEach(function (t: MediaStreamTrack): void { t.stop(); }); primed = null; }
    }

    // Open the microphone shortly after the app becomes idle and visible; the stream is
    // released when the app is hidden and handed to the next recording.
    function schedulePrime(): void {
      if (!primeTimer) primeTimer = setTimeout(function (): void { primeTimer = null; primeMic(); }, 300);
    }

    function primeMic(): void {
      if (primed || priming || busy || document.hidden) return;
      priming = true;
      var started = requestMic(function (s: MediaStream): void {
        priming = false;
        var waiter = primeWaiter; primeWaiter = null;
        if (waiter) { waiter.ok(s); return; }
        if (busy || document.hidden || primed) { s.getTracks().forEach(function (t: MediaStreamTrack): void { t.stop(); }); return; }
        primed = s;
      }, function (e: Error): void {
        priming = false;
        var waiter = primeWaiter; primeWaiter = null;
        if (waiter) waiter.fail(e);
      });
      if (!started) priming = false;
    }

    // Cancel local mic capture only; never server requests or polls.
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
      endRecordingMode();
      if (message) say(message);
    }

    function startRecording(): void {
      if (busy) return;
      var sess = cur();
      if (isBusyState(sess.serverState)) { say("Request in progress. Back to cancel, then record."); return; }
      player.pause();
      busy = true; chunks = []; stopRequested = false;
      sendOnStop = true; canResume = false; heldClip = null; recAccum = 0; discardArmed = false;
      var gen = ++generation;
      ttsInterrupt(); // never transcribe Klaus's own voice
      recStart = Date.now();
      setMode("recording");
      recTicker = setInterval(refreshSoftkeys, 1000);
      if (!primed) say("Requesting microphone…");

      function onStream(value: MediaStream): void {
        if (gen !== generation) { value.getTracks().forEach(function (t: MediaStreamTrack): void { t.stop(); }); return; }
        stream = value;
        startLevelMeter(value);
        try {
          var rec: MediaRecorder;
          try { rec = new MediaRecorder(value, { audioBitsPerSecond: RECORD_BITRATE }); }
          catch (_e) { rec = new MediaRecorder(value); } // recorder without options support
          recorder = rec; chunks = [];
          rec.ondataavailable = function (event: BlobEvent): void {
            if (gen === generation && event.data && event.data.size) chunks.push(event.data);
          };
          rec.onerror = function (): void {
            if (gen === generation) cancelLocalCapture("Recording failed. Press OK to retry.");
          };
          rec.onstop = function (): void {
            if (gen !== generation) return;
            stopTracks(); recorder = null; busy = false;
            if (!chunks.length) { generation++; endRecordingMode(); say("No audio captured. Press OK to retry."); return; }
            var blob: Blob;
            try { blob = new Blob(chunks, { type: rec.mimeType || "audio/ogg" }); }
            catch (_e) { generation++; chunks = []; endRecordingMode(); say("Could not save audio. Press OK to retry."); return; }
            chunks = [];
            if (!sendOnStop) { heldClip = blob; refreshSoftkeys(); return; } // pause fallback: keep the clip
            generation++;
            var ms = recElapsed();
            endRecordingMode();
            deliverClip(sess, blob, ms);
          };
          canResume = typeof (rec as any).pause === "function" && typeof (rec as any).resume === "function";
          rec.start();
          recStart = Date.now();
          buzz("start");
          refreshSoftkeys();
          say("");
          if (stopRequested) stopRecording();
        } catch (_e) { cancelLocalCapture("Recorder unavailable on this device."); }
      }

      function onFailure(_error: Error): void {
        if (gen !== generation) return;
        busy = false;
        endRecordingMode();
        say("Microphone unavailable or permission denied.");
      }

      if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
      if (primed && (primed as any).active !== false) { var s = primed; primed = null; onStream(s); }
      else if (priming) { releasePrimed(); primeWaiter = { ok: onStream, fail: onFailure }; }
      else {
        releasePrimed();
        if (!requestMic(onStream, onFailure)) { busy = false; endRecordingMode(); say("Microphone capture is unsupported."); }
      }
    }

    // Show a sent clip in the transcript until the bridge returns its transcript.
    function addVoiceTurn(sess: LocalSession, ms: number): void {
      sess.voiceTurns.push({ at: serverMessages(sess.messages).length, ms: ms });
      if (sess.voiceTurns.length > MAX_VOICE_TURNS) sess.voiceTurns.shift();
      remerge(sess);
    }

    function remerge(sess: LocalSession): void {
      sess.messages = mergeVoice(serverMessages(sess.messages), sess.voiceTurns);
      if (isActive(sess)) {
        uiMessages(sess.id, sess.messages);
        if (selected >= sess.messages.length) selected = -1;
      }
    }

    // Back discarded a clip that never reached the bridge: drop its placeholder too.
    function dropLastVoiceTurn(sess: LocalSession): void {
      var at = serverMessages(sess.messages).length;
      var last = sess.voiceTurns[sess.voiceTurns.length - 1];
      if (last && last.at === at) { sess.voiceTurns.pop(); remerge(sess); }
    }

    function deliverClip(sess: LocalSession, blob: Blob, ms: number): void {
      try {
        if (sessionMedia[sess.id]) URL.revokeObjectURL(sessionMedia[sess.id]);
        sessionMedia[sess.id] = URL.createObjectURL(blob);
        if (isActive(sess)) player.src = sessionMedia[sess.id];
      } catch (_e) { /* playback copy is optional */ }
      say("");
      buzz("send");
      ttsNext();
      if (sess === notesSess && notes) notes.add(blob, null);
      else { addVoiceTurn(sess, ms); submitTurn(sess, blob, null, true); }
    }

    // Send the clip: from a held (stopped) clip, or by stopping a live/paused recorder.
    function stopRecording(): void {
      if (heldClip) {
        var blob = heldClip;
        var ms = recElapsed();
        generation++;
        endRecordingMode();
        deliverClip(cur(), blob, ms);
      } else if (recorder) {
        sendOnStop = true; // a pause-fallback stop still in flight sends on completion
        say("Sending…");
        if (recorder.state !== "inactive") {
          try { recorder.stop(); } catch (_e) { cancelLocalCapture("Recording failed. Press OK to retry."); }
        }
      } else if (busy) {
        stopRequested = true; // Send pressed before the mic opened
      }
    }

    // Centre while recording: pause() when supported, else stop and keep the clip.
    function pauseRecording(): void {
      if (!recorder || recorder.state !== "recording") { say("Waiting for microphone…"); return; }
      recAccum += Date.now() - recStart;
      if (recTicker) { clearInterval(recTicker); recTicker = null; }
      setMode("paused");
      buzz("pause");
      if (canResume) {
        try { (recorder as any).pause(); } catch (_e) { canResume = false; }
      }
      if (!canResume) {
        sendOnStop = false;
        try { recorder.stop(); } catch (_e) { cancelLocalCapture("Recording failed. Press OK to retry."); return; }
      }
    }

    function resumeRecording(): void {
      if (!canResume || !recorder || recorder.state !== "paused") { stopRecording(); return; }
      try { (recorder as any).resume(); } catch (_e) { cancelLocalCapture("Recording failed. Press OK to retry."); return; }
      recStart = Date.now();
      setMode("recording");
      buzz("start");
      recTicker = setInterval(refreshSoftkeys, 1000);
      say("");
    }

    // Backspace while recording/paused: discard, asking again for clips over 3 s.
    function discardRecording(): void {
      var ms = recElapsed();
      if (ms > DISCARD_CONFIRM_MS && !discardArmed) {
        discardArmed = true;
        refreshBanner();
        return;
      }
      cancelLocalCapture("Recording discarded.");
    }

    // ── Meeting mode ────────────────────────────────────────────────────────
    function startMeeting(): void {
      if (!notes || !meeting || busy) return;
      player.pause();
      ttsInterrupt();
      busy = true;
      var gen = ++generation;
      say(primed ? "" : "Requesting microphone…");
      function onStream(value: MediaStream): void {
        if (gen !== generation || !notes || !meeting) { value.getTracks().forEach(function (t: MediaStreamTrack): void { t.stop(); }); return; }
        stream = value;
        try { meeting.start(value); }
        catch (_e) { stopTracks(); busy = false; say("Recorder unavailable on this device."); return; }
        notes.meetingStart();
        // Keep the CPU awake with the screen off (KaiOS wake lock); unknown elsewhere.
        try { wakeLock = nav.requestWakeLock ? nav.requestWakeLock("cpu") : null; } catch (_e) { wakeLock = null; }
        setMode("meeting");
        buzz("start");
        recTicker = setInterval(function (): void { if (meeting) meeting.tick(); refreshSoftkeys(); }, 1000);
        say("");
      }
      function onFailure(_e: Error): void {
        if (gen !== generation) return;
        busy = false;
        say("Microphone unavailable or permission denied.");
      }
      if (primeTimer) { clearTimeout(primeTimer); primeTimer = null; }
      if (primed && (primed as any).active !== false) { var s = primed; primed = null; onStream(s); }
      else {
        releasePrimed();
        if (!requestMic(onStream, onFailure)) { busy = false; say("Microphone capture is unsupported."); }
      }
    }

    function stopMeeting(): void {
      if (meeting && meeting.running()) { say("Saving the last part…"); meeting.stop(); }
    }

    function meetingEnded(ms: number): void {
      if (notes) notes.meetingFinish(ms);
      endMeeting();
      buzz("send");
      say("Meeting " + formatElapsed(ms) + " saved. Plato writes the note.");
    }

    function endMeeting(): void {
      if (recTicker) { clearInterval(recTicker); recTicker = null; }
      if (wakeLock) { try { wakeLock.unlock(); } catch (_e) { /* released */ } wakeLock = null; }
      stopTracks();
      busy = false;
      generation++;
      if (mode === "meeting") setMode("idle");
      refreshThinking();
      schedulePrime();
    }

    // ── Typing / rename ─────────────────────────────────────────────────────
    function enterInput(next: Mode, value: string): void {
      composer.value = value;
      setMode(next);
      try { composer.focus(); } catch (_e) { /* ignore */ }
    }

    function exitInput(): void {
      var wasRename = mode === "rename";
      setMode("idle");
      if (wasRename) composer.value = "";
      try { composer.blur(); } catch (_e) { /* ignore */ }
    }

    function sendInput(): void {
      var text = (composer.value || "").replace(/^\s+|\s+$/g, "");
      if (mode === "rename") {
        if (text) { cur().title = text.slice(0, 40); cur().named = true; persist(); refreshTopbar(); say("Renamed."); }
        exitInput();
        return;
      }
      if (!text) { say("Type a message first."); return; }
      composer.value = "";
      exitInput();
      buzz("send");
      if (notesMode && notes) notes.add(null, text);
      else submitTurn(cur(), null, text, true);
    }

    // ── Menu, session list, confirm ─────────────────────────────────────────
    function menuItems(): string[] {
      return ["New chat", "Rename", "Archive", "Retry last", "Read aloud: " + (autoRead ? "on" : "off"),
        "Vibrate: " + (haptics ? "on" : "off"), "Night mode: " + (night ? "on" : "off"),
        "Large text: " + (large ? "on" : "off"), "Keys"];
    }

    function openMenu(): void { listIndex = 0; setMode("menu"); uiOverlay("Menu", menuItems(), listIndex, undefined, true); }

    function openHelp(): void {
      setMode("help");
      uiOverlay("Keys", [], -1, KEY_HELP.join("\n"));
    }

    function openSessionList(): void {
      listTargets = [];
      for (var i = 0; i < sessions.length; i++) if (!sessions[i].archived) listTargets.push(i);
      // Most recent first; the open chat is always the most recently opened.
      listTargets.sort(function (a: number, b: number): number { return (sessions[b].updatedAt - sessions[a].updatedAt) || (b - a); });
      listIndex = Math.max(0, listTargets.indexOf(active));
      setMode("sessions");
      renderSessionList();
    }

    function openConfirm(): void {
      setMode("confirm");
      uiOverlay("Archive “" + cur().title + "”?", [], -1, "It leaves the chat list. OK archives, Back keeps it.");
    }

    function closeOverlay(): void { uiOverlayHide(); searchOpen = false; setMode("idle"); }

    // ── Search (chat list, right softkey) ────────────────────────────────────
    // Local only: matches chat titles and stored message text, case- and
    // accent-insensitive; OK opens the chat with the first match focused.
    function openSearch(): void {
      if (notesMode) { say("Search lives on the chat list."); return; }
      searchOpen = true; searchQuery = ""; searchIndex = 0; searchHits = [];
      setMode("search");
      renderSearch();
    }

    function renderSearch(): void {
      if (!searchOpen) return;
      searchHits = searchSessions(sessions, searchQuery);
      if (searchIndex >= searchHits.length) searchIndex = 0;
      var rows = searchHits.map(function (hit: SearchHit): { title: string; match: string; inTitle: boolean } {
        return { title: hit.title, match: hit.inTitle ? "Title" : hit.snippet, inTitle: hit.inTitle };
      });
      uiSearch(searchQuery, rows, searchIndex);
    }

    function moveSearchList(delta: number): void {
      var count = searchHits.length;
      if (!count) return;
      searchIndex = (searchIndex + delta + count) % count;
      renderSearch();
    }

    function selectSearch(): void {
      var hit = searchHits[searchIndex];
      if (!hit) return;
      var query = searchQuery;
      var target = hit.index;
      closeOverlay();
      var focusAt = searchMessageIndex(sessions[target].messages, query);
      if (target !== active) switchTo(target);
      if (focusAt >= 0) focusMessage(focusAt, true);
    }

    // ── Today (chat list, 4) ────────────────────────────────────────────────
    // The last good answer is cached so the screen opens at once, also offline.
    var TODAY_KEY = "klaus.today.v1";
    var today: { at: number; data: TodayData } | null = null;
    var todayLoading = false, todayFailed = false;
    try {
      var cachedToday = JSON.parse(localStorage.getItem(TODAY_KEY) || "null");
      var validToday = cachedToday && typeof cachedToday.at === "number" ? validateToday(cachedToday.data) : null;
      if (validToday) today = { at: cachedToday.at, data: validToday };
    } catch (_e) { /* no cache */ }

    function renderToday(): void {
      if (mode !== "today") return;
      var now = Date.now();
      var empty: TodayData = { date: "", reminders: [], undated: 0, latest: [] };
      uiToday(todayTitle(now), todayFreshness(today ? today.at : 0, now, todayFailed, todayLoading),
        today ? todaySections(today.data, now) : todayLoading ? [] : todaySections(empty, now));
    }

    function fetchToday(): void {
      if (!cfg.notesUrl || !cfg.notesToken || todayLoading) return;
      todayLoading = true;
      renderToday();
      var done = function (data: TodayData | null): void {
        todayLoading = false;
        todayFailed = !data;
        if (data) {
          today = { at: Date.now(), data: data };
          try { localStorage.setItem(TODAY_KEY, JSON.stringify(today)); } catch (_e) { /* shown anyway */ }
        }
        renderToday();
      };
      xhr({ bridgeUrl: cfg.notesUrl, bridgeToken: cfg.notesToken }, "GET", cfg.notesUrl + "/today", {
        onSuccess: function (status: number, text: string): void {
          var data: TodayData | null = null;
          if (status === 200) { try { data = validateToday(JSON.parse(text)); } catch (_e) { data = null; } }
          done(data);
        },
        onError: function (): void { done(null); }
      });
    }

    function openToday(): void {
      setMode("today");
      renderToday();
      fetchToday();
    }

    // ── Quick replies (0, then 1-9) ─────────────────────────────────────────
    var quickItems: string[] = [];

    function lastReply(sess: LocalSession): string {
      for (var i = sess.messages.length - 1; i >= 0; i--) if (sess.messages[i].role === "assistant") return sess.messages[i].text;
      return "";
    }

    function openQuick(): void {
      var sess = cur();
      if (isBusyState(sess.serverState)) { say("Klaus is still replying. Back cancels."); return; }
      quickItems = quickReplies(lastReply(sess));
      listIndex = 0;
      setMode("quick");
      renderQuick();
    }

    function renderQuick(): void {
      uiOverlay("Quick reply · 1-9 sends", quickItems, listIndex, undefined, true);
    }

    function sendQuick(index: number): void {
      var text = quickItems[index];
      closeOverlay();
      if (text) { buzz("send"); submitTurn(cur(), null, text, true); }
    }

    function moveList(delta: number): void {
      var count = mode === "menu" ? menuItems().length : mode === "quick" ? quickItems.length : listTargets.length;
      if (!count) return;
      listIndex = (listIndex + delta + count) % count;
      if (mode === "menu") uiOverlay("Menu", menuItems(), listIndex, undefined, true);
      else if (mode === "quick") renderQuick();
      else renderSessionList();
    }

    function renderSessionList(): void {
      var rows: SessionRow[] = [];
      var now = Date.now();
      for (var i = 0; i < listTargets.length; i++) {
        var s = sessions[listTargets[i]];
        rows.push(sessionRow(s.title, s.messages, isBusyState(s.serverState), s.serverState === "error",
          !!(s.uploadPending || resend[s.id] || s.textPending), s.updatedAt, now));
      }
      uiSessionList("Chats · " + rows.length, rows, listIndex, SPEED_DIAL, [!!notes, sessions.length < MAX_SESSIONS, previousChat() >= 0, !!notes]);
    }

    function selectItem(): void {
      if (mode === "confirm") { closeOverlay(); archiveActive(); return; }
      if (mode === "today") { fetchToday(); return; }
      if (mode === "quick") { sendQuick(listIndex); return; }
      if (mode === "sessions") {
        var target = listTargets[listIndex];
        closeOverlay();
        if (target !== undefined && target !== active) switchTo(target);
        return;
      }
      var choice = listIndex;
      closeOverlay();
      if (choice === 0) newSession();
      else if (choice === 1) enterInput("rename", cur().title);
      else if (choice === 2) openConfirm();
      else if (choice === 3) retryLast();
      else if (choice === 4) toggleAutoRead();
      else if (choice === 5) toggleHaptics();
      else if (choice === 6) toggleDisplay("night");
      else if (choice === 7) toggleDisplay("large");
      else if (choice === 8) openHelp();
    }

    // ── Reading ─────────────────────────────────────────────────────────────
    function toggleAutoRead(): void {
      autoRead = !autoRead;
      saveSetting("autoread", autoRead);
      if (!autoRead) ttsStop();
      say("Read aloud " + (autoRead ? "on" : "off") + ".");
    }

    function applyDisplay(): void {
      uiDisplay(night, large);
    }

    function toggleDisplay(which: string): void {
      if (which === "night") { night = !night; saveSetting("night", night); }
      else { large = !large; saveSetting("large", large); }
      applyDisplay();
      if (mode === "idle") uiScrollBottom();
      say(which === "night" ? "Night mode " + (night ? "on" : "off") + "." : "Large text " + (large ? "on" : "off") + ".");
    }

    function toggleHaptics(): void {
      haptics = !haptics;
      saveSetting("haptics", haptics);
      buzz("start"); // feel the change when switching on
      say("Vibrate " + (haptics ? "on" : "off") + ".");
    }

    function playRecording(sess: LocalSession): void {
      try {
        var result = player.play() as any;
        if (result && typeof result.catch === "function") result.catch(function (): void { say("Playback failed."); });
        say("Playing your recording… 5 stops.");
      } catch (_e) { say("Playback unavailable."); }
    }

    // 5: the focused message (a clip placeholder plays the recording), else the latest reply,
    // else your last clip.
    function readSelected(): void {
      if (!player.paused) { player.pause(); say("Playback stopped."); return; }
      var sess = cur();
      var speech = ttsCurrent();
      if (speech && speech.sessionId === sess.id) { ttsStop(); say("Stopped reading."); return; }
      var focused = selected >= 0 ? sess.messages[selected] : null;
      if (focused && focused.voice) {
        if (sessionMedia[sess.id] && !busy) playRecording(sess);
        else say("No transcript for this clip yet.");
        return;
      }
      var text: string | null = focused ? focused.text : null;
      for (var i = sess.messages.length - 1; !text && i >= 0; i--) {
        if (sess.messages[i].role === "assistant") text = sess.messages[i].text;
      }
      if (text) { ttsSpeakNow(text, sess.id); return; }
      if (sessionMedia[sess.id] && !busy) { playRecording(sess); return; }
      say("Nothing to read yet.");
    }

    function focusMessage(index: number, scroll: boolean): void {
      selected = index;
      uiSelect(index, scroll);
    }

    // Back in idle: cancel what is in flight; returns false to let KaiOS close the app.
    function handleBack(): boolean {
      if (mode === "meeting") { say("The meeting is still recording. OK stops and saves it."); return true; }
      if (notesMode) {
        if (selected >= 0) focusMessage(-1, true); else toggleNotes();
        return true;
      }
      var sess = cur();
      if (isBusyState(sess.serverState)) { cancelSession(sess); say("Cancelled."); return true; }
      if (sess.uploadPending) { dropClip(sess); clearOutbox(sess); dropLastVoiceTurn(sess); persist(); say("Unsent clip discarded."); return true; }
      if (selected >= 0) { focusMessage(-1, true); return true; }
      return false;
    }

    // ── Keys ────────────────────────────────────────────────────────────────
    var KEYCODES: { [code: number]: string } = { 13: "Enter", 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown" };

    function keyOf(event: KeyboardEvent): string {
      return event.key && event.key !== "Unidentified" ? event.key : KEYCODES[(event as any).keyCode] || "";
    }

    function run(action: Action, key: string): void {
      var count = cur().messages.length;
      if (notesMode) {
        if (action === "menu") { toggleNotes(); return; }
        if (action === "quick") { startMeeting(); return; }
        if (action === "prev" || action === "next" || action === "sessions" || action === "new" || action === "archive") {
          say("Notes: * or Chat returns to the chats."); return;
        }
      }
      switch (action) {
        case "type": enterInput("typing", ""); break;
        case "talk": startRecording(); break;
        case "pause": pauseRecording(); break;
        case "resume": resumeRecording(); break;
        case "discard": discardRecording(); break;
        case "menu": openMenu(); break;
        case "cancel": cancelLocalCapture("Recording discarded."); break;
        case "send": if (mode === "recording" || mode === "paused") stopRecording(); else sendInput(); break;
        case "clear": if (mode === "search") { searchQuery = ""; searchIndex = 0; renderSearch(); } else composer.value = ""; break;
        case "voice": exitInput(); startRecording(); break;
        case "exitInput": exitInput(); break;
        case "close": if (mode === "search") { searchOpen = false; searchHits = []; } closeOverlay(); break;
        case "select": if (mode === "search") selectSearch(); else selectItem(); break;
        case "search": openSearch(); break;
        case "typeChar": searchQuery += key.slice(0, 1); searchIndex = 0; renderSearch(); break;
        case "delChar": searchQuery = searchQuery.slice(0, -1); searchIndex = 0; renderSearch(); break;
        case "up": if (mode === "today") uiOverlayScroll(-40); else if (mode === "idle") focusMessage(moveFocus(selected, count, -1), true); else if (mode === "search") moveSearchList(-1); else moveList(-1); break;
        case "down": if (mode === "today") uiOverlayScroll(40); else if (mode === "idle") focusMessage(moveFocus(selected, count, 1), true); else if (mode === "search") moveSearchList(1); else moveList(1); break;
        case "prev": switchSession(-1); break;
        case "next": switchSession(1); break;
        case "top": focusMessage(count ? 0 : -1, true); break;
        case "bottom": focusMessage(-1, true); break;
        case "pageUp": focusMessage(uiPage(-1), false); break;
        case "pageDown": focusMessage(uiPage(1), false); break;
        case "read": readSelected(); break;
        case "autoread": toggleAutoRead(); break;
        case "sessions": openSessionList(); break;
        case "new": newSession(); break;
        case "archive": openConfirm(); break;
        case "notes": toggleNotes(); break;
        case "quick": openQuick(); break;
        case "pick":
          if (mode === "quick") sendQuick(Number(key) - 1);
          else if (Number(key) <= menuItems().length) { listIndex = Number(key) - 1; selectItem(); }
          break;
        case "dial": speedDial(key); break;
        case "stopMeeting": stopMeeting(); break;
      }
    }

    // Softkey that lights up for a key press; Call lights whichever softkey reads Send.
    function softkeyIndex(key: string): number {
      if (key === "SoftLeft") return 0;
      if (key === "Enter" || key === " ") return 1;
      if (key === "SoftRight") return 2;
      if (key === "Call" && mode === "meeting") return 2;
      if (key === "Call") return softkeysFor(mode, "", canResume, notesMode).indexOf("Send");
      return -1;
    }

    document.addEventListener("keydown", function (event: KeyboardEvent): void {
      if (event.repeat) return;
      var key = keyOf(event);
      var action = mapKey(mode, key, mode === "search" ? !searchQuery : !composer.value, canResume);
      if (action === "none") return;
      uiKeyDown(softkeyIndex(key));
      uiChipHide();
      if (action !== "discard" && discardArmed) { discardArmed = false; refreshBanner(); }
      if (action === "back") {
        say("");
        if (handleBack()) event.preventDefault();
        return;
      }
      event.preventDefault();
      say("");
      run(action, key);
    });

    document.addEventListener("keyup", function (): void { uiKeyUp(); });

    composer.addEventListener("focus", function (): void { if (mode === "idle") setMode("typing"); });
    composer.addEventListener("blur", function (): void { if (mode === "typing" || mode === "rename") setMode("idle"); });

    player.addEventListener("ended", function (): void { say("Playback finished."); });
    player.addEventListener("error", function (): void { if (sessionMedia[cur().id]) say("Playback failed on this device."); });

    document.addEventListener("visibilitychange", function (): void {
      if (mode === "meeting") return; // a meeting keeps recording with the screen off
      if (document.hidden) { cancelLocalCapture(); releasePrimed(); }
      else schedulePrime();
    });

    window.addEventListener("unload", function (): void {
      cancelLocalCapture(); releasePrimed(); player.removeAttribute("src");
      Object.keys(sessionMedia).forEach(function (id: string): void { URL.revokeObjectURL(sessionMedia[id]); });
    });

    // Reading aloud: banner plus a mint outline on the message being read.
    function refreshReading(): void {
      var speech = ttsCurrent();
      var sess = cur();
      uiReading(speech && speech.sessionId === sess.id ? readingIndex(sess.messages, speech.text) : -1);
      refreshBanner();
    }
    ttsOnChange(refreshReading);

    // ── Init ────────────────────────────────────────────────────────────────
    // A turn in flight when the app closed is resent with its persisted request id; one
    // whose session was never created goes back to the queue.
    sessions.forEach(function (sess: LocalSession): void {
      if (sess.outboxId && isBusyState(sess.serverState) && sess.serverState !== "cancelling" &&
          sess.lastRequestId === sess.outboxId) {
        if (!sess.serverId) {
          sess.serverState = "idle";
          if (sess.outboxAudio) sess.uploadPending = true;
          else sess.textPending = !!sess.lastText;
        } else {
          resend[sess.id] = { requestId: sess.outboxId, blob: null, text: sess.outboxAudio ? null : sess.lastText, audio: sess.outboxAudio };
          sess.serverState = "uncertain";
        }
      }
      if (isBusyState(sess.serverState)) {
        if (connected && sess.serverId) startPolling(sess);
        else sess.serverState = "uncertain";
      }
      if (sess.uploadPending || resend[sess.id]) {
        clipGet(sess.id, function (blob: Blob | null): void {
          if (!blob) return;
          if (sess.uploadPending && !sess.uploadBlob) sess.uploadBlob = blob;
          var again = resend[sess.id];
          if (again && again.audio && !again.blob) {
            again.blob = blob;
            if (connState === "CONNECTED") retryAllQueued();
          }
        });
      }
    });
    applyDisplay();
    sessions.forEach(retitle);
    touch(sessions[active]); // launching reopens the last chat
    persist();
    setMode("idle");
    uiConn("NOT CONNECTED");
    updateView();
    schedulePrime();
    function markOffline(): void {
      if (connState === "CONNECTED") { connState = "UNREACHABLE"; uiConn(connState); refreshBanner(); }
    }

    function probe(): void {
      if (probing || !connected) return;
      probing = true;
      lastProbe = Date.now();
      probeConnection(cfg, function (state: ConnState): void {
        probing = false;
        var was = connState;
        connState = state;
        uiConn(state);
        refreshBanner();
        if (state !== "CONNECTED") return;
        if (notes) notes.flush();
        var n = retryAllQueued();
        if (was !== "CONNECTED" && was !== "NOT CONNECTED" && n) say("Back online. Sending queued messages…");
      });
    }

    probe();
    if (notes) notes.flush();
    if (connected) {
      // Fast re-probe while offline; slow keep-alive check while connected.
      setInterval(function (): void {
        var every = connState === "CONNECTED" ? 60000 : 15000;
        if (!document.hidden && Date.now() - lastProbe >= every) probe();
      }, 5000);
      window.addEventListener("online", function (): void { probe(); if (notes) notes.flush(); });
      window.addEventListener("offline", function (): void { markOffline(); say("Offline. Messages will queue."); });
    }
  })();
}
