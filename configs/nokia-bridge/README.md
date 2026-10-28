# Nokia → Klaus bridge

A separate loopback HTTP service translates the Nokia handset's small API into signed OpenClaw WebSocket requests. It fixes the agent to `main`, creates server-owned session keys, and exposes no arbitrary gateway RPC, caller-selected agent, or raw gateway credential.

## Runtime boundary

- Bind: **127.0.0.1:18881**, not a public listener.
- Public HTTPS: only the approved `/nokia/v1` proxy route. Preserve every unrelated colocated service and route.
- Handset: unique revocable bearer token. Server provisioning contains SHA-256 hashes; it is reloaded on every authenticated request.
- Gateway: a dedicated Ed25519 backend device, `gateway-client` / `backend`, operator role, **operator.read + operator.write only**. Never substitute Control UI to bypass pairing.
- Identity ID: full 64-character SHA-256 of the raw 32-byte Ed25519 public key. Identity private key remains server-side.
- Gateway trusted-proxy headers are fixed by server configuration, never copied from handset requests. Client attribution is the verified bridge host address, not a claimed handset IP. Loopback is skipped by the gateway's proxy-chain resolver and cannot serve as forwarded client attribution.

The bridge's principal is a unique service identity, not an impersonated end-user identity or the gateway owner. Gateway read/write scopes are broader than the handset API; the bridge is the handset's authorization boundary. Pair only its inspected request and exact public-key identity.

## Build and offline tests

```sh
bash configs/nokia-bridge/build.sh
node tests/nokia-bridge.cjs
```

Build uses the repository's existing TypeScript/Node types without installing dependencies. The runtime needs Node and the already installed `ws` module; the service's module path must be explicit. Generated `dist/` is not credential storage and should not be committed.

## HTTP contract

All paths below are relative to `/nokia/v1`. Bearer authentication is required except on `GET /health`.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/health` | none | `{ok:true, connected:boolean}`; does not connect the gateway |
| GET | `/sessions` | bearer | `{sessions:[{id,title}]}`; attempts gateway connection |
| POST | `/sessions` | JSON `{title,clientId}` | 201 `{id,title}`, 200 for known idempotent creation |
| GET | `/sessions/:id` | bearer | `{id,title,state,runId?,messages:[{role,text}],error?}` |
| POST | `/sessions/:id/turns` | raw `audio/ogg`, or JSON `{text}` | 202 `{runId,state:"pending"}` means admitted, not complete |
| POST | `/sessions/:id/cancel` | JSON `{turnRequestId}` | targets only that session's exact recorded turn/run |

POSTs use a stable UUID `X-Request-Id`. Session creation may use UUID `clientId` as its idempotency key if the header is absent. Cancellation has its own request UUID and **must identify the original turn UUID in its JSON body**. An empty-body/global cancellation is not supported.

Public states: `idle`, `pending`, `complete`, `error`, `cancelled`, `uncertain`. Completion comes from gateway events or defensible owned-history reconciliation, not a successful HTTP upload. Never automatically resubmit a write after an uncertain acknowledgement. Switching the handset's selected session does not cancel server requests.

Limits include 128 sessions, four concurrent active turns, one active turn per session, 5 MiB Ogg uploads, 16,000-character text input, 8,192 idempotency operations and a 16 MiB private registry. Long-lived operation retention has no garbage collection yet; reaching a limit fails rather than forgetting deduplication records.

## Private provisioning

Keep provisioning, identity, runtime environment, bearer token and live handset package **outside the repository**. Use a mode-0700 directory and mode-0600 files, created exclusively. Do not print tokens or pass them in command arguments.

Server provisioning schema:

```json
{"deviceId":"a-unique-handset-id","tokenHashes":["64-lowercase-hex-sha256"]}
```

`deviceId` here identifies the handset's owned namespace; it is distinct from the gateway device identity's public-key hash. The gateway identity file contains `deviceId`, `publicKeyPem`, and `privateKeyPem`. Startup provisions it only on ENOENT; an invalid existing identity is an error, not permission to replace a paired key.

| Environment | Requirement |
|---|---|
| `NOKIA_GATEWAY_PRINCIPAL` | Required unique service principal, e.g. a reserved `.invalid` identity |
| `NOKIA_GATEWAY_CLIENT_IP` | Required verified bridge-host address accepted by the narrow trusted-proxy chain |
| `GATEWAY_RUNTIME` | Required explicit path to the installed **ws module directory** |
| `NOKIA_GATEWAY_URL` | Default `ws://127.0.0.1:18789`; only loopback is accepted |
| `NOKIA_STATE_DIR` | Private writable registry directory |
| `NOKIA_PROVISIONING_FILE` | Private hash-only provisioning JSON |
| `NOKIA_IDENTITY_FILE` | Private server-side Ed25519 identity JSON |
| `NOKIA_BIND_PORT` | Default 18881 |

The bind host is hardcoded to 127.0.0.1, not configurable. Run compiled `dist/main.js` as a dedicated unprivileged service user with a readable Node/ws runtime outside `/root`, no capabilities, no new privileges, a private temporary directory, read-only system/home and only its private state directory writable. The existing gateway does not need a source change or restart.

## Pairing and activation gates

1. Build, test and independently review the exact source; stage an immutable release and private files.
2. Start the separate loopback service. Check health, listener address and unauthorized 401 independently.
3. Trigger an authenticated connection. Inspect `openclaw devices list --json` on the verified serving host/profile without printing device tokens or unrelated records.
4. Match the exact pending request to the bridge public-key hash, `gateway-client`, `backend`, operator role and **only read/write scopes**. Approve that explicit request ID with `openclaw devices approve REQUEST_ID --json`; never approve `--latest` blindly or clear other devices.
5. Prove actual gateway connection and allowed scopes. Only then add the specific Funnel route and test HTTPS auth rejection/success.
6. Perform a real session/turn round trip before declaring handset readiness. Phone microphone/STT, visible transcript, local speech, cancellation, reconnect and multiple sessions are separate acceptance gates.

Gateway scope approval is an administrator operation on the host; the approved device's resulting scopes must still be only read/write. Do not place the approving administrator's credentials on the bridge or phone.

## Rollback and revocation

Preserve the exact pre-change proxy configuration and prior release/service environment privately. To disable this route, remove **only `/nokia/v1`** using the supported path-specific operation; never run a global proxy/Funnel reset that would interrupt unrelated routes. Stop only `nokia-bridge.service`. Revoke handset access by replacing `tokenHashes` with an empty array; the next authenticated request is denied. Remove/revoke only this bridge identity if necessary, never the entire device table. Unrelated services remain untouched.

Source publication is not activation. Replacing a loaded bridge release requires separate approved service lifecycle handling, with rollback ready.

## Evidence and release boundary

The original test deployment completed authenticated HTTPS session creation, a text reply, a microphone-originated reply visible on the handset, and user-reported phone reboot acceptance. These are integration observations, not proof that every compatible gateway/device or the exact portable publication revision is production-qualified.

The public source has offline build/test coverage. Strict feature restriction, ordinary calls/SMS, all cancellation/reconnect edge cases and identity-sensitive tool parity remain separate acceptance gates. See [compatibility](../../docs/compatibility.md).
