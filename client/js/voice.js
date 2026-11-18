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

function shaperCurve(drive) {
  const norm = Math.tanh(drive);
  const c = new Float32Array(SHAPER_CURVE_LEN);
  for (let i = 0; i < SHAPER_CURVE_LEN; i++) c[i] = Math.tanh(drive * ((2 * i) / (SHAPER_CURVE_LEN - 1) - 1)) / norm;
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
 * future) to let the note go. `noise` maps node id -> AudioBuffer. `plan` (optional, from fx.js `notePlan`) automates the
 * voice: its volumes multiply the output level and its pitches offset the (non-fixed) oscillators, in semitones.
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
      case 'osc':
        node = ctx.createOscillator();
        node.type = n.wave;
        node.frequency.value = n.fixed_hz ?? hz * 2 ** ((n.semitones ?? 0) / 12);
        node.detune.value = n.detune ?? 0;
        // Arpeggio ticks: the detune param carries the semitone offset (in cents) on top of the oscillator's own detune.
        if (n.fixed_hz == null) for (const [dt, semis] of plan?.pitches ?? []) node.detune.setValueAtTime((n.detune ?? 0) + semis * 100, t0 + dt);
        node.start(t0);
        sources.push(node);
        params = { freq: node.frequency, detune: node.detune };
        break;
      case 'noise':
        node = ctx.createBufferSource();
        node.buffer = noise.get(n.id) ?? null;
        node.loop = true;
        node.start(t0);
        sources.push(node);
        break;
      case 'gain':
        node = gain(ctx, n.gain);
        params = { gain: node.gain };
        break;
      case 'filter':
        node = ctx.createBiquadFilter();
        node.type = n.mode;
        node.frequency.value = Math.min(22000, Math.max(10, n.freq * (hz / MIDDLE_C_HZ) ** (n.key_track ?? 0)));
        node.Q.value = n.q;
        params = { freq: node.frequency, q: node.Q, detune: node.detune };
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
        node.curve = shaperCurve(n.drive);
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
    else if (b.params[port]) a.node.connect(b.params[port]);
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
