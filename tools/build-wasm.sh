#!/usr/bin/env bash
# Builds the renderer for the browser: renderer/wasm -> client/wasm/renderer.wasm, plus renderer.hash, the hash of
# the sources it was built from (client/js/wasm.test.mjs checks it is current). Run after changing anything in renderer/.
# Needs the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown); uses wasm-opt when installed.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/renderer/wasm"
cargo build --release --target wasm32-unknown-unknown
built="target/wasm32-unknown-unknown/release/band_render_wasm.wasm"
out="$root/client/wasm/renderer.wasm"
mkdir -p "$(dirname "$out")"
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --strip-debug --strip-producers "$built" -o "$out"
else
  echo "wasm-opt not found: copying the module unoptimized" >&2
  cp "$built" "$out"
fi
node "$root/tools/wasm-source-hash.mjs" > "$root/client/wasm/renderer.hash"
echo "$out: $(wc -c < "$out" | tr -d ' ') bytes ($(gzip -9 -c "$out" | wc -c | tr -d ' ') gzipped)"
