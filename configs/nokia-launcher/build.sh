#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$ROOT/../.." && pwd)
# Standalone checkout: npm ci supplies the compiler; TSC may override its path.
TSC=${TSC:-"$REPO/node_modules/typescript/bin/tsc"}
[ -f "$TSC" ] || { echo "Run npm ci, or set TSC to an installed TypeScript compiler" >&2; exit 1; }
OUT=${1:-"$ROOT/nokia-launcher.zip"}
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
node "$TSC" --strict --ignoreDeprecations 6.0 --target ES5 --lib DOM,ES2015 --skipLibCheck --outFile "$ROOT/app.js" "$ROOT/app.ts"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$ROOT/manifest.webapp"
command -v zip >/dev/null 2>&1 || { echo "zip is required" >&2; exit 1; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
(cd "$ROOT" && zip -q -j "$TMP/package.zip" manifest.webapp index.html style.css app.js)
mv "$TMP/package.zip" "$OUT"
echo "Built $OUT"
