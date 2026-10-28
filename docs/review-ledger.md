# Initial source-release review ledger

Scope: original handset app, launcher, narrow bridge, debugger/policy tooling, portable build/tests and public documentation. Firmware, credential-bearing packages and private runtime/history are excluded. This is an experimental source release, not certification of strict handset lockdown or every upstream gateway version.

## Round 1

Two independent read-only reviewers inspected the complete staged payload. The general reviewer found no publication-blocking source defect. The security reviewer required two privacy corrections:

| ID | Decision | Resolution |
|---|---|---|
| F-1 | Accepted | Replaced the real proxy hostname in both fake WebSocket test fixtures with `gateway.example.invalid`. |
| F-2 | Accepted | Removed an unrelated colocated service name/path from the bridge documentation; retained the generic preserve-other-routes requirement. |
| F-3 | Informational | Retained the optional development-probe manifest identifier because the reviewed reversible policy recognizes that app; it is not a credential or bundled app. |
| N1 | Informational | UUID versions 1–8 are accepted; handset generation uses v4. |
| N2 | Documented limitation | Idempotency operation retention is bounded without garbage collection; exhaustion fails rather than forgetting deduplication records. |
| N3 | Documented limitation | Persistence trimming may be costly at the largest local history sizes; no measured performance claim is made. |

The parent's own checks corrected unsupported 8110/OS-version claims, distinguished the handset bearer from the stronger server-side signing identity, made setup export environment variables explicitly, removed personal compiler fallbacks, and clarified source-inspection provenance. A separate exact-private-value scan supplements Gitleaks because public infrastructure identifiers are not necessarily detected as secrets.

## Final gate

The final commit must be independently rechecked after these corrections, pass fresh build/offline suites and redacted secret scanning, and be read back from GitHub with successful CI. No source-publication step authorizes phone/VPS activation. Runtime integration observations from the original test deployment are explicitly separate from this portable revision's offline evidence.
