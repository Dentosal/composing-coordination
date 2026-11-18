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
    assert.deepEqual(buildInstrument(inst.id, patch, undefined, inst.piano_roll === true), inst, key);
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

test('the piano roll flag is part of the instrument, not of the sound', () => {
  const p = defaultPatch();
  const on = buildInstrument('t', p, 'x', true);
  const off = buildInstrument('t', p, 'x');
  assert.equal(on.piano_roll, true);
  assert.equal('piano_roll' in off, false);
  assert.deepEqual({ ...on, piano_roll: undefined }, { ...off, piano_roll: undefined }); // same graph either way
  assert.ok(parseInstrument(on), 'a piano-roll instrument is still a template instrument');
});

test('unison: patch round-trips, defaults leave the graph untouched, offsets match the shared fixture', async () => {
  const { unisonOffsets } = await import('./voice.js');
  const p = defaultPatch();
  assert.equal(buildInstrument('x', p).nodes.find((n) => n.id === 'o1').unison, undefined);
  p.osc[0].unison = 5;
  p.osc[0].spread = 18;
  const inst = buildInstrument('x', p);
  assert.equal(inst.nodes.find((n) => n.id === 'o1').unison, 5);
  assert.deepEqual(parseInstrument(inst), p);
  for (const { n, spread, offsets } of JSON.parse(readFileSync(new URL('../../server/tests/fixtures/unison.json', import.meta.url)))) {
    assert.deepEqual(unisonOffsets(n, spread), offsets, `n=${n}`);
  }
});

test('unison wave tables and harmonic counts match the shared fixture', async () => {
  const { unisonCoeffs, unisonHarmonics, unisonPhase } = await import('./voice.js');
  const fx = JSON.parse(readFileSync(new URL('../../server/tests/fixtures/unison_wave.json', import.meta.url)));
  for (const c of fx.coeffs) {
    const got = unisonCoeffs(c.wave, c.harmonics, c.phase);
    for (const key of ['real', 'imag']) got[key].forEach((v, i) => assert.ok(Math.abs(v - c[key][i]) < 1e-6, `${c.wave} ${key}[${i}]`));
  }
  for (const h of fx.harmonics) assert.equal(unisonHarmonics(h.hz), h.harmonics);
  for (const [n, ph] of Object.entries(fx.phases)) ph.forEach((v, i) => assert.equal(unisonPhase(i, Number(n)), v));
});

test('unison start phases: the copies add up like uncorrelated signals on the low harmonics, not like one', async () => {
  const { unisonPhase } = await import('./voice.js');
  for (let n = 2; n <= 7; n++) {
    let worst = 0;
    for (let k = 1; k <= 3; k++) { // power of the sum of the copies' k-th harmonic, relative to n (uncorrelated = 1)
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) { const a = 2 * Math.PI * k * unisonPhase(i, n); re += Math.cos(a); im += Math.sin(a); }
      worst = Math.max(worst, ((re * re + im * im) / n) / 1);
    }
    assert.ok(worst < n * 0.9, `n=${n}: some low harmonic adds up coherently (${worst})`); // equal phases would give n
  }
});

test('FM: off adds nothing to the graph, on adds a pitch-tracked gain from osc 2 to osc 1, and it round-trips', () => {
  const p = defaultPatch();
  assert.equal(buildInstrument('x', p).nodes.some((n) => n.id === 'fm'), false);
  p.fm = { on: true, depth: 2.5 };
  p.osc[1].semitones = 12;
  const inst = buildInstrument('x', p);
  const fm = inst.nodes.find((n) => n.id === 'fm');
  assert.equal(fm.key_track, 1);
  assert.ok(Math.abs(fm.gain - 2.5 * 261.6255653005986 * 2) < 1e-3, `gain at middle C: ${fm.gain}`); // index 2.5 x modulator frequency (2x)
  assert.ok(inst.edges.some((e) => e.from === 'o2' && e.to === 'fm' && !e.port));
  assert.ok(inst.edges.some((e) => e.from === 'fm' && e.to === 'o1' && e.port === 'freq'));
  assert.deepEqual(parseInstrument(inst), p);
  // A fixed-pitch modulator follows no note: its gain is the index times its own frequency, untracked.
  p.osc[1].fixed_hz = 300;
  const fixed = buildInstrument('x', p);
  assert.equal(fixed.nodes.find((n) => n.id === 'fm').gain, 750);
  assert.equal(fixed.nodes.find((n) => n.id === 'fm').key_track, undefined);
  assert.deepEqual(parseInstrument(fixed), p);
  // A rewired FM graph is custom.
  inst.edges = inst.edges.filter((e) => e.from !== 'fm');
  assert.equal(parseInstrument(inst), null);
});

test('an instrument that went through the server (explicit default fields) is still a template instrument', () => {
  const p = defaultPatch();
  p.fm = { on: true, depth: 1.6 };
  p.osc[0].unison = 3;
  const inst = JSON.parse(JSON.stringify(buildInstrument('x', p)));
  for (const n of inst.nodes) {
    if (n.type === 'gain') n.key_track ??= 0; // what the server used to write for every gain node
    if (n.type === 'osc') { n.unison ??= 1; n.spread ??= 0; }
  }
  assert.deepEqual(parseInstrument(inst), p);
});

test('FM gain is a 32-bit float value, as the server stores it, for any depth and pitch', () => {
  for (const depth of [0.05, 1, 1.6, 2.35, 9.95]) {
    for (const semitones of [-12, 0, 7, 19.02, 36]) {
      const p = defaultPatch();
      p.fm = { on: true, depth };
      p.osc[1].semitones = semitones;
      const inst = buildInstrument('x', p);
      const stored = { ...inst, nodes: inst.nodes.map((n) => (n.type === 'gain' ? { ...n, gain: Math.fround(n.gain) } : n)) }; // f32 round trip
      assert.deepEqual(parseInstrument(stored), p, `depth ${depth}, ${semitones} st`);
    }
  }
});
