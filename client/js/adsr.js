// Reusable ADSR envelope control: a shape preview on top of four vertical sliders (attack, decay, sustain, release;
// hover one for its name and value). Edits `env` ({attack, decay, sustain, release}) in place and calls `change` on every input.
// Double-click a slider to reset it to `defaults`; hover for the exact value.
import { h } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const T_MIN = 0.001;
const T_MAX = 5;

const STAGES = [
  { key: 'attack', name: 'Attack', log: true },
  { key: 'decay', name: 'Decay', log: true },
  { key: 'sustain', name: 'Sustain', log: false },
  { key: 'release', name: 'Release', log: true },
];

const fmtVal = (key, v) => (key === 'sustain' ? `${Math.round(v * 100)}%` : v < 1 ? `${Math.round(v * 1000)} ms` : `${Number(v.toPrecision(3))} s`);
const toSlider = (st, v) => (st.log ? Math.log(Math.max(v, T_MIN) / T_MIN) / Math.log(T_MAX / T_MIN) : v);
const fromSlider = (st, x) => (st.log ? Number((T_MIN * (T_MAX / T_MIN) ** x).toPrecision(3)) : x);

// The preview has a fixed time scale: attack, decay and release each get the same fixed-width slot, plus a
// fixed-width sustain hold. A duration maps to a fraction of its slot on a compressed (log-like) scale, so 5 ms and
// 2 s both stay visible, and changing one stage never changes the width of another.
const W = 120;
const H = 48;
const PAD = 2;
const HOLD_W = 14;
const SLOT_W = (W - 2 * PAD - HOLD_W) / 3;
const squash = (t) => Math.log1p(t / 0.002) / Math.log1p(T_MAX / 0.002); // 0..1

/** SVG path data for the envelope: attack up, decay to sustain, a fixed-width hold, release to zero. */
export function envelopePath({ attack, decay, sustain, release }) {
  const y = (level) => PAD + (1 - level) * (H - 2 * PAD);
  let x = PAD;
  const pts = [[x, y(0)]];
  x += squash(attack) * SLOT_W; pts.push([x, y(1)]);
  // Decay and release start where their slot starts, so the hold sits at a fixed x regardless of the stages before it.
  const decayStart = PAD + SLOT_W;
  x = decayStart + squash(decay) * SLOT_W; pts.push([x, y(sustain)]);
  const holdEnd = decayStart + SLOT_W + HOLD_W;
  pts.push([holdEnd, y(sustain)]);
  x = holdEnd + squash(release) * SLOT_W; pts.push([x, y(0)]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  return { line, area: `${line} L${pts[pts.length - 1][0].toFixed(1)},${y(0)} L${PAD},${y(0)} Z` };
}

/**
 * @param {{attack:number,decay:number,sustain:number,release:number}} env edited in place
 * @param {() => void} change called after every edit
 * @param {{defaults?: object}} [opts] reset values for double-click
 */
export function adsrControl(env, change, opts = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'adsr-preview');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Envelope shape');
  const area = document.createElementNS(NS, 'path');
  area.setAttribute('class', 'adsr-area');
  const line = document.createElementNS(NS, 'path');
  line.setAttribute('class', 'adsr-line');
  svg.append(area, line);
  const draw = () => {
    const p = envelopePath(env);
    line.setAttribute('d', p.line);
    area.setAttribute('d', p.area);
  };
  draw();

  const cols = STAGES.map((st) => {
    const describe = () => `${st.name}: ${fmtVal(st.key, env[st.key])}`;
    const input = h('input', {
      type: 'range', min: '0', max: '1', step: st.log ? '0.001' : '0.01', value: String(toSlider(st, env[st.key])),
      title: `${describe()} (double-click to reset)`, 'aria-label': st.name,
      oninput: (e) => {
        env[st.key] = fromSlider(st, parseFloat(e.target.value));
        input.title = `${describe()} (double-click to reset)`;
        draw();
        change();
      },
      ondblclick: () => {
        const def = opts.defaults?.[st.key];
        if (typeof def !== 'number') return;
        env[st.key] = def;
        input.value = String(toSlider(st, def));
        input.title = `${describe()} (double-click to reset)`;
        draw();
        change();
      },
    });
    return h('div.adsr-col', input);
  });
  return h('div.adsr', svg, h('div.adsr-sliders', cols));
}
