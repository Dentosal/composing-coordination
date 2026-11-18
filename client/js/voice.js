// Live Web Audio voices and master chain for auditioning instruments in the browser. A port of the voice and
// master sections of server/src/render/ (voice.rs, master.rs): same node mapping, same constants. The server
// render stays canonical; this is for instant feedback while editing.
import { Mulberry32 } from './prng.js';

export const SEAT_GAIN = 0.25;
const MIDDLE_C_HZ = 261.6255653005986;
const ENV_TAU_DIV = 5;
const MIN_TIME = 0.001;
const STOP_PAD = 0.005;
const SHAPER_CURVE_LEN = 2048;
const NOISE_SECS = 1;
const REVERB_SECS = 1.8;
const DELAY_BEATS = 0.75;
const DELAY_FEEDBACK = 0.4;
const DELAY_LP_HZ = 3000;
const DELAY_RETURN = 0.7;
const REVERB_RETURN = 0.8;
const OUTPUT_TRIM = 0.7; // see OUTPUT_TRIM in server/src/render/master.rs
// The server's limiter is a DynamicsCompressor (threshold -6 dB, ratio 20) whose automatic makeup gain works out to
// roughly +4 dB for the sounds this game makes. Browsers' own DynamicsCompressor implementations differ a lot from
// that crate's (quiet transients come out up to 12 dB lower), so the live master uses a static curve with the same
// threshold, ratio and makeup instead. Measured against the server render: see tools/parity/run.sh.
const LIMIT_THRESHOLD = 0.5; // -6 dB
const LIMIT_RATIO = 20;
const LIMIT_MAKEUP = 1.64; // +4.3 dB
const LIMIT_CURVE_LEN = 4096;

function limiterCurve() {
  const c = new Float32Array(LIMIT_CURVE_LEN);
  for (let i = 0; i < LIMIT_CURVE_LEN; i++) {
    const x = (2 * i) / (LIMIT_CURVE_LEN - 1) - 1;
    const a = Math.abs(x);
    const y = a <= LIMIT_THRESHOLD ? a : LIMIT_THRESHOLD * (a / LIMIT_THRESHOLD) ** (1 / LIMIT_RATIO);
    c[i] = Math.sign(x) * y * LIMIT_MAKEUP;
  }
  return c;
}

/** Detune offsets in cents of the `n` copies of a unison oscillator. Must stay identical to `unison_offsets` in server/src/orders.rs. */
export function unisonOffsets(n, spread) {
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, i) => Math.fround(spread * ((2 * i) / (n - 1) - 1)) + 0); // + 0 turns -0 into 0
}

const NYQUIST = 24000; // the server's sample rate / 2, so the tables match whatever rate the browser runs at

/**
 * Fourier coefficients ({real, imag}, index 0 unused) of a built-in wave shape shifted by `phase` cycles. Unison copies
 * use these so they start at different points of the cycle, not all at phase 0. Must stay identical to `wave_coeffs`
 * in server/src/render/voice.rs.
 */
export function unisonCoeffs(wave, harmonics, phase) {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    let b;
    if (wave === 'sine') b = n === 1 ? 1 : 0;
    else if (wave === 'square') b = n % 2 === 1 ? 4 / (n * Math.PI) : 0;
    else if (wave === 'sawtooth') b = (2 / (n * Math.PI)) * (n % 2 === 1 ? 1 : -1);
    else b = (8 * Math.sin((n * Math.PI) / 2)) / (n * Math.PI) ** 2; // triangle
    const a = 2 * Math.PI * phase * n;
    real[n] = b * Math.sin(a);
    imag[n] = b * Math.cos(a);
  }
  return { real, imag };
}

/** Harmonics in a unison copy's table: as many as fit under Nyquist at `maxHz`, rounded down to a power of two (max 512). Must stay identical to `unison_harmonics` in voice.rs. */
export function unisonHarmonics(maxHz) {
  const fit = Math.max(1, Math.floor(NYQUIST / maxHz));
  let h = 1;
  while (h * 2 <= fit && h < 512) h *= 2;
  return h;
}

