# Klaus chat terminal (KaiOS)

Voice and text chat client for the EcoRay / Klaus backend on the Nokia 6300 4G (240x320, KaiOS 2.5 / Gecko 48). Press OK to talk, OK again to pause, the green Call key to send, or press the left softkey to type; the bridge turns the turn into a Klaus run and the reply appears as a chat bubble and is read aloud.

## Screen

```
+------------------------------+
|2/3 Shopping list            ●|  top bar: chat n/m, title, connection dot
|                              |
|            [what's on it?]   |  your turns: right, green
| [Milk, eggs and coffee.]     |  Klaus: left, dark
|            [add bread]       |  typed text echoed while pending
| [thinking ··· 0:12]          |  animated pending bubble
|                              |
| Request cancelled.           |  one-line notice (only when needed)
|[Type: left key · Talk: OK   ]|  composer
| Type        Talk        Menu |  softkeys follow the state
+------------------------------+
```

The connection dot is green when connected, amber when the gateway is down, red for auth/network errors and grey when no bridge is configured.

## Keys

Softkey labels per state:

| State | Left | Centre | Right |
|---|---|---|---|
| Idle | Type | Talk | Menu |
| Recording | Cancel | Pause | elapsed `0:07` |
| Paused | Delete | Resume (Send if the recorder cannot pause) | Send |
| Typing | Clear | Send | Voice |
| Rename | Clear | Save | Cancel |
| Menu / chat list | Close | Select / Open | |
| Archive confirm | Cancel | Archive | |

Idle keys:

| Key | Action |
|-----|--------|
| Centre (OK) | Start recording |
| SoftLeft | Focus the composer (typing) |
| SoftRight | Menu: New chat, Rename, Archive (confirm), Retry last, Read aloud on/off |
| ↑ / ↓ | Focus previous / next message (full-row highlight). ↓ past the newest returns to live |
| ← / →, 4 / 6 | Previous / next open chat (wraps, skips archived) |
| 1 / 9 | Oldest / newest message |
| 2 / 8 | Page up / down |
| 5 | Read the focused message aloud (latest reply if none); plays your last clip if there is no reply; again stops playback |
| 0 | Toggle auto read-aloud for new replies (persisted) |
| # | Chat list overlay |
| 3 | New chat |
| 7 | Archive chat (confirm with OK or 7, Back cancels) |
| * | Notes for Plato (see below); SoftRight (Chat), Back or * returns |
| Backspace | Cancel the pending request, else discard an unsent clip, else clear message focus, else let KaiOS close the app |

While typing, digits and Backspace go to the input; Enter or Call sends a JSON `{text}` turn; Backspace on an empty input (or Escape) leaves typing.

While recording or paused:

| Key | Recording | Paused |
|-----|-----------|--------|
| Centre (OK) | Pause (status shows `Paused 0:07`) | Resume; sends instead when the recorder has no `pause()` |
| Call (green) | Send | Send |
| SoftRight | | Send (fallback if the system reserves Call) |
| SoftLeft | Cancel (discard) | Delete (discard) |
| Backspace | Discard; clips over 3 s ask for a second Backspace | Same |

Clips are recorded as Ogg/Opus at 16 kbps (about 3.4 KB per second of speech); a recorder that rejects the bitrate option falls back to its default.

When Gecko's `MediaRecorder.pause()` is missing, Pause stops the recorder and keeps the clip; it is only uploaded on Send. The timer excludes paused time.

## Notes for Plato

`*` opens the **Notes → Plato** screen (purple bar) when the package was built with `NOKIA_NOTES_URL`. OK records a voice note and Call sends it; the left key types a note. Notes go to the quick-note inbox service ([`configs/nokia-notes`](../nokia-notes/README.md)) with their own token, never to Klaus; each note becomes a dated Markdown file and the phone shows `Saved: <one-line summary>`.

Notes queue in order while the service is unreachable (for example away from home Wi-Fi); the queue (`klaus.notes.v1`) and clips (IndexedDB `note:<id>`) survive restarts and are sent with their original request id on launch, on reconnect, when opening Notes and every 30 s after a failure. Chat navigation keys are paused on the Notes screen.

## Behaviour

