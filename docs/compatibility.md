# Compatibility

## Tested hardware

| Device | OS | Result |
|---|---|---|
| Nokia 6300 4G TA-1287 | Stock KaiOS / Gecko 48 environment | Voice recording/reply, session navigation and user-reported reboot acceptance |

No other KaiOS devices have been tested.

## KaiOS / Gecko constraints

The KaiOS app (`nokia-klaus`) targets **KaiOS 2.5 / Gecko 48**:

- TypeScript compiled to **ES5** for maximum Gecko 48 compatibility.
- Audio uses `navigator.getUserMedia` (not the modern `MediaDevices.getUserMedia`).
- HTTP requests use `new XMLHttpRequest({mozSystem: true})` for privileged cross-origin
  access — this requires the `systemXHR` manifest permission and a certified or privileged
  app install.
- Speech synthesis uses the Web Speech API (`SpeechSynthesisUtterance` / `speechSynthesis`). The tested phone exposed English, French, German, Spanish and Italian voices, but no Danish voice. The app selects English speech; Danish text may be pronounced poorly.
- `MediaRecorder` supplies an Ogg recording for upload. The bridge passes the audio into the gateway’s configured STT pipeline.
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
