// Run: node --test client/js/prng.test.mjs
// The same vectors are pinned in server/src/prng.rs (matches_the_js_port).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Mulberry32, seedFromKey } from './prng.js';

test('seedFromKey is FNV-1a', () => {
  assert.equal(seedFromKey(''), 0x811c9dc5);
  assert.equal(seedFromKey('a'), 0xe40c292c);
  assert.equal(seedFromKey('12345:0:bass:n'), 3960942391);
});

test('Mulberry32 matches the Rust implementation', () => {
  const r = new Mulberry32(1);
  assert.deepEqual([r.nextU32(), r.nextU32(), r.nextU32()], [2693262067, 11749833, 2265367787]);
  const k = Mulberry32.fromKey('12345:reverb:0');
  assert.deepEqual([k.nextU32(), k.nextU32()], [951796836, 3933183282]);
});

test('noise keys built from a seed bigger than 2^53 match the server (the seed is text, not a rounded number)', () => {
  const cases = JSON.parse(readFileSync(new URL('../../server/tests/fixtures/prng_big_seed.json', import.meta.url)));
  for (const c of cases) {
    const rng = Mulberry32.fromKey(c.key);
    for (const want of c.values) assert.ok(Math.abs(rng.nextBipolar() - want) < 1e-12, c.key);
  }
  // and the number form would not have matched: that is the bug the text form avoids
  assert.notEqual(`${Number('9341554369522371407')}`, '9341554369522371407');
});