const UNISON_PHASES = [
  [], [0],
  [0, 0.75],
  [0, 0.722, 0.112],
  [0, 0.854, 0.562, 0.625],
  [0, 0.539, 0.621, 0.96, 0.729],
  [0, 0.78, 0.854, 0.416, 0.805, 0.531],
  [0, 0.769, 0.086, 0.244, 0.281, 0.704, 0.105],
];
/** Start phase (in cycles) of copy `i` of `n`. Searched offline so the copies add up like uncorrelated signals on the low harmonics (even spacing cancels them, equal phases make the start n times as loud). Must stay identical to `unison_phase` in voice.rs. */
export const unisonPhase = (i, n) => UNISON_PHASES[Math.min(n, 7)][i] ?? 0;

const waveCache = new WeakMap(); // ctx -> Map<key, PeriodicWave>
function unisonWave(ctx, wave, harmonics, i, n) {
  let m = waveCache.get(ctx);
  if (!m) waveCache.set(ctx, (m = new Map()));
  const key = `${wave}:${harmonics}:${i}:${n}`;
  let w = m.get(key);
  if (!w) {
    w = ctx.createPeriodicWave(...Object.values(unisonCoeffs(wave, harmonics, unisonPhase(i, n))));
    m.set(key, w);
  }
  return w;
}

export const midiHz = (note) => 440 * 2 ** ((note - 69) / 12);

const gain = (ctx, v) => {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
};

/** Noise buffer for one noise node (same algorithm and PRNG key as the server). */
export function noiseBuffer(ctx, seed, seatIndex, instId, nodeId, color) {
  const rng = Mulberry32.fromKey(`${seed}:${seatIndex}:${instId}:${nodeId}`);
  const n = Math.floor(NOISE_SECS * ctx.sampleRate);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (color === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.nextBipolar();
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }
  } else {
    for (let i = 0; i < n; i++) d[i] = rng.nextBipolar();
  }
  return buf;
}

/** Shaped value for input x in -1..1: `drive` is the gain into the curve, `param` the shape's second setting. Must stay identical to `shape_value` in server/src/render/voice.rs (floor, not Math.round, which rounds ties differently). */
export function shapeValue(shape, drive, param, x) {
  const u = drive * x;
  switch (shape) {
    case 'hard':
      return Math.min(1, Math.max(-1, u)) / Math.min(drive, 1);
    case 'fold': {
      const t = (((u + 1) % 4) + 4) % 4;
      return t < 2 ? t - 1 : 3 - t;
    }
    case 'asym': {
      const b = param;
      const norm = Math.max(Math.tanh(drive + b) - Math.tanh(b), Math.tanh(b) - Math.tanh(b - drive));
      return (Math.tanh(u + b) - Math.tanh(b)) / norm;
    }
    case 'crush': {
      const k = 2 ** (param - 1);
      return Math.min(1, Math.max(-1, Math.floor(Math.min(1, Math.max(-1, u)) * k + 0.5) / k));
    }
    default: // soft
      return Math.tanh(u) / Math.tanh(drive);
  }
}

/** The second setting's value when a shaper node has none. */
export const shapeDefaultParam = (shape) => (shape === 'crush' ? 8 : 0.5);

export function shaperCurve(drive, shape = 'soft', param = null) {
  const p = param ?? shapeDefaultParam(shape);
  const c = new Float32Array(SHAPER_CURVE_LEN);
  for (let i = 0; i < SHAPER_CURVE_LEN; i++) c[i] = shapeValue(shape, drive, p, (2 * i) / (SHAPER_CURVE_LEN - 1) - 1);
  return c;
}

