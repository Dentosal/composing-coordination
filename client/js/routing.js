// Read-only SVG signal-flow diagram for a synth template patch (see synth.js). Redrawn from the patch on
// every edit, so it always shows what is currently routed where. Solid grey = audio, dashed orange =
// modulation; anything switched off (level 0, amount 0, drive 0) is dimmed.

import { usesFilter2 } from './synth.js';

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v != null && v !== false) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

const num = (v) => String(Number(Number(v).toPrecision(3)));
const signed = (v) => `${v > 0 ? '+' : ''}${num(v)}`;

/** A labelled box. `on` false dims it. Returns the group; geometry is passed back via the caller. */
function box(x, y, w, h, title, sub, { on = true, cls = '', node = null } = {}) {
  return s('g', { class: `rd-box ${cls} ${on ? '' : 'off'}`, 'data-node': node },
    s('rect', { x, y, width: w, height: h, rx: 6 }),
    s('text', { x: x + 10, y: y + (sub ? 16 : h / 2 + 4), class: 'rd-title' }, title),
    sub ? s('text', { x: x + 10, y: y + 30, class: 'rd-sub' }, sub) : null);
}

/** Cubic wire between two points; `vertical` bends along y instead of x. Returns the path and its midpoint. */
function wire(x1, y1, x2, y2, { mod = false, on = true, vertical = false } = {}) {
  const d = vertical
    ? `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`
    : `M${x1},${y1} C${x1 + (x2 - x1) / 2},${y1} ${x1 + (x2 - x1) / 2},${y2} ${x2},${y2}`;
  return {
    el: s('path', { d, class: `rd-wire ${mod ? 'mod' : 'audio'} ${on ? '' : 'off'}`, 'marker-end': `url(#rd-arrow-${mod ? 'mod' : 'audio'})` }),
    mid: [(x1 + x2) / 2, (y1 + y2) / 2],
  };
}

const label = (x, y, text) => s('text', { x, y, class: 'rd-label', 'text-anchor': 'middle' }, text);

