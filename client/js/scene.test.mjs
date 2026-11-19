import test from 'node:test';
import assert from 'node:assert/strict';
import { readSceneFile, sceneFile } from './scene.js';

const orders = { instruments: [{ id: 'a' }], lanes: [{ instrument: 'a', steps: [], fx: [{ row: 1, volume: 0.5 }] }] };
const cfg = { bpm: 100, bars: 3, rows_per_bar: 16, seed: 42 };

test('a scene survives writing and reading', () => {
  const s = readSceneFile(JSON.stringify(sceneFile(cfg, orders)));
  assert.deepEqual(s.config, { bpm: 100, bars: 3, rows_per_bar: 16, seed: '42' });
  assert.deepEqual(s.orders, orders);
});

test('a seed bigger than a JSON number holds exactly is kept as text, digit for digit', () => {
  const big = '9341554369522371407';
  const s = readSceneFile(JSON.stringify(sceneFile({ ...cfg, seed: big }, orders)));
  assert.equal(s.config.seed, big);
  assert.equal(readSceneFile(JSON.stringify(sceneFile({ ...cfg, seed: '18446744073709551615' }, orders))).config.seed, '18446744073709551615');
});

test('a missing or invalid seed becomes null (the new session picks its own)', () => {
  const f = sceneFile(cfg, orders);
  for (const seed of [undefined, '', 'abc', '-3', '18446744073709551616', '12345678901234567890123']) {
    assert.equal(readSceneFile(JSON.stringify({ ...f, config: { ...f.config, seed } })).config.seed, null, String(seed));
  }
  assert.equal(readSceneFile(JSON.stringify({ ...f, config: { ...f.config, seed: 7 } })).config.seed, '7', 'an older file with a plain number');
});

test('files that are not scenes are refused with a reason', () => {
  const bad = (text, re) => assert.throws(() => readSceneFile(text), re);
  bad('nope', /not valid JSON/);
  bad('{"format":"band-game-patch"}', /not a scene file/);
  const f = sceneFile(cfg, orders);
  bad(JSON.stringify({ ...f, config: { ...f.config, bars: 257 } }), /1 to 256 bars/);
  bad(JSON.stringify({ ...f, config: { ...f.config, bpm: 10 } }), /tempo/);
  bad(JSON.stringify({ ...f, config: { ...f.config, rows_per_bar: 8 } }), /8 rows per bar; only 16/);
  bad(JSON.stringify({ ...f, orders: { instruments: [], lanes: [] } }), /no tracks/);
  bad(JSON.stringify({ ...f, orders: {} }), /no tracks/);
});

test('the file says which code wrote it', () => {
  const build = { server: { label: '8b7ca71f3a2c' }, client: { label: '8b7ca71f3a2c+1a2b3c4d' } };
  assert.deepEqual(sceneFile(cfg, orders, build).build, { server: '8b7ca71f3a2c', client: '8b7ca71f3a2c+1a2b3c4d' });
  assert.deepEqual(sceneFile(cfg, orders, null).build, { server: 'unknown', client: 'unknown' });
  // and a file with a build stamp (or without, from before) reads the same
  assert.equal(readSceneFile(JSON.stringify(sceneFile(cfg, orders, build))).config.bars, 3);
});
