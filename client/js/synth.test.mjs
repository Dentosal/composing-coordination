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

test('isDefaultPatch: the Init preset and a fresh default are default, edited or other patches are not', async () => {
  const { isDefaultPatch } = await import('./synth.js');
  const fs = await import('node:fs');
  const preset = (n) => JSON.parse(fs.readFileSync(new URL(`../presets/${n}.json`, import.meta.url))).instrument;
  assert.equal(isDefaultPatch(preset('init')), true);
  assert.equal(isDefaultPatch(preset('bass')), false);
  const p = defaultPatch();
  assert.equal(isDefaultPatch(buildInstrument('x', p)), true);
  p.filter.freq += 1;
  assert.equal(isDefaultPatch(buildInstrument('x', p)), false);
  assert.equal(isDefaultPatch({ id: 'c', gain: 1, send_delay: 0, send_reverb: 0, nodes: [], edges: [] }), false);
});

test('patch files: export then import reproduces the patch; shipped presets import too', async () => {
  const { patchToFile, readPatchFile } = await import('./synth.js');
  const p = defaultPatch();
  p.filter.freq = 777;
  p.osc[1].level = 0.4;
  p.lfo.cutoff = 900;
  const inst = { ...buildInstrument('track2', p), name: 'My sound' };
  const { label, patch } = readPatchFile(JSON.stringify(patchToFile(inst)));
  assert.equal(label, 'My sound');
  assert.deepEqual(patch, p);
  for (const key of presets) {
    const file = readFileSync(new URL(`${key}.json`, presetDir), 'utf8');
    assert.ok(readPatchFile(file).patch, key);
  }
});

test('patch files: bad input is rejected with a message', async () => {
  const { patchToFile, readPatchFile, validatePatch } = await import('./synth.js');
  assert.throws(() => readPatchFile('not json'), /valid JSON/);
  assert.throws(() => readPatchFile('{"format":"something-else"}'), /not a patch file/);
  assert.throws(() => readPatchFile('{"label":"x"}'), /No instrument/);
  assert.throws(() => readPatchFile('x'.repeat(200_001)), /too large/);
  const custom = { id: 'c', gain: 1, send_delay: 0, send_reverb: 0, nodes: [{ id: 'out', type: 'out' }], edges: [] };
  assert.throws(() => readPatchFile(JSON.stringify(patchToFile(custom))), /custom signal graph/);
  const p = defaultPatch();
  p.osc[0].wave = 'banana';
  assert.match(validatePatch(p), /banana/);
  const bad = { ...buildInstrument('t', defaultPatch()) };
  bad.nodes = bad.nodes.map((n) => (n.id === 'lp' ? { ...n, freq: 'high' } : n));
  assert.throws(() => readPatchFile(JSON.stringify({ instrument: bad })), /filter/);
});
