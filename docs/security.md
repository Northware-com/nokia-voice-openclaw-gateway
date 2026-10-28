# Security Notes

## Threat model summary

The bridge translates KaiOS phone requests into signed OpenClaw WebSocket operations.
It is not a zero-risk component. Read this before deploying.

## Credential storage

| Secret | Location | Risk |
|---|---|---|
| Phone bearer token | `config.js` inside the phone package zip | Plain-text; extractable from the zip by anyone with physical access |
| Server provisioning (token hashes) | `provisioning.json` (mode 0600, outside repo) | Protected by filesystem permissions only |
| Gateway Ed25519 private key | `device-identity.json` (mode 0600, outside repo) | Paired operator.read/write gateway access; not administrator scope |
| Runtime environment | Private `.env` or service environment | Principal, paths and infrastructure configuration; not a substitute for the separate key/token files |

**Never commit any of these to this repository.**

## Phone bearer token

The bearer token embedded in `config.js` is a plain-text secret:

- It is stored in the KaiOS package zip, which is transferred to the phone over USB.
- Anyone with the zip can read the token.
- Use a dedicated per-device token. Rotate it if the phone is lost or the zip is leaked.
- Revoke access immediately by replacing `tokenHashes` in `provisioning.json` with `[]`.
  The bridge reloads provisioning on every authenticated request — no restart needed.

## Public Funnel / proxy route

The bridge is intended to sit behind a public HTTPS proxy (e.g. Tailscale Funnel):

- **The public URL is shared infrastructure.** Other services may share the same host.
  The bridge only handles `/nokia/v1` paths; all other routes are unaffected.
- A valid bearer token is required for all endpoints except `GET /health`.
  Unauthenticated requests get `401 unauthorized` — no session or gateway access.
- The server-side signing key has gateway `operator.read`/`operator.write` scopes broader than the handset API. A leaked **handset bearer** does not become that signing key: it grants the same session API and assistant actions available to this handset. A bridge-host/key compromise is a separate, broader gateway-access risk.
- Run a separate security audit before adding additional Funnel routes.

## Credential-bearing phone package

When building with `NOKIA_BRIDGE_URL` set, `build.sh` embeds the token from
`NOKIA_CONFIG_FILE` into `config.js` inside the zip:

- The output zip is mode 0600 and is written **outside** the repository.
  The build script refuses to write a credential-bearing zip anywhere inside the repo tree.
- `NOKIA_CONFIG_FILE` must be mode 0600. The build script rejects world-readable config.
- The token is validated to be 32–128 URL-safe characters and never echoed to stdout/stderr.
- The bridge URL must be HTTPS without credentials, query strings, or fragments.

## Gateway scope

The bridge's Ed25519 device identity is approved with `operator.read` and `operator.write`.
These scopes are broader than what the handset API uses. The pairing step must:

1. Verify the exact `deviceId` matches the bridge's logged public-key hash.
2. Confirm the role is `operator`, client mode `backend`, client ID `gateway-client`.
3. Confirm **only** `operator.read` and `operator.write` are granted.
4. Approve the exact pending request ID — never `--latest` or a wildcard.

## Private file permissions

All runtime files must be mode 0600 (owner read/write only):

- `provisioning.json`
- `device-identity.json`
- `registry.json` (auto-created by bridge)
- The state directory must be mode 0700.

The bridge rejects group/world-accessible or symlinked private input files. New state directories are created with mode 0700; an existing directory’s ownership and permissions must also be checked by the operator. These POSIX checks do not protect a compromised service account or host.

## Rollback

- To disable handset access: replace `tokenHashes` with `[]` in `provisioning.json`.
- To disable the route: remove only the `/nokia/v1` Funnel path entry.
  Never run a global Funnel reset — it interrupts unrelated services.
- To revoke the gateway device: remove only this bridge's device identity.
  Never clear the entire device table.
