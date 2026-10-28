import { sign as cryptoSign, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export type RecordValue = Record<string, unknown>;

export interface Gateway extends NodeJS.EventEmitter {
  request(method: string, params: RecordValue): Promise<RecordValue>;
  /** Subscribe to session messages BEFORE sending a chat turn (required by protocol). */
  subscribe(sessionKey: string, agentId: string): Promise<{ key: string }>;
}

export interface Socket extends NodeJS.EventEmitter {
  send(data: string): void;
  close(): void;
  terminate(): void;
}
export type SocketFactory = (url: string, options: RecordValue) => Socket;

export class GatewayFailure extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Server-owned ed25519 device identity for this bridge instance. */
export interface DeviceIdentity {
  deviceId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

/**
 * Build the V3 device auth payload string (mirrors gateway-client/src/device-auth.ts exactly).
 * Format: v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily
 */
function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce: string;
  platform: string;
  deviceFamily: string;
}): string {
  // Normalize metadata fields as the reference implementation does.
  const normalizeMeta = (v: string) => v.trim().replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token,
    params.nonce,
    normalizeMeta(params.platform),
    normalizeMeta(params.deviceFamily),
  ].join('|');
}

/**
 * Sign a UTF-8 payload with an ed25519 private key; returns base64url-encoded signature.
 * This mirrors signEd25519Payload in gateway-client/src/ed25519-signature (if present).
 */
function signPayload(privateKeyPem: string, payload: string): string {
  // Ed25519 uses null digest (prehash=false); crypto.sign handles the hashing internally.
  return cryptoSign(null, Buffer.from(payload, 'utf8'), privateKeyPem).toString('base64url');
}

/**
 * Extract the raw 32-byte ed25519 public key as base64url from a SPKI PEM.
 * Ed25519 SPKI DER has a 12-byte header; raw key is the last 32 bytes.
 */
function publicKeyRawBase64Url(publicKeyPem: string): string {
  const b64 = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(b64, 'base64');
  if (der.length < 32) throw new GatewayFailure('gateway_invalid_device_key');
  return der.subarray(der.length - 32).toString('base64url');
}

/**
 * GatewayClient — lightweight WebSocket gateway client.
 *
 * Identity: uses `client.id = "gateway-client"`, `mode = "backend"`, role = `"operator"`,
 * scopes `["operator.read","operator.write"]`, with a signed ed25519 device proof.
 *
 * Auth: the `headers` parameter contains server-synthesized trusted-proxy headers (e.g. from
 * Tailscale). These are fixed from server configuration and never set by callers.
 * NOKIA_GATEWAY_PRINCIPAL is the authenticated principal for the authorized operator.
 *
 * Pairing gate: on a local (loopback) gateway with auth.mode=none, the gateway's
 * `shouldSkipLocalBackendSelfPairing` bypass allows connection without prior pairing.
 * On a remote gateway the device must be pre-paired; `gateway_request_rejected` with
 * detail `PAIRING_REQUIRED` / `DEVICE_IDENTITY_REQUIRED` is the expected error until
 * the parent approves pairing via the devices-cli tool.
 *
 * Reconnect: never retries a submitted RPC. Disconnect triggers 'disconnect' event;
 * callers must re-subscribe and reconcile history before sending new turns.
 *
 * Hello rejection: `gateway_hello_rejected:<reason>` is emitted to the local error log
 * with the request ID for diagnostics. Only `gateway_hello_rejected` is surfaced to callers.
 */
