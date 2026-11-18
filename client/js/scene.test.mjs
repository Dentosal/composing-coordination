import test from 'node:test';
import assert from 'node:assert/strict';
import { readSceneFile, sceneFile } from './scene.js';

const orders = { instruments: [{ id: 'a' }], lanes: [{ instrument: 'a', steps: [], fx: [{ row: 1, volume: 0.5 }] }] };
const cfg = { bpm: 100, bars: 3, rows_per_bar: 8, seed: 42 };

test('a scene survives writing and reading', () => {
  const s = readSceneFile(JSON.stringify(sceneFile(cfg, orders)));
  assert.deepEqual(s.config, { bpm: 100, bars: 3, rows_per_bar: 8, seed: 42 });
  assert.deepEqual(s.orders, orders);
});

test('a seed too big for a number is dropped, not rounded', () => {
  const s = readSceneFile(JSON.stringify(sceneFile({ ...cfg, seed: 18446744073709551615n.toString() }, orders)));
  assert.equal(s.config.seed, null);
});

test('files that are not scenes are refused with a reason', () => {
  const bad = (text, re) => assert.throws(() => readSceneFile(text), re);
  bad('nope', /not valid JSON/);
  bad('{"format":"band-game-patch"}', /not a scene file/);
  const f = sceneFile(cfg, orders);
  bad(JSON.stringify({ ...f, config: { ...f.config, bars: 65 } }), /1 to 64 bars/);
  bad(JSON.stringify({ ...f, config: { ...f.config, bpm: 10 } }), /tempo/);
  bad(JSON.stringify({ ...f, config: { ...f.config, rows_per_bar: 6 } }), /multiple of 4/);
  bad(JSON.stringify({ ...f, orders: { instruments: [], lanes: [] } }), /no tracks/);
  bad(JSON.stringify({ ...f, orders: {} }), /no tracks/);
});
