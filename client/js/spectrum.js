// A small spectrum display for the footer: log-spaced bars from the shared output analyser (audio.js).
import { peekAnalyser } from './audio.js';

const F_MIN = 40;
const F_MAX = 16000;

export class Spectrum {
  /** @param {{bars?:number, width?:number, height?:number}} [o] CSS pixel size of the canvas */
  constructor({ bars = 32, width = 150, height = 28 } = {}) {
    this.bars = bars;
    this.w = width;
    this.h = height;
    this.el = document.createElement('canvas');
    this.el.className = 'spectrum';
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', 'Spectrum of the sound playing');
    this.el.title = 'Spectrum of what you hear';
    const dpr = window.devicePixelRatio || 1;
    this.el.width = Math.round(width * dpr);
    this.el.height = Math.round(height * dpr);
    this.el.style.width = `${width}px`;
    this.el.style.height = `${height}px`;
    this.dpr = dpr;
    this.data = null;
    this.raf = 0;
    this.levels = new Float32Array(bars); // smoothed, so the bars fall gently
    this.frame = this.frame.bind(this);
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  frame() {
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;
    const an = peekAnalyser();
    const n = this.bars;
    if (an) {
      this.data ??= new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(this.data);
      const hzPerBin = an.context.sampleRate / an.fftSize;
      for (let i = 0; i < n; i++) {
        const lo = F_MIN * (F_MAX / F_MIN) ** (i / n);
        const hi = F_MIN * (F_MAX / F_MIN) ** ((i + 1) / n);
        const b0 = Math.max(1, Math.floor(lo / hzPerBin));
        const b1 = Math.min(this.data.length - 1, Math.max(b0, Math.ceil(hi / hzPerBin)));
        let m = 0;
        for (let b = b0; b <= b1; b++) m = Math.max(m, this.data[b]);
        const v = m / 255;
        this.levels[i] = Math.max(v, this.levels[i] * 0.88);
      }
    } else this.levels.fill(0);
    this.draw();
  }

  draw() {
    const c = this.el.getContext('2d');
    const { width: W, height: H } = this.el;
    c.clearRect(0, 0, W, H);
    const n = this.bars;
    const gap = Math.max(1, Math.round(this.dpr));
    const bw = (W - gap * (n - 1)) / n;
    this.color ??= getComputedStyle(this.el).getPropertyValue('--accent').trim() || '#ffb347'; // once the canvas is attached
    for (let i = 0; i < n; i++) {
      const v = this.levels[i];
      const bh = Math.max(Math.round(this.dpr), Math.round(v * H)); // a baseline stub even when silent
      c.globalAlpha = v < 0.02 ? 0.25 : 0.9;
      c.fillStyle = this.color;
      c.fillRect(i * (bw + gap), H - bh, bw, bh);
    }
    c.globalAlpha = 1;
  }
}
