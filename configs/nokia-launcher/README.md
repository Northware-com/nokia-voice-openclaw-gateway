# Nokia Launcher

A minimal KaiOS 2.5.4 / Gecko 48 homescreen with three navigation choices: Klaus, Phone, and SMS. It discovers Klaus/SMS with `navigator.mozApps.mgmt.getAll()`; Phone uses the stock dial activity, not the communications Call Log launch path.

- **Klaus** → `app://huginn-klaus-audio-proof/manifest.webapp`
- **Phone** → `MozActivity({name: "dial", data: {type: "webtelephony/number", number: ""}})` opens the stock blank keypad (`dial-activity.html`) without dialing. The stock launcher remains untouched.
- **SMS** → `app://sms.gaiamobile.org/manifest.webapp`

Klaus is the local audio-proof app, not a live Klaus agent. This launcher provides navigation only; it does not disable, block, or otherwise enforce restrictions on other apps or device features. It makes no network requests, obtains no tokens, initiates no calls, requests no microphone access, reads no files, and does not modify stock applications or settings.

Use Up/Down to move, Enter or SoftLeft (Select) to open the highlighted choice, or 1/2/3 to immediately open Klaus/Phone/SMS. Large touch choices are also available. There is no Back softkey: the launcher is the home screen, so the right softkey is intentionally blank. Errors are shown in the status area; the launcher reports when app discovery is still in progress, fails, or a choice is not installed.

## Build

Run `configs/nokia-launcher/build.sh [output.zip]`. It compiles TypeScript to ES5 using the repository's installed TypeScript compiler and packages `manifest.webapp`, `index.html`, `style.css`, and `app.js`. Set `TSC` if the compiler is installed elsewhere. By default the archive is `configs/nokia-launcher/nokia-launcher.zip`.

Installation has **not** been performed by this task. No device operations were run.
