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
  p.osc[2].route = 0;
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

test('filter 2: its nodes exist only while a source is routed to it; routes and settings round-trip', () => {
  const p = defaultPatch();
  const plain = buildInstrument('x', p);
  assert.equal(plain.nodes.some((n) => n.id === 'lp2' || n.id === 'fenv2'), false);

  p.osc[1].level = 0.4;
  p.osc[1].route = 2;
  p.noise.level = 0.2;
  p.noise.route = 0;
  p.filter2 = { mode: 'highpass', freq: 900, q: 2.5, key_track: 0.25 };
  p.fenv2 = { attack: 0.02, decay: 0.3, sustain: 0.1, release: 0.2, amount: -1500 };
  const inst = buildInstrument('x', p);
  assert.equal(inst.nodes.find((n) => n.id === 'lp2').mode, 'highpass');
  const has = (from, to, port) => inst.edges.some((e) => e.from === from && e.to === to && e.port === port);
  assert.ok(has('l2', 'lp2'));
  assert.ok(has('l1', 'lp'));
  assert.ok(has('ln', 'bus'));
  assert.ok(has('lp2', 'bus'));
  assert.ok(has('fenv2', 'lp2', 'freq'));
  assert.ok(has('lfo_c', 'lp2', 'freq')); // the LFO's cutoff depth moves both filters
  assert.deepEqual(parseInstrument(inst), p);

  // Routing everything away from filter 2 keeps its (changed) settings in the graph, so a reload does not lose them...
  p.osc[1].route = 1;
  const unused = buildInstrument('x', p);
  assert.ok(unused.nodes.some((n) => n.id === 'lp2'));
  assert.deepEqual(parseInstrument(unused), p);
  // ...but while they are still the defaults the graph is as it was before filter 2 existed.
  const fresh = defaultPatch();
  fresh.osc[1].route = 2;
  fresh.osc[1].route = 1;
  assert.deepEqual(buildInstrument('x', fresh).nodes.map((n) => n.id).sort(), plain.nodes.map((n) => n.id).sort());

  // An edge into a filter 2 that is not there is a custom graph.
  const broken = buildInstrument('x', { ...defaultPatch() });
  broken.edges.find((e) => e.from === 'l2').to = 'lp2';
  assert.equal(parseInstrument(broken), null);
});

test('validatePatch rejects an unknown route', async () => {
  const { validatePatch } = await import('./synth.js');
  const p = defaultPatch();
  assert.equal(validatePatch(p), null);
  p.osc[0].route = 3;
  assert.match(validatePatch(p), /filter/);
});

test('filter routing: parallel by default; serial feeds filter 1 into filter 2 and round-trips', () => {
  const p = defaultPatch();
  assert.equal(p.filterMode, 'parallel');
  const edgeIn = (inst, from, to, port) => inst.edges.some((e) => e.from === from && e.to === to && e.port === port);

  // Serial with the default routing (everything through filter 1): filter 2 appears after it.
  p.filterMode = 'serial';
  const inst = buildInstrument('x', p);
  assert.ok(edgeIn(inst, 'lp', 'lp2'));
  assert.ok(edgeIn(inst, 'lp2', 'bus'));
  assert.equal(edgeIn(inst, 'lp', 'bus'), false);
  assert.deepEqual(parseInstrument(inst), p);

  // A source entering at filter 2 and one that skips both still work.
  p.osc[1].level = 0.3; p.osc[1].route = 2;
  p.noise.level = 0.2; p.noise.route = 0;
  const mixed = buildInstrument('x', p);
  assert.ok(edgeIn(mixed, 'l2', 'lp2'));
  assert.ok(edgeIn(mixed, 'ln', 'bus'));
  assert.deepEqual(parseInstrument(mixed), p);

  // The serial mode is kept even when nothing is routed through the filters.
  const q = defaultPatch();
  q.filterMode = 'serial';
  for (const src of [...q.osc, q.noise]) src.route = 0;
  assert.deepEqual(parseInstrument(buildInstrument('x', q)), q);

  // Switching back to parallel gives the old graph.
  p.filterMode = 'parallel';
  assert.equal(edgeIn(buildInstrument('x', p), 'lp', 'bus'), true);
});

test('FM depth is kept while FM is off, but only once it differs from the default', () => {
  const off = defaultPatch();
  assert.equal(buildInstrument('x', off).nodes.some((n) => n.id === 'fm'), false);
  off.fm = { on: false, depth: 3.5 };
  off.osc[1].semitones = 7;
  const inst = buildInstrument('x', off);
  assert.ok(inst.nodes.some((n) => n.id === 'fm'));
  assert.equal(inst.edges.some((e) => e.from === 'fm' || e.to === 'fm'), false); // not wired in: it does nothing
  assert.deepEqual(parseInstrument(inst), off);
  off.fm.on = true;
  assert.deepEqual(parseInstrument(buildInstrument('x', off)), off);
});
