// Run: node --test client/js/synth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildInstrument, defaultPatch, parseInstrument } from './synth.js';

const presetDir = new URL('../presets/', import.meta.url);
const presets = JSON.parse(readFileSync(new URL('index.json', presetDir)));

test('every shipped preset parses as a template instrument and rebuilds identically', () => {
  assert.ok(readdirSync(presetDir).filter((f) => f !== 'index.json').length === presets.length);
  for (const key of presets) {
    const inst = JSON.parse(readFileSync(new URL(`${key}.json`, presetDir))).instrument;
    const patch = parseInstrument(inst);
    assert.ok(patch, `${key} should be editable`);
    assert.deepEqual(buildInstrument(inst.id, patch), inst, key);
  }
});

test('patch survives build/parse, including drive and fixed pitch', () => {
  const p = defaultPatch();
  p.drive = 6;
  p.osc[1].fixed_hz = 220;
  p.osc[2].filtered = false;
  p.lfo.cutoff = 1500;
  assert.deepEqual(parseInstrument(buildInstrument('x', p)), p);
  assert.equal(buildInstrument('x', { ...p, drive: 0 }).nodes.some((n) => n.type === 'shaper'), false);
});

test('hand-edited graphs are reported as custom', () => {
  const inst = buildInstrument('x', defaultPatch());
  inst.nodes.push({ id: 'extra', type: 'gain', gain: 1 });
  assert.equal(parseInstrument(inst), null);
  const rewired = buildInstrument('x', defaultPatch());
  rewired.edges.pop();
  assert.equal(parseInstrument(rewired), null);
  assert.equal(parseInstrument({ id: 'x', gain: 1, send_delay: 0, send_reverb: 0, nodes: [], edges: [] }), null);
});
