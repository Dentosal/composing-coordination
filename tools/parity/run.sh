#!/usr/bin/env bash
# Parity check: renders one note of every preset with the Rust renderer (--raw) and with the browser voices in
# client/js/voice.js, and compares them (overall level, loudness envelope, spectrum, cross-correlation).
# Expect corr ~1.00 and a level difference within about 1 dB. The Rust output is ~8 ms later (compressor lookahead).
# Needs: cargo, node, deno, and CHROME_PATH pointing at a Chrome/Chromium binary. Uses port 8765.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${CHROME_PATH:?set CHROME_PATH to a Chrome binary}"
cd "$ROOT/server" && cargo build --release --bin render >/dev/null
TMP="$ROOT/client/_t"; mkdir -p "$TMP"
trap 'rm -rf "$TMP" "$ROOT/client/_parity.html"; [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true' EXIT
for f in "$ROOT"/client/presets/*.json; do
  k=$(basename "$f" .json); [ "$k" = index ] && continue
  python3.14 - "$f" "$TMP/$k.json" <<'PY'
import json, sys
i = json.load(open(sys.argv[1]))['instrument']
json.dump({'instruments': [i], 'lanes': [{'instrument': i['id'], 'steps': [{'row': 0, 'note': 48, 'vel': 100}, {'row': 8, 'note': None, 'vel': 100}]}]}, open(sys.argv[2], 'w'))
PY
  "$ROOT/server/target/release/render" "$TMP/$k.json" "$TMP/$k.wav" --bpm 120 --bars 1 --rows-per-bar 16 --seed 1 --raw >/dev/null
  echo "$k:1" >> "$TMP/names.txt"
done
# Release during the attack (pad attack is 0.6 s, gate here is 0.25 s): exercises the envelope release path.
python3.14 - "$TMP/pad.json" "$TMP/pad_short.json" <<'PY'
import json, sys
o = json.load(open(sys.argv[1])); o['lanes'][0]['steps'][1]['row'] = 2
json.dump(o, open(sys.argv[2], 'w'))
PY
"$ROOT/server/target/release/render" "$TMP/pad_short.json" "$TMP/pad_short.wav" --bpm 120 --bars 1 --rows-per-bar 16 --seed 1 --raw >/dev/null
echo "pad_short:0.25" >> "$TMP/names.txt"
cp "$ROOT/tools/parity/page.html" "$ROOT/client/_parity.html"
(cd "$ROOT/client" && python3.14 -m http.server 8765 >/dev/null 2>&1) & PID=$!
sleep 1
deno run -A "$ROOT/tools/parity/run.ts" http://localhost:8765/_parity.html 2>&1 | grep -v -E '^\S*\[0m|^$'