/** Shared sends and limiter. Everything ends up in `dry`; `delayIn` and `reverbIn` are the send inputs. */
export class Master {
  constructor(ctx, { bpm, seed }, dest = ctx.destination) {
    this.dry = gain(ctx, 1);
    this.delayIn = gain(ctx, 1);
    this.reverbIn = gain(ctx, 1);

    const limiter = ctx.createWaveShaper();
    limiter.curve = limiterCurve();
    limiter.connect(gain(ctx, OUTPUT_TRIM)).connect(dest);
    this.dry.connect(limiter);

    const delay = ctx.createDelay(4);
    delay.delayTime.value = (DELAY_BEATS * 60) / bpm;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = DELAY_LP_HZ;
    lp.Q.value = 0.7071;
    const fb = gain(ctx, DELAY_FEEDBACK);
    this.delayIn.connect(delay);
    delay.connect(lp);
    lp.connect(fb).connect(delay);
    lp.connect(gain(ctx, DELAY_RETURN)).connect(limiter);

    const irLen = Math.floor(REVERB_SECS * ctx.sampleRate);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const rng = Mulberry32.fromKey(`${seed}:reverb:${c}`);
      const d = ir.getChannelData(c);
      for (let i = 0; i < irLen; i++) d[i] = rng.nextBipolar() * Math.exp((-6.9 * (i / ctx.sampleRate)) / REVERB_SECS);
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    this.reverbIn.connect(conv);
    conv.connect(gain(ctx, REVERB_RETURN)).connect(limiter);
  }

  /** One bus per instrument per note: bus gain -> dry, plus the two send taps. */
  bus(ctx, inst) {
    const input = gain(ctx, inst.gain * SEAT_GAIN);
    input.connect(this.dry);
    input.connect(gain(ctx, inst.send_delay)).connect(this.delayIn);
    input.connect(gain(ctx, inst.send_reverb)).connect(this.reverbIn);
    return input;
  }
}

const times = (e) => ({
  a: Math.max(e.attack, MIN_TIME), d: Math.max(e.decay, MIN_TIME), r: Math.max(e.release, MIN_TIME),
});

/** Attack (linear) then decay (exponential approach to sustain). The gate end is not known yet. */
function envStart(p, e, t0) {
  const { a, d } = times(e);
  p.setValueAtTime(0, t0);
  p.linearRampToValueAtTime(e.amount, t0 + a);
  p.setTargetAtTime(e.amount * e.sustain, t0 + a, d / ENV_TAU_DIV);
}

/** Release at time `tg`: compute the level the curve has reached (as the spec's formulas say) and fall from there. */
function envRelease(p, e, t0, tg) {
  const { a, d, r } = times(e);
  p.cancelScheduledValues(tg);
  if (tg - t0 <= a) {
    p.linearRampToValueAtTime((e.amount * (tg - t0)) / a, tg); // released during the attack
  } else {
    const sustain = e.amount * e.sustain;
    p.setValueAtTime(sustain + (e.amount - sustain) * Math.exp(-(tg - (t0 + a)) / (d / ENV_TAU_DIV)), tg);
  }
  p.setTargetAtTime(0, tg, r / ENV_TAU_DIV);
}

/**
 * Start one voice of `inst` at `t0`. Returns `{ release(tg) }`: call it with the gate-end time (now or in the
 * future) to let the note go. `noise` maps node id -> AudioBuffer. `plan` (optional: one segment of fx.js `notePlan`)
 * automates the voice: its volumes multiply the output level, its pitches offset the (non-fixed) oscillators, in
 * semitones (a slide gives fractions), and its params set node parameters (filter cutoff, a gain, ...). Times in the
 * plan are seconds after `t0`.
 */
