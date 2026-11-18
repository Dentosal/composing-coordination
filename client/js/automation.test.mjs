// Run: node --test client/js/automation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIDDLE_C_HZ, buildInstrument, defaultPatch } from './synth.js';
import { accepts, automatable, describeParam, fromPosition, fromShown, ownValue, paramOf, pruneParams, toPosition, toShown, usableParams } from './automation.js';

const ids = (inst) => automatable(inst).map((p) => p.id);

test('the offered parameters follow what the instrument has', () => {
  const p = defaultPatch();
  const base = ids(buildInstrument('x', p));
  assert.deepEqual(base, ['filter1.cutoff', 'filter1.resonance', 'osc1.level', 'osc2.level', 'osc3.level', 'noise.level', 'lfo.rate', 'lfo.pitch', 'lfo.cutoff', 'lfo.amp']);
  p.osc[0].route = 2; // filter 2 is in use: its parameters appear
  assert.ok(ids(buildInstrument('x', p)).includes('filter2.cutoff') && ids(buildInstrument('x', p)).includes('filter2.resonance'));
  const q = defaultPatch();
  q.fm = { on: true, depth: 2 };
  assert.ok(ids(buildInstrument('x', q)).includes('fm.depth'));
  assert.deepEqual(automatable(null), []);
});

test('accepts follows the server: gain, filter freq and q, a fixed-pitch oscillator frequency, nothing else', () => {
  const inst = buildInstrument('x', defaultPatch());
  const ok = (node, port) => accepts(inst, { node, port });
  assert.ok(ok('lp', 'freq') && ok('lp', 'q') && ok('l1', 'gain') && ok('lfo_p', 'gain') && ok('lfo', 'freq'));
  assert.equal(ok('lp', 'detune'), false);
  assert.equal(ok('o1', 'freq'), false, 'the pitch of an ordinary oscillator belongs to slide and arpeggio');
  assert.equal(ok('o1', 'detune'), false);
  assert.equal(ok('out', 'gain'), false);
  assert.equal(ok('nope', 'gain'), false);
});

test('FM depth is shown as the index and stored as a gain in Hz at middle C', () => {
  const p = defaultPatch();
  p.fm = { on: true, depth: 3 };
  p.osc[1].semitones = 12; // the modulator is an octave above: its frequency at middle C is twice middle C
  const inst = buildInstrument('x', p);
  const fm = paramOf(inst, { node: 'fm', port: 'gain' });
  const stored = fromShown(inst, fm, 3);
  assert.ok(Math.abs(stored - 3 * 2 * MIDDLE_C_HZ) < 1e-6);
  assert.ok(Math.abs(toShown(inst, fm, stored) - 3) < 1e-12);
  assert.ok(Math.abs(ownValue(inst, fm) - 3) < 1e-4, 'a new entry starts at the instrument\'s own depth');
  assert.equal(describeParam(inst, { node: 'fm', port: 'gain', value: stored }), 'FM depth 3');
});

test('sliders: logarithmic for frequencies, snapped linear for the rest, and values read back', () => {
  const inst = buildInstrument('x', defaultPatch());
  const cutoff = paramOf(inst, { node: 'lp', port: 'freq' });
  assert.equal(toPosition(cutoff, 20), 0);
  assert.equal(toPosition(cutoff, 20000), 1000);
  assert.ok(Math.abs(toPosition(cutoff, 632) - 500) <= 1, 'the middle of the slider is the geometric middle');
  for (const hz of [25, 130, 1000, 8000]) assert.ok(Math.abs(fromPosition(cutoff, toPosition(cutoff, hz)) / hz - 1) < 0.02, `${hz} Hz survives the slider`);
  const level = paramOf(inst, { node: 'l1', port: 'gain' });
  assert.equal(fromPosition(level, 500), 0.5);
  assert.equal(fromPosition(level, 333), 0.33); // snapped to the step
  assert.equal(describeParam(inst, { node: 'lp', port: 'freq', value: 1234 }), 'Filter 1 cutoff 1230 Hz');
  assert.equal(describeParam(inst, { node: 'zz', port: 'freq', value: 5 }), 'zz.freq 5', 'an entry the editor has no name for');
  assert.equal(ownValue(inst, cutoff), 2000);
});

test('pruneParams drops entries the instrument cannot take and cells that end up empty', () => {
  const plain = buildInstrument('a', defaultPatch()); // no filter 2
  const entry = (node, port, value = 1) => ({ node, port, value });
  const orders = {
    instruments: [plain],
    lanes: [{ instrument: 'a', steps: [], fx: [
      { row: 1, params: [entry('lp', 'freq'), entry('lp2', 'freq')] }, // one stays
      { row: 2, params: [entry('lp2', 'q')] },                          // the cell is empty then: it goes
      { row: 3, volume: 0.5, params: [entry('lp2', 'q')] },             // the volume stays
      { row: 4, params: [entry('o1', 'freq')] },                        // an ordinary oscillator's pitch is not automatable
    ] }],
  };
  assert.equal(pruneParams(orders), true);
  assert.deepEqual(orders.lanes[0].fx, [{ row: 1, params: [entry('lp', 'freq')] }, { row: 3, volume: 0.5 }]);
  assert.equal(pruneParams(orders), false, 'nothing more to drop');
  orders.lanes[0].fx = [{ row: 5, params: [entry('lp2', 'freq')] }];
  assert.equal(pruneParams(orders), true);
  assert.equal('fx' in orders.lanes[0], false, 'no cells left: the property goes');
  assert.deepEqual(usableParams(plain, [entry('lp', 'q'), entry('lp2', 'q')]), [entry('lp', 'q')]);
});
