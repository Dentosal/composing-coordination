import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearFx, fxLabel, notePlan, setFxField } from './fx.js';

const cases = JSON.parse(readFileSync(new URL('../../server/tests/fixtures/fx_plan.json', import.meta.url)));

test('the effect plan matches the shared fixture (the same one the server is checked against)', () => {
  assert.ok(cases.length >= 12);
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  for (const c of cases) {
    const segs = notePlan(c.fx, c.start_row, c.end_row, c.row_secs);
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
