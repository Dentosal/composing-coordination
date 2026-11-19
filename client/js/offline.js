// Renders a part to a song file in the browser, with the server's own renderer compiled to WebAssembly (see
// render-worker.js), so the file is the same as the server would make: the pattern played once from silence, ringing
// out at the end, as 16-bit stereo WAV at 48 kHz. It runs in a Web Worker, so the page stays responsive.

const WORKER_URL = new URL('./render-worker.js', import.meta.url);
const WASM_URL = new URL('../wasm/renderer.wasm', import.meta.url).href;

/**
 * Render `orders` (one seat's part, at join-order index `seat`) with session config `cfg` to WAV bytes.
 * `onProgress(fraction)` is called as rendering advances.
 * @param {{bpm:number,bars:number,rows_per_bar:number,seed:number|string}} cfg
 * @param {import('./types.js').Orders} orders
 * @returns {Promise<ArrayBuffer>}
 */
export function renderSong(cfg, seat, orders, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL);
    const done = (fn, v) => { worker.terminate(); fn(v); };
    worker.onmessage = ({ data }) => {
      if (data.progress != null) onProgress(data.progress);
      else if (data.wav) done(resolve, data.wav);
      else done(reject, new Error(data.error));
    };
    worker.onerror = (e) => done(reject, new Error(e.message || 'the renderer stopped'));
    const { bpm, bars, rows_per_bar, seed } = cfg;
    worker.postMessage({ wasmUrl: WASM_URL, cfg: { bpm, bars, rows_per_bar, seed }, seat, orders });
  });
}
