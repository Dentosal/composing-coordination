// The hash of everything client/wasm/renderer.wasm is built from: the renderer crate, its WebAssembly wrapper and the
// forked web-audio-api crate (sources, manifests and the wrapper's lock file). tools/build-wasm.sh records it next to the module, and
// client/js/wasm.test.mjs fails when the sources have changed since (the module needs rebuilding).
// Run directly, it prints the hash.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'target' ? [] : files(p);
    return /\.(rs|toml)$/.test(name) || p.endsWith(join('wasm', 'Cargo.lock')) ? [p] : [];
  });
}

export function wasmSourceHash() {
  const h = createHash('sha256');
  // The renderer, its WebAssembly wrapper, and the forked web-audio-api crate they are built from.
  for (const p of [...files(join(ROOT, 'renderer')), ...files(join(ROOT, 'vendor', 'web-audio-api'))].sort()) {
    h.update(relative(ROOT, p).split('\\').join('/') + '\0');
    h.update(readFileSync(p));
    h.update('\0');
  }
  return h.digest('hex');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(wasmSourceHash());
