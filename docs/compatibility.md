# Compatibility

## Tested hardware

| Device | OS | Result |
|---|---|---|
| Nokia 6300 4G TA-1287 | Stock KaiOS / Gecko 48 environment | Voice recording/reply, session navigation and user-reported reboot acceptance |

No other KaiOS devices have been tested.

## KaiOS / Gecko constraints

The KaiOS app (`nokia-klaus`) targets **KaiOS 2.5 / Gecko 48**:

- TypeScript compiled to **ES5** for maximum Gecko 48 compatibility; the app is split into small namespace files concatenated by `tsc --outFile`.
- Layout uses flexbox only (no `gap`, `box-shadow` or filters) and fonts of at least 12px for the 240x320 screen.
- Unsent voice clips are kept in IndexedDB (`klaus-clips`) so they survive a reload; without IndexedDB they are kept in memory only.
- Audio uses `navigator.getUserMedia` (not the modern `MediaDevices.getUserMedia`).
- HTTP requests use `new XMLHttpRequest({mozSystem: true})` for privileged cross-origin
  access — this requires the `systemXHR` manifest permission and a certified or privileged
  app install.
- Speech synthesis uses the Web Speech API (`SpeechSynthesisUtterance` / `speechSynthesis`). The tested phone exposed English, French, German, Spanish and Italian voices, but no Danish voice. The app detects Danish text (æøå or common Danish words) and uses a `da-*` voice when one is installed, otherwise it falls back to English; on the tested phone Danish text is therefore still pronounced with the English voice.
- `MediaRecorder` supplies an Ogg/Opus recording for upload, requested at `audioBitsPerSecond: 16000` (Gecko 48 honours it). On the tested handset an 8 s clip shrank from 62 KB (default) to 27 KB with an identical WhisperX transcript; 12 and 8 kbps began dropping words. `MediaRecorder.mimeType` is empty on Gecko 48, so uploads are labelled `audio/ogg`. The bridge passes the audio into the gateway’s configured STT pipeline.
- Session storage uses `localStorage`.

## OpenClaw gateway

The bridge implements the observed OpenClaw WebSocket protocol-v4 contract and V3 signed device authentication. It was verified against a customized deployment, not a matrix of upstream releases. It needs:

- Narrow trusted-proxy configuration admitting the bridge host and fixed identity headers.
- Explicit pairing of its dedicated backend device for `operator.read` and `operator.write`.
- Session creation, message subscription, chat history/send/abort and audio-attachment/STT contracts matching this implementation.

Do not assume a stock or differently versioned gateway is compatible without qualification.

## Backend tools and STT

The bridge forwards audio to the OpenClaw `chat.send` API. What the gateway does with it
depends on the configured agent (`main`):

- Audio transcription and replies worked on the tested deployment. Tool capability parity—especially email or actions bound to a channel/user identity—is unverified.
- The bridge does not alter existing gateway tools or the agent configuration.
- Broad assistant tool access is the risk of the operator, not this bridge.

## Not included

- KaiOS phone firmware or boot patching tools.
- KaiOS stock app source code.
- OpenClaw gateway source code.
- Automatic phone firmware flashing.
- Strict kiosk enforcement — the app-blocking policy (`nokia-policy.py`) is a **reversible
  development convenience**, not a certified strict kiosk.
- Danish local speech: no Danish voice was available on the tested handset.
