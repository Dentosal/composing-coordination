// Fixed-architecture synth template. The editor works on a flat "patch" (a few dozen numbers); this module
// converts it to and from the orders instrument graph the server validates and renders. The server
// knows nothing about the template: it only ever sees an ordinary node/edge graph.
//
//   o1 o2 o3 noise -> level gains -> (filter | direct) -> bus -> [drive] -> vca -> out
//   aenv -> vca.gain   fenv -> filter.freq   penv -> o*.detune   lfo -> (pitch | cutoff | amp) depth gains
//
// Every module always exists, so switching things on and off never loses settings: a silent oscillator
// is level 0, an unused modulation is amount 0. The one exception is drive, where 0 omits the shaper.

export const OSC_COUNT = 3;
export const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
export const FILTER_MODES = ['lowpass', 'highpass', 'bandpass', 'notch'];
export const MIN_DRIVE = 0.1; // server minimum for a shaper node

const oscPatch = (level = 0) => ({
  wave: 'sawtooth', semitones: 0, detune: 0, fixed_hz: null, level, filtered: true,
});

export function defaultPatch() {
  return {
    gain: 0.8,
    send_delay: 0,
    send_reverb: 0.1,
    osc: [oscPatch(0.5), oscPatch(), oscPatch()],
    noise: { color: 'white', level: 0, filtered: true },
    filter: { mode: 'lowpass', freq: 2000, q: 1, key_track: 0.5 },
    drive: 0,
    aenv: { attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.1 },
    fenv: { attack: 0.005, decay: 0.25, sustain: 0.3, release: 0.1, amount: 0 }, // amount in Hz
    penv: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.05, amount: 0 }, // amount in cents
    lfo: { wave: 'sine', rate: 5, pitch: 0, cutoff: 0, amp: 0 }, // depths: cents, Hz, gain
  };
}

const env = (id, e, amount) => ({
  id, type: 'env', attack: e.attack, decay: e.decay, sustain: e.sustain, release: e.release, amount,
});
const gainNode = (id, gain) => ({ id, type: 'gain', gain });

/** Patch -> orders instrument. */
export function buildInstrument(id, p, name) {
  const nodes = [];
  const edges = [];
  const edge = (from, to, port) => edges.push(port ? { from, to, port } : { from, to });

  p.osc.forEach((o, i) => {
    const n = { id: `o${i + 1}`, type: 'osc', wave: o.wave, semitones: o.semitones, detune: o.detune };
    if (o.fixed_hz != null) n.fixed_hz = o.fixed_hz;
    nodes.push(n, gainNode(`l${i + 1}`, o.level));
    edge(n.id, `l${i + 1}`);
    edge(`l${i + 1}`, o.filtered ? 'lp' : 'bus');
    edge('penv', n.id, 'detune');
    edge('lfo_p', n.id, 'detune');
  });
  nodes.push({ id: 'n', type: 'noise', color: p.noise.color }, gainNode('ln', p.noise.level));
  edge('n', 'ln');
  edge('ln', p.noise.filtered ? 'lp' : 'bus');

  nodes.push(
    { id: 'lp', type: 'filter', mode: p.filter.mode, freq: p.filter.freq, q: p.filter.q, key_track: p.filter.key_track },
    gainNode('bus', 1));
  edge('lp', 'bus');
  edge('fenv', 'lp', 'freq');
  edge('lfo_c', 'lp', 'freq');

  let tail = 'bus';
  if (p.drive > 0) {
    nodes.push({ id: 'drv', type: 'shaper', drive: Math.max(MIN_DRIVE, p.drive) });
    edge('bus', 'drv');
    tail = 'drv';
  }
  nodes.push(gainNode('vca', 0), env('aenv', p.aenv, 1), env('fenv', p.fenv, p.fenv.amount), env('penv', p.penv, p.penv.amount));
  edge(tail, 'vca');
  edge('aenv', 'vca', 'gain');
  edge('lfo_a', 'vca', 'gain');

  nodes.push(
    { id: 'lfo', type: 'osc', wave: p.lfo.wave, semitones: 0, detune: 0, fixed_hz: p.lfo.rate },
    gainNode('lfo_p', p.lfo.pitch), gainNode('lfo_c', p.lfo.cutoff), gainNode('lfo_a', p.lfo.amp),
    { id: 'out', type: 'out' });
  edge('lfo', 'lfo_p');
  edge('lfo', 'lfo_c');
  edge('lfo', 'lfo_a');
  edge('vca', 'out');

  return { id, ...(name ? { name } : {}), gain: p.gain, send_delay: p.send_delay, send_reverb: p.send_reverb, nodes, edges };
}

// ------------------------------------------------------------------ parsing

/** Normalise an instrument so two spellings of the same graph compare equal. */
function canonical(inst) {
  const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const nodes = inst.nodes.map((n) => {
    const c = { ...n };
    if (c.type === 'osc') {
      c.semitones ??= 0;
      c.detune ??= 0;
      if (c.fixed_hz == null) delete c.fixed_hz;
    }
    if (c.type === 'filter') c.key_track ??= 0;
    return sortKeys(c);
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = inst.edges.map((e) => sortKeys({ from: e.from, to: e.to, ...(e.port ? { port: e.port } : {}) }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({ id: inst.id, gain: inst.gain, send_delay: inst.send_delay, send_reverb: inst.send_reverb, nodes, edges });
}

/** Orders instrument -> patch, or null when it is not exactly a template instrument (then it can't be edited here). */
export function parseInstrument(inst) {
  const by = new Map(inst.nodes.map((n) => [n.id, n]));
  const need = (id, type) => {
    const n = by.get(id);
    if (!n || n.type !== type) throw new Error(`missing ${id}`);
    return n;
  };
  const routedTo = (from, to) => inst.edges.some((e) => e.from === from && e.to === to && !e.port);
  try {
    const envOf = (id) => {
      const e = need(id, 'env');
      return { attack: e.attack, decay: e.decay, sustain: e.sustain, release: e.release };
    };
    const p = defaultPatch();
    p.gain = inst.gain;
    p.send_delay = inst.send_delay;
    p.send_reverb = inst.send_reverb;
    for (let i = 0; i < OSC_COUNT; i++) {
      const o = need(`o${i + 1}`, 'osc');
      p.osc[i] = {
        wave: o.wave, semitones: o.semitones ?? 0, detune: o.detune ?? 0, fixed_hz: o.fixed_hz ?? null,
        level: need(`l${i + 1}`, 'gain').gain, filtered: routedTo(`l${i + 1}`, 'lp'),
      };
    }
    p.noise = { color: need('n', 'noise').color, level: need('ln', 'gain').gain, filtered: routedTo('ln', 'lp') };
    const lp = need('lp', 'filter');
    p.filter = { mode: lp.mode, freq: lp.freq, q: lp.q, key_track: lp.key_track ?? 0 };
    p.drive = by.has('drv') ? need('drv', 'shaper').drive : 0;
    p.aenv = envOf('aenv');
    p.fenv = { ...envOf('fenv'), amount: by.get('fenv').amount };
    p.penv = { ...envOf('penv'), amount: by.get('penv').amount };
    const lfo = need('lfo', 'osc');
    p.lfo = {
      wave: lfo.wave, rate: lfo.fixed_hz, pitch: need('lfo_p', 'gain').gain,
      cutoff: need('lfo_c', 'gain').gain, amp: need('lfo_a', 'gain').gain,
    };
    // Anything the template would not regenerate identically (extra nodes, rewired edges) is "custom".
    return canonical(buildInstrument(inst.id, p)) === canonical(inst) ? p : null;
  } catch {
    return null;
  }
}
