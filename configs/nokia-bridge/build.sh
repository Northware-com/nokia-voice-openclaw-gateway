#!/usr/bin/env bash
# Build the bridge using this checkout's pinned TypeScript and Node types.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
TSC="${TSC:-$REPO/node_modules/typescript/bin/tsc}"
[[ -f "$TSC" ]] || { echo 'Run npm ci, or set TSC to an installed TypeScript compiler' >&2; exit 1; }
node "$TSC" --strict --target ES2022 --module commonjs --moduleResolution node10 \
  --ignoreDeprecations 6.0 --lib ES2022 --esModuleInterop --skipLibCheck \
  --typeRoots "$REPO/node_modules/@types" --types node --outDir "$ROOT/dist" \
  "$ROOT/bridge.ts" "$ROOT/gateway.ts" "$ROOT/main.ts"
echo "Built $ROOT/dist"
