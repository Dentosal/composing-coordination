import test from 'node:test';
import assert from 'node:assert/strict';
import { envelopePath } from './adsr.js';

const points = (env) => envelopePath(env).line.match(/-?\d+(\.\d+)?/g).map(Number);
const base = { attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.1 };

test('changing release leaves the attack, decay and hold positions untouched', () => {
  const ref = points(base).slice(0, 8); // up to the end of the hold
  for (const release of [0.001, 1, 5]) assert.deepEqual(points({ ...base, release }).slice(0, 8), ref);
});

test('changing decay or attack does not move the hold or release slot', () => {
  const ref = points(base);
  const holdEnd = (env) => points(env)[6];
  assert.equal(holdEnd({ ...base, decay: 4 }), ref[6]);
  assert.equal(holdEnd({ ...base, attack: 3 }), ref[6]);
});

test('the longest release still fits in the preview', () => {
  const pts = points({ ...base, release: 5 });
  assert.ok(pts[pts.length - 2] <= 120);
});
