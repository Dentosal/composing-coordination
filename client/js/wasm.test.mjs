// The browser's renderer (client/wasm/renderer.wasm) is the server's renderer compiled to WebAssembly: it must be
// rebuilt (tools/build-wasm.sh) whenever renderer/ changes, and it must render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wasmSourceHash } from '../../tools/wasm-source-hash.mjs';

const file = (p) => new URL(`../${p}`, import.meta.url);

test('the WebAssembly renderer is built from the current renderer sources (else run tools/build-wasm.sh)', () => {
  assert.equal(readFileSync(file('wasm/renderer.hash'), 'utf8').trim(), wasmSourceHash());
});

test('the WebAssembly renderer renders a song file, reporting progress', async () => {
  let exports = null;
  let message = '';
  const progress = [];
  const { instance } = await WebAssembly.instantiate(readFileSync(file('wasm/renderer.wasm')), {
    env: {
      progress: (f) => progress.push(f),
      emit: () => {}, cmd_len: () => 0, cmd_read: () => {},
      report_error: (p, n) => { message = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, p, n)); },
    },
  });
  exports = instance.exports;
  const pad = JSON.parse(readFileSync(file('presets/pad.json'), 'utf8')).instrument;
  const orders = { instruments: [pad], lanes: [{ instrument: pad.id, steps: [{ row: 0, note: 60, vel: 100 }], fx: [] }] };
  const json = new TextEncoder().encode(JSON.stringify(orders));
  const ptr = exports.alloc(json.length);
  new Uint8Array(exports.memory.buffer, ptr, json.length).set(json);
  const out = exports.render_song(ptr, json.length, 120, 2, 16, 1n, 0); // 2 bars at 120 bpm: 4 s, then the tail
  assert.ok(out, message);
  const view = new DataView(exports.memory.buffer);
  const len = view.getUint32(out, true);
  const wav = new DataView(exports.memory.buffer.slice(out + 4, out + 4 + len));
  assert.equal(String.fromCharCode(...new Uint8Array(wav.buffer, 0, 4)), 'RIFF');
  assert.equal(wav.getUint32(24, true), 48000);
  const secs = (len - 44) / 4 / 48000;
  assert.ok(secs > 4.5 && secs <= 8, `4 s of song plus a ringing tail: ${secs} s`);
  let peak = 0;
  for (let i = 44; i < len; i += 2) peak = Math.max(peak, Math.abs(wav.getInt16(i, true)));
  assert.ok(peak > 1000, `audible: peak ${peak}`);
  assert.ok(progress.length > 0 && progress.every((f, i) => f > 0 && f < 1 && (i === 0 || f > progress[i - 1])), `progress ${progress}`);
});

test('a song the renderer cannot read is reported, not a crash', async () => {
  let exports = null;
  let message = '';
  const { instance } = await WebAssembly.instantiate(readFileSync(file('wasm/renderer.wasm')), {
    env: { progress: () => {}, emit: () => {}, cmd_len: () => 0, cmd_read: () => {}, report_error: (p, n) => { message = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, p, n)); } },
  });
  exports = instance.exports;
  const json = new TextEncoder().encode('{"lanes": 5}');
  const ptr = exports.alloc(json.length);
  new Uint8Array(exports.memory.buffer, ptr, json.length).set(json);
  assert.equal(exports.render_song(ptr, json.length, 120, 1, 16, 1n, 0), 0);
  assert.match(message, /could not be read/);
});

test('live playback renders the parts until told to stop, and takes edits while it runs', async () => {
  let exports = null;
  let message = '';
  const pad = JSON.parse(readFileSync(file('presets/pad.json'), 'utf8')).instrument;
  const steps = Array.from({ length: 16 }, (_, i) => ({ row: i * 4, note: 60, vel: 100 })); // a note every beat
  const song = { instruments: [pad], lanes: [{ instrument: pad.id, steps, fx: [] }] };
  const commands = [{ parts: [{ seat: 0, orders: { instruments: [], lanes: [] } }] }]; // start silent
  let pending = null;
  let frames = 0;
  const level = []; // peak per 4800 frames (0.1 s)
  const { instance } = await WebAssembly.instantiate(readFileSync(file('wasm/renderer.wasm')), {
    env: {
      progress: () => {},
      report_error: (p, n) => { message = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, p, n)); },
      emit: (lp, _rp, n) => {
        const l = new Float32Array(exports.memory.buffer, lp, n);
        for (const v of l) {
          const i = Math.floor(frames++ / 4800);
          level[i] = Math.max(level[i] ?? 0, Math.abs(v));
        }
        if (frames === 128 * 75) commands.push({ parts: [{ seat: 0, orders: song }] }); // an edit at 0.2 s
        if (frames >= 48000) commands.push({ stop: true }); // stop after 1 s
      },
      cmd_len: () => {
        if (!commands.length) return 0;
        pending = new TextEncoder().encode(JSON.stringify(commands.shift()));
        return pending.length;
      },
      cmd_read: (ptr) => new Uint8Array(exports.memory.buffer, ptr, pending.length).set(pending),
    },
  });
  exports = instance.exports;
  const ok = exports.live_run(120, 4, 16, 1n, 0, 0, 64);
  assert.equal(ok, 1, message);
  assert.ok(frames >= 48000 && frames < 48000 + 8 * 128, `stopped soon after being asked: ${frames} frames`);
  assert.equal(level[0], 0, 'silent before the edit');
  assert.ok(Math.max(...level.slice(3)) > 0.01, `the edit is heard: ${level.map((v) => v.toFixed(3))}`);
});