/** @param {import('./synth.js').defaultPatch extends () => infer P ? P : never} p */
export function routingDiagram(p) {
  const layers = { wires: [], boxes: [], labels: [] };
  const wireTo = (...a) => {
    const w = wire(...a);
    layers.wires.push(w.el);
    return w.mid;
  };

  // ---- sources (left column): noise on top, then the three oscillators in a group
  const SRC_X = 22;
  const SRC_W = 150;
  const src = []; // {cy, route, on}
  layers.boxes.push(box(SRC_X, 14, SRC_W, 38, 'Noise', `${p.noise.color} · level ${num(p.noise.level)}`, { on: p.noise.level > 0, node: 'noise' }));
  src.push({ cy: 33, route: p.noise.route, on: p.noise.level > 0 });
  layers.boxes.push(s('rect', { x: 12, y: 64, width: SRC_W + 20, height: 142, rx: 8, class: 'rd-group' }));
  p.osc.forEach((o, i) => {
    const y = 74 + i * 44;
    const pitch = o.fixed_hz != null ? `${num(o.fixed_hz)} Hz` : `${signed(o.semitones)} st`;
    layers.boxes.push(box(SRC_X, y, SRC_W, 38, `Osc ${i + 1}`, `${o.wave} · ${pitch} · level ${num(o.level)}`, { on: o.level > 0, node: `osc${i + 1}` }));
    src.push({ cy: y + 19, route: o.route, on: o.level > 0 });
  });

  // FM: a dashed loop from osc 2 up to osc 1 (frequency modulation), only while it is switched on
  if (p.fm.on) {
    const x = SRC_X + SRC_W;
    layers.wires.push(s('path', { d: `M${x},${src[2].cy} C${x + 34},${src[2].cy} ${x + 34},${src[1].cy} ${x},${src[1].cy}`, class: 'rd-wire mod', 'marker-end': 'url(#rd-arrow-mod)' }));
    layers.labels.push(label(x + 40, (src[1].cy + src[2].cy) / 2 + 4, `FM ${num(p.fm.depth)}`));
  }

  // ---- filter / bypass sinks. Filter 2 sits under filter 1, shifted right, so filter 1's bottom edge stays reachable from below.
  const SINK_X = 290;
  const SINK_W = 150;
  const F2_X = 330;
  const BYPASS_CY = 40;
  const F1_CY = 95;
  const F2_CY = 173;
  const f2On = usesFilter2(p);
  const serial = p.filterMode === 'serial' && f2On;
  const filterSub = (f) => `${f.mode} · ${num(f.freq)} Hz`;
  layers.boxes.push(box(SINK_X, 22, SINK_W, 36, 'Bypass filter', null, { cls: 'bypass' }));
  layers.boxes.push(box(SINK_X, 70, SINK_W, 50, 'Filter 1', filterSub(p.filter), { on: !serial || p.osc.some((o) => o.route === 1) || p.noise.route === 1, node: 'filter' }));
  layers.boxes.push(box(F2_X, 148, SINK_X + SINK_W - F2_X, 50, 'Filter 2', filterSub(p.filter2), { on: f2On, node: 'filter2' }));
  for (const s_ of src) {
    const to = s_.route === 1 ? [SINK_X, F1_CY] : s_.route === 2 ? [F2_X, F2_CY] : [SINK_X, BYPASS_CY];
    wireTo(SRC_X + SRC_W, s_.cy, ...to, { on: s_.on });
  }

  // ---- sum -> drive -> amp -> out
  const SUM = [500, 100];
  layers.boxes.push(s('g', { class: 'rd-box sum' }, s('circle', { cx: SUM[0], cy: SUM[1], r: 14 }),
    s('text', { x: SUM[0], y: SUM[1] + 5, 'text-anchor': 'middle', class: 'rd-title' }, 'Σ')));
  const sinkOut = SINK_X + SINK_W;
  wireTo(sinkOut, BYPASS_CY, SUM[0] - 14, SUM[1]);
  if (serial) {
    // Filter 1 feeds filter 2: a short arrow down the gap between the boxes.
    layers.wires.push(s('path', { d: `M${SINK_X + 120},120 L${SINK_X + 120},148`, class: 'rd-wire audio', 'marker-end': 'url(#rd-arrow-audio)' }));
  } else {
    wireTo(sinkOut, F1_CY, SUM[0] - 14, SUM[1]);
  }
  if (f2On) wireTo(sinkOut, F2_CY, SUM[0] - 14, SUM[1]);
  const driveOn = p.drive > 0;
  layers.boxes.push(box(550, 78, 100, 44, 'Drive', driveOn ? `${p.shape} · ${num(p.drive)}` : 'off', { on: driveOn, node: 'drive' }));
  layers.boxes.push(box(690, 78, 110, 44, 'Amp', 'volume', { node: 'amp' }));
  layers.boxes.push(box(830, 78, 90, 44, 'Output + FX', null, { node: 'amp' })); // level and the delay/reverb sends
  wireTo(SUM[0] + 14, SUM[1], 550, 100);
  wireTo(650, 100, 690, 100);
  wireTo(800, 100, 830, 100);

  // ---- modulation row (bottom)
  const MY = 268;
  const MH = 46;
  const modBox = (x, title, sub, on, node) => {
    layers.boxes.push(box(x, MY, 160, MH, title, sub, { on, cls: 'mod', node }));
    return x + 80;
  };
  const pe = p.penv.amount !== 0;
  const fe = p.fenv.amount !== 0;
  const fe2 = f2On && p.fenv2.amount !== 0;
  const penvX = modBox(22, 'Pitch envelope', pe ? `${signed(p.penv.amount)} ct` : 'off', pe, 'penv');
  const fenvX = modBox(200, 'Filter 1 envelope', fe ? `${signed(p.fenv.amount)} Hz` : 'off', fe, 'fenv');
  const fenv2X = modBox(378, 'Filter 2 envelope', fe2 ? `${signed(p.fenv2.amount)} Hz` : 'off', fe2, 'fenv2');
  const lfoOn = p.lfo.pitch > 0 || p.lfo.cutoff > 0 || p.lfo.amp > 0;
  const lfoX = modBox(556, 'LFO', lfoOn ? `${p.lfo.wave} · ${num(p.lfo.rate)} Hz` : 'off', lfoOn, 'lfo');
  const aenvX = modBox(734, 'Amp envelope', `A ${num(p.aenv.attack)} D ${num(p.aenv.decay)} S ${num(p.aenv.sustain)} R ${num(p.aenv.release)}`, true, 'aenv');

  const OSC_BOTTOM = 206;
  // `at` = how far along the wire from the source the label sits (0..1); staggered to avoid collisions.
  const mod = (x1, x2, y2, on, text, at = 0.5) => {
    wireTo(x1, MY, x2, y2, { mod: true, on, vertical: true });
    if (on && text) layers.labels.push(label(x1 + (x2 - x1) * at, MY + (y2 - MY) * at, text));
  };
  // Into filter 1's bottom edge, which filter 2 half covers: run along under filter 2 first, then straight up the free strip.
  const modF1 = (x1, x2, on, text) => {
    layers.wires.push(s('path', { d: `M${x1},${MY} C${x1},232 ${x2},240 ${x2},214 L${x2},120`, class: `rd-wire mod ${on ? '' : 'off'}`, 'marker-end': 'url(#rd-arrow-mod)' }));
    if (on && text) layers.labels.push(label(x2 + 2, 227, text));
  };
  mod(penvX, 80, OSC_BOTTOM, pe, `${signed(p.penv.amount)} ct`);
  modF1(fenvX, 298, fe, `${signed(p.fenv.amount)} Hz`);
  mod(fenv2X, F2_X + 40, 198, fe2, `${signed(p.fenv2.amount)} Hz`);
  mod(aenvX, 745, 122, true);
  mod(lfoX, 130, OSC_BOTTOM, p.lfo.pitch > 0, `±${num(p.lfo.pitch)} ct`, 0.3);
  modF1(lfoX, 318, p.lfo.cutoff > 0, `±${num(p.lfo.cutoff)} Hz`);
  if (f2On) mod(lfoX, F2_X + 90, 198, p.lfo.cutoff > 0, null);
  mod(lfoX, 770, 122, p.lfo.amp > 0, `±${num(p.lfo.amp)}`);

  // Target captions, so it is clear what each modulation arrow drives.
  layers.labels.push(
    s('text', { x: 142, y: 222, class: 'rd-note' }, '▴ pitch'),
    s('text', { x: F2_X + 108, y: 212, class: 'rd-note', 'text-anchor': 'end' }, '▴ cutoff'),
    s('text', { x: 738, y: 138, class: 'rd-note', 'text-anchor': 'end' }, 'volume ▴'));

  const arrow = (id, cls) => s('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
    s('path', { d: 'M0,0 L10,5 L0,10 z', class: cls }));
  return s('svg', { viewBox: '0 0 930 330', class: 'rd', role: 'img', 'aria-label': 'Signal routing of this instrument' },
    s('defs', null, arrow('rd-arrow-audio', 'rd-head audio'), arrow('rd-arrow-mod', 'rd-head mod')),
    layers.wires, layers.boxes, layers.labels,
    s('g', { class: 'rd-legend', transform: 'translate(600 18)' },
      s('line', { x1: 0, y1: 0, x2: 28, y2: 0, class: 'rd-wire audio' }), s('text', { x: 34, y: 4, class: 'rd-note' }, 'audio'),
      s('line', { x1: 90, y1: 0, x2: 118, y2: 0, class: 'rd-wire mod' }), s('text', { x: 124, y: 4, class: 'rd-note' }, 'modulation'),
      s('text', { x: 0, y: 22, class: 'rd-note' }, 'dimmed = switched off')));
}
