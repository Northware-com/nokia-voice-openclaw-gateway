# Setup

This is an experimental source release, not a one-click firmware replacement. Read [compatibility](compatibility.md) and [security](security.md) before connecting a gateway or handset. Nothing here flashes firmware.

## Prerequisites and offline build

- Node.js 24 or newer, npm, Git, Python 3.10+ and the `zip` command.
- An unlocked/developer-capable KaiOS environment with its debugger already reachable, plus `adb` for installation. Developer access varies by firmware; this repository does not supply an exploit or bypass.
- A gateway matching the documented protocol-v4, trusted-proxy, pairing and audio/STT contracts.

```sh
git clone https://github.com/lucasfth/nokia-voice-openclaw-gateway.git
cd nokia-voice-openclaw-gateway
npm ci
npm run build
npm test
```

Build writes `configs/nokia-bridge/dist/`, generated `app.js` files, and two **offline** ZIPs. These outputs are ignored by Git. Tests use local fake gateway/HTTP connections, not the production gateway or phone. No globally installed TypeScript or personal config checkout is needed.

## Private configuration

Use a directory outside every repository checkout, owned by the eventual service user. The following paths are examples; choose locations appropriate to your OS.

```sh
PRIVATE="$HOME/.local/state/nokia-voice-openclaw-gateway"
umask 077
mkdir -p "$PRIVATE"
chmod 700 "$PRIVATE"
cp .env.example "$PRIVATE/runtime.env"
chmod 600 "$PRIVATE/runtime.env"
```

Edit the private environment file. Set the unique service principal, **verified non-loopback bridge-host address**, actual proxy hostname, and absolute deployed `ws` module path. The documentation address in `.env.example` is not usable as-is. `NOKIA_GATEWAY_URL` is loopback; it is different from forwarded client attribution.

Set private state/provisioning/identity paths explicitly in this file. The runtime does **not** automatically read `.env` files. For an interactive POSIX shell, export them deliberately:

```sh
set -a
. "$PRIVATE/runtime.env"
set +a
```

A service manager can load the same environment using its native private environment-file mechanism. Run the bridge as a dedicated unprivileged account; ensure Node, `ws` and compiled source are readable without opening another user's private home.

## Generate the handset token and server hash

Create private handset configuration and server provisioning together without printing the token or putting it in shell arguments:

```sh
node - "$PRIVATE" <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = process.argv[2];
const token = crypto.randomBytes(32).toString('base64url');
const deviceId = 'handset-' + crypto.randomBytes(8).toString('hex');
const files = {
  'handset.json': {token},
  'provisioning.json': {deviceId, tokenHashes: [crypto.createHash('sha256').update(token).digest('hex')]},
};
for (const [name, value] of Object.entries(files)) {
  const fd = fs.openSync(path.join(directory, name), 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
JS
```

This is exclusive creation, not a rotation command. Set `NOKIA_PROVISIONING_FILE` to the resulting server file. Keep `handset.json` on the trusted packaging host; the server needs its **hash**, not that raw token. Copying private files between hosts is an operator responsibility; preserve ownership and mode 0600.

## Start and pair the separate bridge

```sh
node configs/nokia-bridge/dist/main.js
```

Startup provisions a dedicated signing identity only when its private file is absent. An invalid existing identity is an error, never silently replaced. The public-key-derived device ID is logged; the private key is not.

**Starting the HTTP listener alone does not initiate pairing.** An authenticated `GET /nokia/v1/sessions` attempts the gateway connection. For a local qualification request without a token on the command line:

```sh
node - "$PRIVATE/handset.json" <<'JS'
const fs = require('node:fs');
const {token} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  const response = await fetch('http://127.0.0.1:18881/nokia/v1/sessions', {
    headers: {Authorization: 'Bearer ' + token}, signal: AbortSignal.timeout(15000),
  });
  console.log('HTTP status:', response.status);
  const health = await fetch('http://127.0.0.1:18881/nokia/v1/health');
  console.log(await health.json());
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS
```

On the verified gateway host/profile:

1. Inspect `openclaw devices list --json` privately. Match the exact public-key hash, client `gateway-client`, mode `backend`, operator role and only `operator.read` / `operator.write` scopes.
2. Approve **that explicit request ID** using `openclaw devices approve REQUEST_ID --json`. Never approve an uninspected latest request or clear the device table.
3. Repeat the authenticated local request; health must now report `connected:true`. A sessions HTTP 200 alone is not gateway-readiness proof.

The host's approving administrator credentials never belong on the phone or bridge. This procedure assumes that the gateway's configured trusted-proxy authentication admits the fixed server headers. Do not widen trust ranges or impersonate Control UI to bypass rejection.

## HTTPS and handset installation

Expose only the approved `/nokia/v1` route through your HTTPS proxy. Back up existing proxy configuration and preserve unrelated routes. The bridge itself must remain on 127.0.0.1:18881. Independently verify missing/wrong tokens return 401 before provisioning the phone.

Build a credential-bearing ZIP **outside** the repository:

```sh
NOKIA_BRIDGE_URL=https://gateway.example.invalid/nokia/v1 \
NOKIA_CONFIG_FILE="$PRIVATE/handset.json" \
  bash configs/nokia-klaus/build.sh "$PRIVATE/klaus-connected.zip"
```

Replace the placeholder hostname first. Never attach that ZIP to a GitHub release. The installed phone necessarily contains its revocable bearer token.

For an already authorized/reachable KaiOS debugger, inspect `python3 scripts/nokia-debugger.py --help`. Typical app installation uses:

```sh
python3 scripts/nokia-debugger.py install "$PRIVATE/klaus-connected.zip" --id huginn-klaus-audio-proof
python3 scripts/nokia-debugger.py install configs/nokia-launcher/nokia-launcher.zip --id huginn-nokia-launcher
```

Installing apps does not prove they are selected as the homescreen, grant every permission, or enforce kiosk restrictions. Preserve the original homescreen value and recovery access before changing device settings. `nokia-policy.py` is development blocking with explicit snapshots/restore, not a qualified strict lockdown.

## Acceptance and rollback

Test microphone → configured gateway STT → correct conversation → visible reply → audible speech, then session switching, targeted cancellation, Wi-Fi loss and restart persistence. The phone's local English voice is not proof of a Danish speech voice. Normal calling/SMS and emergency dependencies need separate qualification.

For unattended operation configure the bridge service's boot enablement and permissions deliberately; tests do not activate it. Keep a prior immutable release and private configuration backup. Revoke the handset by emptying server `tokenHashes`; remove only this proxy path and stop only this bridge service when rolling back. Never reset unrelated Funnel routes or restart the existing gateway merely to make this bridge appear healthy.
