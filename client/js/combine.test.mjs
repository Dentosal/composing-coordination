import test from 'node:test';
import assert from 'node:assert/strict';
import { combineRounds, partSounds } from './combine.js';

const inst = (id, level, name) => ({ id, ...(name ? { name } : {}), gain: 0.8, send_delay: 0, send_reverb: 0,
  nodes: [{ id: 'o', type: 'osc', wave: 'sine' }, { id: 'g', type: 'gain', gain: level }, { id: 'out', type: 'out' }],
  edges: [{ from: 'o', to: 'g' }, { from: 'g', to: 'out' }] });
const lane = (id, steps, fx) => ({ instrument: id, steps, ...(fx ? { fx } : {}) });
const cfg = { bars: 1, rows_per_bar: 16 };

test('a sound is the instrument without its name; silent tracks do not count; two tracks of one sound count twice', () => {
  const s = partSounds({
    instruments: [inst('a', 0.5, 'Bass'), inst('b', 0.5), inst('c', 0.7), inst('d', 0.9)],
    lanes: [lane('a', [{ row: 0, note: 40 }]), lane('b', [{ row: 2, note: 40 }]), lane('c', [{ row: 0, note: 50 }]), lane('d', [{ row: 0, note: null }])],
  });
  assert.equal(s.length, 3);
  assert.notEqual(s[0].key, s[1].key, 'a second track of the same sound is another track');
  assert.equal(s[0].key.slice(2), s[1].key.slice(2), 'but the same sound');
});

test('rounds are laid end to end; a kept sound keeps its track; notes stop at the end of their round', () => {
  const song = {
    players: [{ seat: 0, name: 'Ada' }, { seat: 1, name: 'Bob' }],
    rounds: [
      { n: 1, parts: [
        { seat: 0, orders: { instruments: [inst('a', 0.5, 'Bass')], lanes: [lane('a', [{ row: 4, note: 40, vel: 90 }], [{ row: 5, volume: 0.5 }])] } },
        { seat: 1, orders: { instruments: [inst('x', 0.3)], lanes: [lane('x', [{ row: 0, note: 60, vel: 100 }])] } },
      ] },
      { n: 2, parts: [
        // Ada keeps her sound under another id, and adds a new one; Bob plays nothing.
        { seat: 0, orders: { instruments: [inst('z', 0.5), inst('n', 0.6)], lanes: [lane('z', [{ row: 0, note: 43, vel: 100 }]), lane('n', [{ row: 8, note: 55, vel: 100 }])] } },
        { seat: 1, orders: { instruments: [inst('x', 0.3)], lanes: [lane('x', [])] } },
      ] },
    ],
  };
  const { bars, parts, merged } = combineRounds(song, cfg);
  assert.equal(bars, 2);
  assert.deepEqual(parts.map((p) => p.seat), [0, 1]);
  const ada = parts[0].orders;
  assert.deepEqual(ada.instruments.map((i) => [i.id, i.name]), [['p0t1', 'Ada: Bass'], ['p0t2', 'Ada: n']]);
  assert.deepEqual(ada.lanes[0].steps, [{ row: 4, note: 40, vel: 90 }, { row: 16, note: 43, vel: 100 }], 'round 2 starts on the next note: no stop needed');
  assert.deepEqual(ada.lanes[0].fx, [{ row: 5, volume: 0.5 }]);
  assert.deepEqual(ada.lanes[1].steps, [{ row: 24, note: 55, vel: 100 }], 'the last round needs no stop');
  const bob = parts[1].orders;
  assert.deepEqual(bob.lanes[0].steps, [{ row: 0, note: 60, vel: 100 }, { row: 16, note: null, vel: 100 }], 'his note stops when round 1 ends');
  assert.equal(merged.lanes.length, 3);
  assert.equal(new Set(merged.instruments.map((i) => i.id)).size, 3, 'ids stay apart');
});
