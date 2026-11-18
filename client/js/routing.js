// Read-only SVG signal-flow diagram for a synth template patch (see synth.js). Redrawn from the patch on
// every edit, so it always shows what is currently routed where. Solid grey = audio, dashed orange =
// modulation; anything switched off (level 0, amount 0, drive 0) is dimmed.

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
  const src = []; // {cy, filtered, on}
  layers.boxes.push(box(SRC_X, 14, SRC_W, 38, 'Noise', `${p.noise.color} · level ${num(p.noise.level)}`, { on: p.noise.level > 0, node: 'noise' }));
  src.push({ cy: 33, filtered: p.noise.filtered, on: p.noise.level > 0 });
  layers.boxes.push(s('rect', { x: 12, y: 64, width: SRC_W + 20, height: 142, rx: 8, class: 'rd-group' }));
  p.osc.forEach((o, i) => {
    const y = 74 + i * 44;
    const pitch = o.fixed_hz != null ? `${num(o.fixed_hz)} Hz` : `${signed(o.semitones)} st`;
    layers.boxes.push(box(SRC_X, y, SRC_W, 38, `Osc ${i + 1}`, `${o.wave} · ${pitch} · level ${num(o.level)}`, { on: o.level > 0, node: `osc${i + 1}` }));
    src.push({ cy: y + 19, filtered: o.filtered, on: o.level > 0 });
  });

  // FM: a dashed loop from osc 2 up to osc 1 (frequency modulation), only while it is switched on
  if (p.fm.on) {
    const x = SRC_X + SRC_W;
    layers.wires.push(s('path', { d: `M${x},${src[2].cy} C${x + 34},${src[2].cy} ${x + 34},${src[1].cy} ${x},${src[1].cy}`, class: 'rd-wire mod', 'marker-end': 'url(#rd-arrow-mod)' }));
    layers.labels.push(label(x + 40, (src[1].cy + src[2].cy) / 2 + 4, `FM ${num(p.fm.depth)}`));
  }

  // ---- filter / bypass sinks
  const SINK_X = 290;
  const SINK_W = 150;
  const BYPASS_CY = 54;
  const FILTER_CY = 128;
  layers.boxes.push(box(SINK_X, 34, SINK_W, 40, 'Bypass filter', null, { cls: 'bypass' }));
  layers.boxes.push(box(SINK_X, 96, SINK_W, 64, 'Filter', `${p.filter.mode} · ${num(p.filter.freq)} Hz`, { node: 'filter' }));
  for (const s_ of src) wireTo(SRC_X + SRC_W, s_.cy, SINK_X, s_.filtered ? FILTER_CY : BYPASS_CY, { on: s_.on });

  // ---- sum -> drive -> amp -> out
  const SUM = [500, 100];
  layers.boxes.push(s('g', { class: 'rd-box sum' }, s('circle', { cx: SUM[0], cy: SUM[1], r: 14 }),
    s('text', { x: SUM[0], y: SUM[1] + 5, 'text-anchor': 'middle', class: 'rd-title' }, 'Σ')));
  wireTo(SINK_X + SINK_W, BYPASS_CY, SUM[0] - 14, SUM[1]);
  wireTo(SINK_X + SINK_W, FILTER_CY, SUM[0] - 14, SUM[1]);
  const driveOn = p.drive > 0;
  layers.boxes.push(box(550, 78, 100, 44, 'Drive', driveOn ? `amount ${num(p.drive)}` : 'off', { on: driveOn, node: 'drive' }));
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
  const penvX = modBox(22, 'Pitch envelope', pe ? `${signed(p.penv.amount)} ct` : 'off', pe, 'penv');
  const fenvX = modBox(240, 'Filter envelope', fe ? `${signed(p.fenv.amount)} Hz` : 'off', fe, 'fenv');
  const lfoOn = p.lfo.pitch > 0 || p.lfo.cutoff > 0 || p.lfo.amp > 0;
  const lfoX = modBox(460, 'LFO', lfoOn ? `${p.lfo.wave} · ${num(p.lfo.rate)} Hz` : 'off', lfoOn, 'lfo');
  const aenvX = modBox(700, 'Amp envelope', `A ${num(p.aenv.attack)} D ${num(p.aenv.decay)} S ${num(p.aenv.sustain)} R ${num(p.aenv.release)}`, true, 'aenv');

  const OSC_BOTTOM = 206;
  // `at` = how far along the wire from the source the label sits (0..1); staggered to avoid collisions.
  const mod = (x1, x2, y2, on, text, at = 0.5) => {
    wireTo(x1, MY, x2, y2, { mod: true, on, vertical: true });
    if (on && text) layers.labels.push(label(x1 + (x2 - x1) * at, MY + (y2 - MY) * at, text));
  };
  mod(penvX, 80, OSC_BOTTOM, pe, `${signed(p.penv.amount)} ct`);
  mod(fenvX, SINK_X + 50, FILTER_CY + 32, fe, `${signed(p.fenv.amount)} Hz`);
  mod(aenvX, 745, 122, true);
  mod(lfoX, 130, OSC_BOTTOM, p.lfo.pitch > 0, `±${num(p.lfo.pitch)} ct`, 0.3);
  mod(lfoX, SINK_X + 110, FILTER_CY + 32, p.lfo.cutoff > 0, `±${num(p.lfo.cutoff)} Hz`);
  mod(lfoX, 770, 122, p.lfo.amp > 0, `±${num(p.lfo.amp)}`);

  // Target captions, so it is clear what each modulation arrow drives.
  layers.labels.push(
    s('text', { x: 142, y: 222, class: 'rd-note' }, '▴ pitch'),
    s('text', { x: SINK_X + 124, y: FILTER_CY + 46, class: 'rd-note' }, '▴ cutoff'),
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
