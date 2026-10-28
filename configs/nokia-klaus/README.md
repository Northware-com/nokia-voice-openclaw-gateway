# Klaus local voice terminal (KaiOS)

Voice-to-text recorder and bridge client for the EcoRay / Klaus backend. Audio is recorded via microphone, submitted to the bridge server, and the assistant reply is shown in the transcript and spoken via TTS.

## Features

- **Sessions** — up to 128 open sessions, navigated with ← / →. Press 3 to create a new one.
- **Archive** — press 7 to archive the current session (confirmation prompt; second 7 confirms, Back cancels). Archived sessions are hidden from navigation but retained in storage. Pending archived sessions continue polling and TTS delivery.
- **Recording** — Centre (Enter) starts/stops mic recording. Back cancels. Recording is inhibited while a server request is in-flight (shows feedback before requesting mic permission).
- **Bridge connection** — requires `config.js` injecting `NOKIA_RUNTIME_CONFIG` with `bridgeUrl` and `bridgeToken`. Connection indicator shows: CONNECTED (auth probe + health both pass), AUTH ERROR (401/403 on GET /sessions), GATEWAY DOWN, UNREACHABLE, or NOT CONNECTED (no config).
- **Cancel** — Back key cancels in-flight server request using `"cancelling"` state; poll continues until server confirms, then transitions to `"cancelled"`. Cancel POST body carries `{turnRequestId}` to target only the current run.
- **TTS** — assistant replies are serialized in a queue bound to their session. Replay (5 key / softkeys) inserts at queue head without discarding other sessions' queued items. TTS is inhibited while recording; resumes when recording stops.
- **Persistence** — sessions stored in `localStorage` key `klaus.sessions.v2`. Migrates legacy `v1` key. Persisted store capped at 1 MiB total (trims oldest messages first, keeps all IDs and metadata). Per-session cap: 128 messages, 64 k aggregate chars.
- **Cold start** — pending/uncertain/cancelling sessions resume polling on reload.

## Keys

| Key | Action |
|-----|--------|
| Centre / Enter | Record / stop recording |
| Back / Escape | Cancel request or archive confirmation |
| ← / → | Navigate open sessions (skips archived) |
| ↑ / ↓ | Scroll transcript |
| 3 | New session |
| 5 / softkeys | Replay last reply (TTS) or recorded audio |
| 7 | Archive session (two-press confirm) |

## Build

Run `./build.sh` to type-check the ES5 app, validate the manifest, and build `klaus-audio-proof.zip`.

```
node tests/nokia-audio.cjs      # audio lifecycle
node tests/nokia-sessions.cjs   # session switch/create/reload
node tests/nokia-connection.cjs # bridge, TTS, archive (41 tests)
```

## Notes

- Requires KaiOS privileged app (`type: "privileged"`, `permissions.systemXHR`) — see `manifest.webapp`.
- `config.js` is excluded from the public zip; it is injected at deploy time with real bridge credentials.
- The source `app.ts` is TypeScript; `app.js` is the hand-maintained ES5 compiled output (no build toolchain on device).