export function startVoice(ctx, bus, inst, noise, note, vel, t0, plan = null) {
  const hz = midiHz(note);
  const nodes = new Map(); // id -> { node, params }
  const sources = [];
  const envs = [];
  for (const n of inst.nodes) {
    let node;
    let params = {};
    switch (n.type) {
      case 'osc': {
        const offsets = unisonOffsets(n.unison ?? 1, n.spread ?? 0);
        const f = n.fixed_hz ?? hz * 2 ** ((n.semitones ?? 0) / 12);
        const topCents = (n.detune ?? 0) + Math.max(...offsets) + Math.max(0, ...(plan?.pitches ?? []).map(([, s]) => s)) * 100;
        const harmonics = unisonHarmonics(f * 2 ** (Math.max(0, topCents) / 1200));
        const oscs = offsets.map((off, i) => {
          const o = ctx.createOscillator();
          // Copies start at different points of the cycle (see unisonPhase), so they do not all add up at the start of the note.
          if (offsets.length > 1) o.setPeriodicWave(unisonWave(ctx, n.wave, harmonics, i, offsets.length));
          else o.type = n.wave;
          o.frequency.value = f;
          o.detune.value = (n.detune ?? 0) + off;
          // Arpeggio ticks: the detune param carries the semitone offset (in cents) on top of the oscillator's own detune.
          if (n.fixed_hz == null) for (const [dt, semis] of plan?.pitches ?? []) o.detune.setValueAtTime((n.detune ?? 0) + off + semis * 100, t0 + dt);
          o.start(t0);
          sources.push(o);
          return o;
        });
        if (oscs.length > 1) {
          node = gain(ctx, 1 / Math.sqrt(oscs.length));
          for (const o of oscs) o.connect(node);
        } else {
          node = oscs[0];
        }
        params = { freq: oscs.map((o) => o.frequency), detune: oscs.map((o) => o.detune) };
        break;
      }
      case 'noise':
        node = ctx.createBufferSource();
        node.buffer = noise.get(n.id) ?? null;
        node.loop = true;
        node.start(t0);
        sources.push(node);
        break;
      case 'gain':
        node = gain(ctx, n.gain * (hz / MIDDLE_C_HZ) ** (n.key_track ?? 0));
        params = { gain: [node.gain] };
        break;
      case 'filter':
        node = ctx.createBiquadFilter();
        node.type = n.mode;
        node.frequency.value = Math.min(22000, Math.max(10, n.freq * (hz / MIDDLE_C_HZ) ** (n.key_track ?? 0)));
        node.Q.value = n.q;
        params = { freq: [node.frequency], q: [node.Q], detune: [node.detune] };
        break;
      case 'env':
        node = ctx.createConstantSource();
        node.offset.value = 0;
        envStart(node.offset, n, t0);
        node.start(t0);
        sources.push(node);
        envs.push({ p: node.offset, e: n });
        break;
      case 'shaper':
        node = ctx.createWaveShaper();
        node.curve = shaperCurve(n.drive, n.shape ?? 'soft', n.param ?? null);
        break;
      case 'out':
        node = gain(ctx, vel / 127);
        for (const [dt, v] of plan?.volumes ?? []) node.gain.setValueAtTime((vel / 127) * v, t0 + dt);
        node.connect(bus);
        break;
      default:
        continue;
    }
    nodes.set(n.id, { node, params });
  }
  for (const { from, to, port } of inst.edges) {
    const a = nodes.get(from);
    const b = nodes.get(to);
    if (!a || !b) continue;
    if (!port) a.node.connect(b.node);
    else for (const p of b.params[port] ?? []) a.node.connect(p);
  }
  // Parameter automation (effect cells): the value at the voice's start, then the changes (see `notePlan` in fx.js).
  for (const tr of plan?.params ?? []) {
    for (const p of nodes.get(tr.node)?.params[tr.port] ?? []) {
      p.setValueAtTime(tr.initial, t0);
      for (const [dt, value, ramp] of tr.events) {
        if (!ramp) p.setValueAtTime(value, t0 + dt);
        else if (tr.exp) p.exponentialRampToValueAtTime(value, t0 + dt);
        else p.linearRampToValueAtTime(value, t0 + dt);
      }
    }
  }
  const maxRelease = Math.max(0, ...envs.map(({ e }) => e.release));
  let released = false;
  return {
    release(tg) {
      if (released) return;
      released = true;
      tg = Math.max(tg, t0 + 0.001);
      for (const { p, e } of envs) envRelease(p, e, t0, tg);
      for (const s of sources) s.stop(tg + maxRelease + STOP_PAD);
    },
  };
}
