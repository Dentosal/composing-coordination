import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearFx, fxLabel, fxTitle, notePlan, paramTarget, setFxField } from './fx.js';

const cases = JSON.parse(readFileSync(new URL('../../server/tests/fixtures/fx_plan.json', import.meta.url)));

test('the effect plan matches the shared fixture (the same one the server is checked against)', () => {
  assert.ok(cases.length >= 24);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  for (const c of cases) {
    const targets = c.targets ?? {};
    const segs = notePlan(c.fx, c.start_row, c.end_row, c.row_secs, (node, port) => targets[`${node}.${port}`] ?? null);
    assert.equal(segs.length, c.expected.length, `${c.name}: segments`);
    segs.forEach((seg, j) => {
      const want = c.expected[j];
      assert.ok(near(seg.start, want.start) && near(seg.end, want.end), `${c.name}: segment ${j} times`);
      for (const key of ['volumes', 'pitches']) {
        assert.equal(seg[key].length, want[key].length, `${c.name}: segment ${j} ${key}`);
        seg[key].forEach(([t, v], i) => {
          assert.ok(near(t, want[key][i][0]), `${c.name}: ${key}[${i}] time`);
          assert.ok(near(v, want[key][i][1]), `${c.name}: ${key}[${i}] value`);
        });
      }
      const wantParams = want.params ?? [];
      assert.equal(seg.params.length, wantParams.length, `${c.name}: segment ${j} automated parameters`);
      seg.params.forEach((p, k) => {
        const w = wantParams[k];
        const label = `${c.name}: segment ${j} ${w.node}.${w.port}`;
        assert.ok(p.node === w.node && p.port === w.port && p.exp === w.exp, `${label}: which parameter`);
        assert.ok(near(p.initial, w.initial), `${label}: initial ${p.initial} vs ${w.initial}`);
        assert.equal(p.events.length, w.events.length, `${label}: events ${JSON.stringify(p.events)} vs ${JSON.stringify(w.events)}`);
        p.events.forEach(([t, v, ramp], i) => {
          assert.ok(near(t, w.events[i][0]) && near(v, w.events[i][1]) && ramp === w.events[i][2], `${label}: event ${i} ${JSON.stringify([t, v, ramp])} vs ${JSON.stringify(w.events[i])}`);
        });
      });
    });
  }
});

test('setting and removing effect fields keeps the cells tidy and sorted', () => {
  const lane = { instrument: 'a', steps: [] };
  setFxField(lane, 5, 'volume', 0.5);
  setFxField(lane, 2, 'arp', { offsets: [0, 7] });
  setFxField(lane, 5, 'arp', { offsets: [0, 4] });
  assert.deepEqual(lane.fx.map((f) => f.row), [2, 5]);
  assert.equal(fxLabel(lane.fx[1]), 'VA');
  setFxField(lane, 5, 'slide', -2);
  setFxField(lane, 5, 'cut', 0); // 0 is a real value (a cut on the first tick)
  setFxField(lane, 5, 'retrig', 2);
  assert.equal(fxLabel(lane.fx[1]), 'VASCR');
  setFxField(lane, 5, 'slide', null);
  setFxField(lane, 5, 'cut', null);
  setFxField(lane, 5, 'retrig', null);
  setFxField(lane, 5, 'volume', null);
  assert.equal(fxLabel(lane.fx[1]), 'A');
  assert.equal(fxLabel({ row: 0, volume: 0.2 }), 'V');
  setFxField(lane, 5, 'arp', null); // the cell is empty now: it goes away
  assert.deepEqual(lane.fx.map((f) => f.row), [2]);
  clearFx(lane, [2, 3]);
  assert.equal('fx' in lane, false, 'no effects: the property is dropped');
  setFxField(lane, 1, 'volume', null); // removing from nothing is a no-op
  assert.equal('fx' in lane, false);
});

test('parameter targets match the shared fixture (the same one the server is checked against)', () => {
  const fx = JSON.parse(readFileSync(new URL('../../server/tests/fixtures/param_target.json', import.meta.url)));
  const near = (a, b) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b));
  for (const c of fx.cases) {
    const got = paramTarget(fx.instrument, c.hz, c.node, c.port);
    const label = `${c.node}.${c.port} at ${c.hz} Hz`;
    if (c.expected === null) { assert.equal(got, null, label); continue; }
    assert.ok(got, label);
    for (const k of ['base', 'factor', 'lo', 'hi']) assert.ok(near(got[k], c.expected[k]), `${label}: ${k} ${got[k]} vs ${c.expected[k]}`);
    assert.equal(got.exp, c.expected.exp, `${label}: exp`);
  }
});

test('parameter entries in effect cells: set, label, describe and remove', () => {
  const lane = { instrument: 'a', steps: [] };
  const cut = { node: 'lp', port: 'freq', value: 1200 };
  setFxField(lane, 3, 'params', [cut, { node: 'lp', port: 'q', value: 4, glide: true }]);
  assert.equal(fxLabel(lane.fx[0]), 'P');
  setFxField(lane, 3, 'volume', 0.5);
  assert.equal(fxLabel(lane.fx[0]), 'VP');
  assert.equal(fxTitle(lane.fx[0], (e) => `${e.port}=${e.value}`), 'volume 50%, freq=1200, q=4 (glide)');
  setFxField(lane, 3, 'params', []); // no entries is no field
  assert.equal('params' in lane.fx[0], false);
  setFxField(lane, 3, 'volume', null); // ...and the cell is empty now
  assert.equal('fx' in lane, false);
  const stored = [cut];
  setFxField(lane, 1, 'params', stored);
  stored[0].value = 5; // the lane keeps its own copy
  assert.equal(lane.fx[0].params[0].value, 1200);
});
