// A small plot of the waveshaper's transfer curve (input along x, output along y), drawn with the same curve function
// the audio uses (shapeValue in voice.js), so the picture always matches what you hear. Redrawn on every patch edit.
import { shapeValue } from './voice.js';
import { MIN_DRIVE } from './synth.js';

const NS = 'http://www.w3.org/2000/svg';
const POINTS = 257;
const el = (tag, attrs) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/** @returns {{el: SVGElement, update: (p: {drive: number, shape: string, shapeParam: number}) => void}} */
export function shapePlot() {
  // The plot area is -1..1 on both axes, with a little margin; y is flipped so that up is positive.
  const svg = el('svg', { viewBox: '-1.12 -1.12 2.24 2.24', class: 'shape-plot', role: 'img', 'aria-label': 'Waveshaper transfer curve' });
  svg.append(Object.assign(document.createElementNS(NS, 'title'), { textContent: 'The curve: input level (across) to output level (up)' }));
  svg.append(
    el('rect', { x: -1, y: -1, width: 2, height: 2, class: 'sp-frame' }),
    el('line', { x1: -1, y1: 0, x2: 1, y2: 0, class: 'sp-axis' }),
    el('line', { x1: 0, y1: -1, x2: 0, y2: 1, class: 'sp-axis' }),
    el('line', { x1: -1, y1: 1, x2: 1, y2: -1, class: 'sp-identity' }), // no distortion: output = input
  );
  const curve = el('path', { class: 'sp-curve', fill: 'none' });
  svg.append(curve);
  return {
    el: svg,
    update({ drive, shape, shapeParam }) {
      const d = Math.max(MIN_DRIVE, drive);
      let path = '';
      for (let i = 0; i < POINTS; i++) {
        const x = (2 * i) / (POINTS - 1) - 1;
        path += `${i ? 'L' : 'M'}${x.toFixed(4)},${(-shapeValue(shape, d, shapeParam, x)).toFixed(4)}`;
      }
      curve.setAttribute('d', path);
      svg.classList.toggle('off', !(drive > 0)); // drive 0 switches the shaper off: the plot shows the curve dimmed
    },
  };
}
