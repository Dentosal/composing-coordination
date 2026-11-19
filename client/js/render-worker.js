// Web Worker: renders a song with the server's own renderer, compiled to WebAssembly (client/wasm/renderer.wasm, built
// from renderer/ by tools/build-wasm.sh), off the page's main thread. See renderer/wasm/src/lib.rs for the interface.
//
// Message in:  { wasmUrl, cfg: {bpm, bars, rows_per_bar, seed}, seat, orders }
// Messages out: { progress: fraction } while rendering, then { wav: ArrayBuffer } or { error: message }.

let compiled = null; // the compiled module, kept for the next render in this worker

self.onmessage = async ({ data: { wasmUrl, cfg, seat, orders } }) => {
  let message = '';
  try {
    compiled ??= await compile(wasmUrl);
    let exports = null;
    // A fresh instance per render: its memory (which only ever grows) is freed with it.
    const instance = await WebAssembly.instantiate(compiled, {
      env: {
        progress: (fraction) => self.postMessage({ progress: fraction }),
        report_error: (ptr, len) => { message = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, ptr, len)); },
        // only live playback uses these (see live-worker.js)
        emit: () => {},
        cmd_len: () => 0,
        cmd_read: () => {},
      },
    });
    exports = instance.exports;
    const json = new TextEncoder().encode(JSON.stringify(orders));
    const ptr = exports.alloc(json.length);
    new Uint8Array(exports.memory.buffer, ptr, json.length).set(json);
    const out = exports.render_song(ptr, json.length, cfg.bpm, cfg.bars, cfg.rows_per_bar, BigInt(String(cfg.seed)), seat);
    if (!out) throw new Error(message || 'the render failed');
    const len = new DataView(exports.memory.buffer).getUint32(out, true);
    const wav = exports.memory.buffer.slice(out + 4, out + 4 + len);
    self.postMessage({ wav }, [wav]);
  } catch (e) {
    // A panic in the renderer aborts with a RuntimeError ("unreachable"); report_error has the real reason.
    self.postMessage({ error: message || e?.message || String(e) });
  }
};

async function compile(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the renderer could not be loaded (${r.status})`);
  // Streaming compilation needs the server to send application/wasm; fall back to compiling the bytes.
  if (WebAssembly.compileStreaming && r.headers.get('content-type')?.startsWith('application/wasm')) return WebAssembly.compileStreaming(r);
  return WebAssembly.compile(await r.arrayBuffer());
}
