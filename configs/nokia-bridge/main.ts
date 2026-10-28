/**
 * nokia-bridge main entry point.
 *
 * Environment variables (all required at runtime):
 *   NOKIA_GATEWAY_PRINCIPAL     Authenticated operator principal (format: unique@nokia.invalid)
 *                               Must match the principal used when the device was paired.
 *   NOKIA_GATEWAY_URL           WebSocket gateway URL (default: ws://127.0.0.1:18789)
 *   NOKIA_STATE_DIR             Directory for registry + identity files (default: ~/.nokia-bridge)
 *   NOKIA_PROVISIONING_FILE     Path to provisioning JSON (deviceId + tokenHashes, mode 0600)
 *   NOKIA_IDENTITY_FILE         Path to device identity JSON (ed25519 keys, mode 0600)
 *                               Provisioned automatically if absent.
 *   NOKIA_GATEWAY_PUBLIC_HOST   Public proxy hostname forwarded to gateway (required).
 *                               Example: gateway.example.invalid
 *   NOKIA_BIND_HOST             NOT configurable: always 127.0.0.1 (loopback only)
 *   NOKIA_BIND_PORT             HTTP server bind port (default: 18881)
 *
 * Gateway runtime:
 *   The ws module is loaded from the absolute path supplied by GATEWAY_RUNTIME env var
 *   (e.g. /path/to/runtime/node_modules/ws — must be an absolute path to the ws module).
 *   GATEWAY_RUNTIME is required; there is no fallback. The correct server-installed runtime
 *   must always be specified explicitly.
 *
 * Pairing:
 *   On first run the device identity is provisioned and the deviceId is logged to stderr.
 *   The parent must approve pairing via the devices-cli tool before the gateway will accept
 *   connections. Once paired, the gateway loopback (127.0.0.1:18789) is used.
 */
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createBridge, provisionDeviceIdentity, readDeviceIdentity, readProvisioning, requirePrincipal } from './bridge';
import { GatewayClient } from './gateway';

async function main(): Promise<void> {
  const principal = requirePrincipal();
  const stateDir = resolve(process.env.NOKIA_STATE_DIR ?? join(homedir(), '.nokia-bridge'));
  const identityFile = process.env.NOKIA_IDENTITY_FILE ?? join(stateDir, 'device-identity.json');
  const provisioningFile = process.env.NOKIA_PROVISIONING_FILE ?? join(stateDir, 'provisioning.json');

  // Validate gateway URL — must be loopback only
  const gatewayUrl = process.env.NOKIA_GATEWAY_URL ?? 'ws://127.0.0.1:18789';
  const parsedGwUrl = new URL(gatewayUrl);
  if (parsedGwUrl.hostname !== '127.0.0.1') {
    throw new Error('NOKIA_GATEWAY_URL must be a loopback address (127.0.0.1)');
  }

  const bindHost = '127.0.0.1'; // non-configurable: loopback only
  const bindPort = Number(process.env.NOKIA_BIND_PORT ?? '18881');

  // GATEWAY_RUNTIME is required; no fallback to local node_modules
  const gatewayRuntime = process.env.GATEWAY_RUNTIME;
  if (!gatewayRuntime || !isAbsolute(gatewayRuntime)) {
    process.stderr.write('[nokia-bridge] ERROR: GATEWAY_RUNTIME env var required (absolute path to ws module, e.g. /path/to/runtime/node_modules/ws)\n');
    process.exit(1);
  }
  const WebSocket: any = require(resolve(gatewayRuntime));

  // Ensure state directory exists with restricted permissions before provisioning identity
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  // Load or provision device identity — only ENOENT triggers provisioning, not invalid key
  let identity;
  try {
    identity = await readDeviceIdentity(identityFile);
    process.stderr.write(`[nokia-bridge] loaded device identity: deviceId=${identity.deviceId}\n`);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e; // invalid key or other error propagated, never re-provision
    process.stderr.write(`[nokia-bridge] provisioning new device identity at ${identityFile}\n`);
    identity = await provisionDeviceIdentity(identityFile);
    process.stderr.write(`[nokia-bridge] provisioned deviceId=${identity.deviceId} — pairing required before gateway connects\n`);
  }

  // Synthesize server-fixed trusted-proxy headers (Tailscale loopback auth)
  const gatewayHeaders: Record<string, string> = {
    'Tailscale-User-Login': principal,
    'Tailscale-Headers-Info': JSON.stringify({ loginName: principal, displayName: principal, profilePicURL: '' }),
    // Attribution is this bridge host, not a claimed handset network address.
    // Loopback is skipped by the gateway's trusted-proxy chain resolver.
    'X-Forwarded-For': process.env.NOKIA_GATEWAY_CLIENT_IP ?? (() => { throw new Error('NOKIA_GATEWAY_CLIENT_IP required: verified bridge host address'); })(),
    'X-Forwarded-Host': (() => {
      const h = process.env.NOKIA_GATEWAY_PUBLIC_HOST;
      if (!h) throw new Error('NOKIA_GATEWAY_PUBLIC_HOST env var required (public proxy hostname, e.g. gateway.example.invalid)');
      return h;
    })(),
    'X-Forwarded-Proto': 'https',
  };

  const gatewayClient = new GatewayClient(
    (url, opts) => new WebSocket(url, opts),
    gatewayUrl,
    gatewayHeaders,
    identity,
    10_000,
  );

  const { server } = await createBridge({
    stateDirectory: stateDir,
    provisioning: () => readProvisioning(provisioningFile),
    gateway: gatewayClient,
    principal,
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(bindPort, bindHost, () => {
      const addr = server.address() as { address: string; port: number };
      process.stderr.write(`[nokia-bridge] listening on http://${addr.address}:${addr.port}\n`);
      resolve();
    });
    server.once('error', reject);
  });

  // Graceful shutdown
  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    process.stderr.write(`[nokia-bridge] shutting down (${signal})\n`);
    await new Promise<void>((res) => server.close(() => res()));
    gatewayClient.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch(e => {
    process.stderr.write(`[nokia-bridge] fatal: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