export class GatewayClient extends EventEmitter implements Gateway {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private _ready = false;
  private maxPayload = 8 * 1024 * 1024;
  private pending = new Map<string, {
    resolve: (v: RecordValue) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(
    private readonly factory: SocketFactory,
    private readonly url: string,
    /** Fixed Tailscale/proxy headers from server config (never caller-set). */
    private readonly headers: Record<string, string>,
    private readonly identity: DeviceIdentity,
    private readonly timeoutMs = 10_000,
  ) { super(); }

  /** Public read-only accessor for connection state. */
  get ready(): boolean { return this._ready; }

  /** Ensure the gateway is connected. Safe to call from authenticated routes. */
  async ensureConnected(): Promise<void> {
    await this.connect();
  }

  private connect(): Promise<void> {
    if (this._ready) return Promise.resolve();
    if (this.connecting) return this.connecting;

    const attempt = new Promise<void>((resolve, reject) => {
      const socket = this.factory(this.url, {
        headers: this.headers,
        maxPayload: 8 * 1024 * 1024,
        followRedirects: false,
      });
      this.socket = socket;
      let challenged = false;
      let connectId = '';
      let settled = false;
      const handshakeTimer = setTimeout(() => fail('gateway_handshake_timeout'), this.timeoutMs);

      const fail = (code: string) => {
        if (this.socket !== socket) return;
        clearTimeout(handshakeTimer);
        this._ready = false;
        this.socket = undefined;
        if (!settled) { settled = true; reject(new GatewayFailure(code)); }
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new GatewayFailure('gateway_disconnected'));
        }
        this.pending.clear();
        this.emit('disconnect', {});
        socket.terminate();
      };

      socket.on('error', () => fail('gateway_connection_failed'));
      socket.on('close', () => fail('gateway_disconnected'));
      socket.on('message', (data: Buffer | string) => {
        try {
          if (Buffer.byteLength(data) > this.maxPayload) return fail('gateway_payload_limit');
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (!this._ready) {
            // Handshake phase
            if (frame.type === 'event' && frame.event === 'connect.challenge' && !challenged) {
              const payload = frame.payload as Record<string, unknown> | undefined;
              const nonce = payload?.nonce;
              const challengeTs = payload?.ts;
              if (typeof nonce !== 'string' || !nonce) return fail('gateway_challenge_missing_nonce');
              if (typeof challengeTs !== 'number' || !Number.isFinite(challengeTs)) {
                return fail('gateway_challenge_missing_ts');
              }
              challenged = true;
              connectId = randomUUID();
              const role = 'operator';
              const scopes = ['operator.read', 'operator.write'];
              const signedAtMs = challengeTs;

              const authPayload = buildDeviceAuthPayloadV3({
                deviceId: this.identity.deviceId,
                clientId: 'gateway-client',
                clientMode: 'backend',
                role,
                scopes,
                signedAtMs,
                token: '',           // no pre-shared token on first connect
                nonce,
                platform: 'linux',
                deviceFamily: '',
              });

              let signature: string;
              let publicKeyB64url: string;
              try {
                signature = signPayload(this.identity.privateKeyPem, authPayload);
                publicKeyB64url = publicKeyRawBase64Url(this.identity.publicKeyPem);
              } catch {
                return fail('gateway_device_signing_failed');
              }

              socket.send(JSON.stringify({
                type: 'req',
                id: connectId,
                method: 'connect',
                params: {
                  minProtocol: 4,
                  maxProtocol: 4,
                  client: {
                    id: 'gateway-client',
                    mode: 'backend',
                    version: '1.0.0',
                    platform: 'linux',
                    displayName: 'nokia-bridge',
                  },
                  role,
                  scopes,
                  device: {
                    id: this.identity.deviceId,
                    publicKey: publicKeyB64url,
                    signature,
                    signedAt: signedAtMs,
                    nonce,
                  },
                },
              }));

            } else if (challenged && frame.type === 'res' && frame.id === connectId) {
              const hello = frame.payload as Record<string, unknown> | undefined;
              if (!frame.ok || hello?.type !== 'hello-ok' || hello.protocol !== 4) {
                // B9: Log the reason code locally; only surface gateway_hello_rejected externally
                const reason = (hello as any)?.detail ?? (hello as any)?.reason ?? (hello as any)?.type ?? 'unknown';
                // Log to stderr with request ID for local diagnostics only
                process.stderr.write(`[nokia-bridge] gateway hello rejected: ${reason} (connectId=${connectId})\n`);
                return fail('gateway_hello_rejected');
              }
              const authScopes = (hello.auth as any)?.scopes as string[] | undefined;
              const hasRequiredScopes = ['operator.read', 'operator.write'].every(
                s => authScopes?.includes(s)
              );
              if (!hasRequiredScopes) return fail('gateway_required_scopes_unavailable');
              const maxPayload = (hello.policy as any)?.maxPayload;
              if (!Number.isSafeInteger(maxPayload) || maxPayload < 1024) {
                return fail('gateway_invalid_policy');
              }
              this.maxPayload = Math.min(8 * 1024 * 1024, maxPayload as number);
              this._ready = true;
              settled = true;
              clearTimeout(handshakeTimer);
              resolve();
            }
            return;
          }

          // Ready phase
          if (frame.type === 'res') {
            const entry = this.pending.get(frame.id as string);
            if (!entry) return;
            this.pending.delete(frame.id as string);
            clearTimeout(entry.timer);
            if (frame.ok) entry.resolve((frame.payload as RecordValue) ?? {});
            else entry.reject(new GatewayFailure('gateway_request_rejected'));
          } else if (frame.type === 'event' && frame.event === 'chat' && frame.payload) {
            this.emit('chat', frame.payload as RecordValue);
          }
        } catch { fail('gateway_invalid_frame'); }
      });
    });

    this.connecting = attempt;
    void attempt.finally(() => {
      if (this.connecting === attempt) this.connecting = undefined;
    }).catch(() => {});
    return attempt;
  }

  async request(method: string, params: RecordValue): Promise<RecordValue> {
    await this.connect();
    const id = randomUUID();
    const data = JSON.stringify({ type: 'req', id, method, params });
    if (Buffer.byteLength(data) > this.maxPayload) throw new GatewayFailure('gateway_payload_limit');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayFailure('gateway_request_timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(data); }
      catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new GatewayFailure('gateway_disconnected'));
      }
    });
  }

  /**
   * Subscribe to session messages BEFORE sending a chat turn (required by protocol).
   * Returns the canonical session key from the gateway response.
   */
  async subscribe(sessionKey: string, agentId: string): Promise<{ key: string }> {
    const subscriptionId = randomUUID();
    const result = await this.request('sessions.messages.subscribe', {
      subscriptionId,
      key: sessionKey,
      agentId,
    });
    return { key: (result.key as string | undefined) ?? sessionKey };
  }

  disconnect(): void {
    this._ready = false;
    this.socket?.terminate();
    this.socket = undefined;
  }
}