- **Ready to record**: the app reopens the last chat and opens the microphone 300 ms after it becomes visible (and again after each recording), so Centre starts the recorder in about 3 ms instead of 60-125 ms. The stream is released whenever the app is hidden or closed; KaiOS shows its microphone indicator while the app is in front.
- **Sessions**: up to 128 chats (open + archived). Archived chats are hidden from navigation but keep polling and speaking.
- **Pending turns**: a thinking bubble shows `sending`/`thinking`/`cancelling` with an elapsed timer. Polling backs off from 1.5 s to 8 s and stops after `pollTimeoutMs` (default 180000) with "no reply yet"; Menu › Retry last resumes polling.
- **Transcript**: new messages are appended without re-rendering; scroll position is preserved unless you were already at the bottom. The empty-chat hint is hidden while the first turn is pending.
- **Unsent clips**: every clip is written to IndexedDB before it is uploaded and gets a request id (`outboxId`, persisted with the session) that every resend reuses, so the bridge deduplicates it. Clips recorded without signal, or whose upload was cut off, are resent automatically after a successful connection probe, including after an app restart, or with Menu › Retry last; the clip is deleted once the bridge accepts it. Back discards a queued clip. Retry last also resends the last typed message after a failure.
- **Network loss**: the connection is re-probed every 15 s while offline (60 s while connected) and on the system `online` event; a failed send or the `offline` event turns the dot red at once. Typed messages that never reached the bridge are queued (persisted as `textPending`) and resent on reconnect. A turn POST lost mid-flight is resent with the same `X-Request-Id`, which the bridge deduplicates, once the bridge is reachable again, also after an app restart; a poll showing the bridge already has that request id ends the resend. Back cancels a queued resend.
- **Cancel**: Back fires `POST .../cancel` with `{turnRequestId}`; polling continues until the server confirms.
- **TTS**: replies are queued per session. Danish text (æøå or common Danish words) uses a `da-*` voice when installed, otherwise English.
- **Persistence**: `localStorage` key `klaus.sessions.v2` (migrates `v1`), capped at 1 MiB by trimming oldest messages. Setting `klaus.autoread`.

## Source layout

| File | Purpose |
|---|---|
| `keys.ts` | Pure key map, softkey labels, focus/backoff/time/language helpers (unit tested) |
| `storage.ts` | Session model, localStorage persistence, IndexedDB clip store |
| `api.ts` | mozSystem XHR and connection probe |
| `tts.ts` | Serialized speech queue |
| `ui.ts` | DOM rendering (textContent only) |
| `notes.ts` | Notes queue for the Plato inbox service |
| `app.ts` | Controller: recording, turns, polling, menus and key dispatch |

## Build

`./build.sh [output.zip]` type-checks and concatenates the files above into an ES5 `app.js`, validates the manifest and builds the package. `app.js` is generated and not committed. For a connected package set `NOKIA_BRIDGE_URL` and `NOKIA_CONFIG_FILE` (see `config.js`); optional `NOKIA_POLL_TIMEOUT_MS` overrides the poll timeout; optional `NOKIA_NOTES_URL` with `NOKIA_NOTES_CONFIG_FILE` (private `{"token"}`) enables Notes.

```
node tests/nokia-audio.cjs      # audio lifecycle (also exports the fake-DOM harness)
node tests/nokia-sessions.cjs   # session switch/create/reload
node tests/nokia-connection.cjs # bridge, TTS, archive
node tests/nokia-chat-ui.cjs    # softkeys, pause/resume/Call send, typing, menu, key map
node tests/nokia-reliability.cjs # reconnect probes, queued text, idempotent resend
node tests/nokia-quick-notes.cjs # Notes screen, notes queue, restart resend
```

## Notes

- Requires a privileged install (`type: "privileged"`, `permissions.systemXHR`); see `manifest.webapp`.
- Verified on a Nokia 6300 4G (KaiOS 2.5.4): Centre start/pause/resume (native `MediaRecorder.pause()`), Call send, SoftRight send while paused, Backspace discard with confirm, typed send, and Wi-Fi off/on queue and resend. Clip upload after a restart without signal is verified on the handset (0.3.3), as are Notes voice/typed/offline-queued notes (0.3.4), the pending first turn of a new chat and a paused-then-resumed clip (0.4.0); the voice list remains unverified.
