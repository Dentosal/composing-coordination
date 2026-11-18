// Regenerates client/presets/*.json from the patch tables below (run: node tools/gen-presets.mjs).
// Presets are plain orders instruments built through the synth template (client/js/synth.js).
import { writeFileSync } from 'node:fs';
import { buildInstrument, defaultPatch } from '../client/js/synth.js';

const merge = (base, over) => {
  for (const [k, v] of Object.entries(over)) {
    if (Array.isArray(v)) base[k] = v.map((x, i) => (x && typeof x === 'object' ? merge(base[k][i], x) : x));
    else if (v && typeof v === 'object') base[k] = merge(base[k], v);
    else base[k] = v;
  }
  return base;
};
const patch = (over) => merge(defaultPatch(), over);
const OFF = { level: 0 };

const presets = {
  init: ['Init', 'Basic', {}],
  bass: ['Bass', 'Bass', {
    gain: 0.9, send_reverb: 0.05,
    osc: [{ level: 0.5 }, { wave: 'square', semitones: -12, level: 0.5 }, OFF],
    filter: { freq: 350, q: 4, key_track: 0.3 },
    fenv: { attack: 0.005, decay: 0.25, sustain: 0.2, release: 0.1, amount: 1800 },
    aenv: { attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.1 },
  }],
  pad: ['Pad', 'Pads & FX', {
    gain: 0.6, send_delay: 0.1, send_reverb: 0.45,
    osc: [{ unison: 5, spread: 14, level: 0.3 }, OFF, { wave: 'triangle', semitones: -12, level: 0.3 }],
    filter: { freq: 1100, q: 0.8, key_track: 0.4 },
    aenv: { attack: 0.6, decay: 0.5, sustain: 0.8, release: 1 },
  }],
  lead: ['Lead', 'Lead & Keys', {
    gain: 0.7, send_delay: 0.25, send_reverb: 0.2,
    osc: [{ wave: 'square', unison: 3, spread: 8, level: 0.35 }, { semitones: 0.07, unison: 3, spread: 8, level: 0.35 }, OFF],
    filter: { freq: 2600, q: 1.5, key_track: 0.5 },
    aenv: { attack: 0.01, decay: 0.15, sustain: 0.7, release: 0.2 },
    lfo: { rate: 5.5, pitch: 12 },
  }],
  pluck: ['Pluck', 'Lead & Keys', {
    gain: 0.8, send_delay: 0.25, send_reverb: 0.2,
    osc: [{ level: 0.4 }, { wave: 'square', semitones: 0.06, level: 0.4 }, OFF],
    filter: { freq: 500, q: 2, key_track: 0.4 },
    fenv: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.1, amount: 4500 },
    aenv: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.1 },
  }],
  kick: ['Kick', 'Drums', {
    gain: 1, send_reverb: 0, drive: 4, // drive flattens the sine's peaks: more body at the same peak level
    osc: [{ wave: 'sine', fixed_hz: 52, level: 1, route: 0 }, OFF, OFF],
    noise: { level: 0.3 }, // the click: noise through a lowpass that the filter envelope opens for ~15 ms
    filter: { freq: 120, q: 0.7, key_track: 0 },
    fenv: { attack: 0.001, decay: 0.015, sustain: 0, release: 0.02, amount: 6000 },
    penv: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.05, amount: 3000 }, // 52 Hz up to ~290 Hz
    aenv: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.05 },
  }],
  snare: ['Snare', 'Drums', {
    gain: 0.8, send_reverb: 0.2,
    osc: [{ wave: 'triangle', fixed_hz: 190, level: 0.6, route: 0 }, OFF, OFF],
    noise: { level: 0.9 },
    filter: { mode: 'highpass', freq: 1500, q: 0.7, key_track: 0 },
    aenv: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 },
  }],
  hat: ['Hat', 'Drums', {
    gain: 0.6, send_reverb: 0.05,
    osc: [OFF, OFF, OFF],
    noise: { level: 0.8 },
    filter: { mode: 'highpass', freq: 7000, q: 0.7, key_track: 0 },
    aenv: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
  }],
  openhat: ['Open hat', 'Drums', {
    gain: 0.6, send_reverb: 0.1,
    osc: [OFF, OFF, OFF],
    noise: { level: 0.8 },
    filter: { mode: 'highpass', freq: 7000, q: 0.7, key_track: 0 },
    aenv: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 },
  }],
  clap: ['Clap', 'Drums', {
    gain: 1, send_reverb: 0.3, drive: 3,
    osc: [OFF, OFF, OFF],
    noise: { level: 1 },
    filter: { mode: 'bandpass', freq: 1200, q: 0.8, key_track: 0 },
    aenv: { attack: 0.004, decay: 0.12, sustain: 0, release: 0.08 },
  }],
  tom: ['Tom', 'Drums', { // follows the note: play it low (C2-C3); the pitch sweeps up from the note
    gain: 1, send_reverb: 0.1, drive: 1.5,
    osc: [{ wave: 'sine', level: 1, route: 0 }, OFF, OFF],
    penv: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.05, amount: 1200 },
    aenv: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.08 },
  }],
  shaker: ['Shaker', 'Drums', {
    gain: 0.8, send_reverb: 0.05, drive: 2,
    osc: [OFF, OFF, OFF],
    noise: { level: 1 },
    filter: { mode: 'bandpass', freq: 6000, q: 0.8, key_track: 0 },
    aenv: { attack: 0.015, decay: 0.06, sustain: 0, release: 0.03 },
  }],
  sub: ['Sub bass', 'Bass', { // a bare sine whistles; drive and a darkened saw add harmonics so it also reads on small speakers
    gain: 0.6, send_reverb: 0, drive: 2.5,
    osc: [{ wave: 'sine', level: 0.8, route: 0 }, { level: 0.25 }, OFF],
    filter: { freq: 250, q: 0.7, key_track: 0.6 },
    aenv: { attack: 0.01, decay: 0.1, sustain: 1, release: 0.15 },
  }],
  wobble: ['Wobble bass', 'Bass', {
    gain: 0.6, send_reverb: 0.05, drive: 1.5,
    osc: [{ semitones: -0.08, level: 0.4 }, { semitones: 0.08, level: 0.4 }, { wave: 'square', semitones: -12, level: 0.4 }],
    filter: { freq: 900, q: 6, key_track: 0.2 }, // the LFO swings the cutoff 900 ± 700 Hz; keep it above 0
    aenv: { attack: 0.005, decay: 0.2, sustain: 0.9, release: 0.1 },
    lfo: { rate: 2, cutoff: 700 },
  }],
  stab: ['Stab', 'Lead & Keys', {
    gain: 0.7, send_delay: 0.3, send_reverb: 0.2,
    osc: [{ level: 0.35 }, { semitones: 0.12, level: 0.35 }, { semitones: 7, level: 0.25 }],
    filter: { freq: 800, q: 2, key_track: 0.5 },
    fenv: { attack: 0.002, decay: 0.2, sustain: 0, release: 0.1, amount: 3500 },
    aenv: { attack: 0.003, decay: 0.25, sustain: 0, release: 0.1 },
  }],
  organ: ['Organ', 'Lead & Keys', {
    gain: 0.8, send_reverb: 0.25,
    osc: [{ wave: 'sine', level: 0.3 }, { wave: 'sine', semitones: 12, level: 0.25 }, { wave: 'triangle', semitones: 19, level: 0.15 }],
    filter: { freq: 6000, q: 0.7, key_track: 0.5 },
    aenv: { attack: 0.008, decay: 0.1, sustain: 1, release: 0.08 },
    lfo: { rate: 6, pitch: 15 },
  }],
  fmkeys: ['FM Keys', 'Lead & Keys', { // osc 2 (2:1) frequency-modulates the sine carrier: an electric-piano-like tone with a bright bite
    gain: 0.8, send_delay: 0.1, send_reverb: 0.25,
    osc: [{ wave: 'sine', level: 0.5 }, { wave: 'sine', semitones: 12, level: 0 }, OFF],
    fm: { on: true, depth: 1.6 },
    filter: { freq: 6000, q: 0.7, key_track: 0.5 },
    aenv: { attack: 0.003, decay: 0.9, sustain: 0.25, release: 0.4 },
  }],
  bell: ['Bell', 'Lead & Keys', {
    gain: 0.9, send_delay: 0.2, send_reverb: 0.4,
    osc: [{ wave: 'sine', level: 0.35 }, { wave: 'sine', semitones: 12.08, level: 0.25 }, { wave: 'triangle', semitones: 28, level: 0.12 }],
    filter: { freq: 3000, q: 0.7, key_track: 0.6 },
    aenv: { attack: 0.002, decay: 1.5, sustain: 0, release: 1 },
  }],
  riser: ['Riser', 'Pads & FX', { // noise sweep: hold a long note, the filter and level build over ~2.5 s
    gain: 0.6, send_delay: 0.2, send_reverb: 0.4,
    osc: [OFF, OFF, OFF],
    noise: { level: 0.8 },
    filter: { freq: 300, q: 3, key_track: 0 },
    fenv: { attack: 2.5, decay: 0.5, sustain: 1, release: 0.3, amount: 9000 },
    aenv: { attack: 2.5, decay: 0.5, sustain: 1, release: 0.5 },
  }],
  // ---- presets that show off the newer features: unison, FM, the second filter, the waveshaper shapes and positions
  supersaw: ['Supersaw', 'Lead & Keys', { // unison: seven and five detuned saws, each spread a few cents either side
    gain: 0.75, send_delay: 0.2, send_reverb: 0.25,
    osc: [{ unison: 7, spread: 28, level: 0.45 }, { semitones: 12, unison: 5, spread: 18, level: 0.2 }, OFF],
    filter: { freq: 3500, q: 0.8, key_track: 0.6 },
    fenv: { attack: 0.005, decay: 0.4, sustain: 0.6, release: 0.2, amount: 2500 },
    aenv: { attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.35 },
    lfo: { rate: 5.2, pitch: 6 },
  }],
  fmbell: ['FM Bell', 'Lead & Keys', { // FM: a 3.5:1 modulator (21.69 semitones up) is inharmonic and metallic; the filter envelope lets the brightness die away
    gain: 0.8, send_delay: 0.25, send_reverb: 0.5,
    osc: [{ wave: 'sine', level: 0.5 }, { wave: 'sine', semitones: 21.69, level: 0 }, { wave: 'sine', semitones: 12, level: 0.1 }],
    fm: { on: true, depth: 1.3 },
    filter: { freq: 1400, q: 0.7, key_track: 0.7 },
    fenv: { attack: 0.002, decay: 1.4, sustain: 0, release: 0.5, amount: 7000 },
    aenv: { attack: 0.002, decay: 2.2, sustain: 0, release: 0.8 },
  }],
  fmbass: ['FM Bass', 'Bass', { // FM: osc 2 (1:1, silent itself) modulates the sine; the filter envelope makes the growl die away
    gain: 1, send_reverb: 0.05,
    osc: [{ wave: 'sine', level: 0.8 }, { wave: 'sine', level: 0 }, { wave: 'sine', semitones: -12, level: 0.35 }],
    fm: { on: true, depth: 3.2 },
    filter: { freq: 700, q: 1.2, key_track: 0.4 },
    fenv: { attack: 0.003, decay: 0.3, sustain: 0.15, release: 0.1, amount: 3500 },
    aenv: { attack: 0.003, decay: 0.4, sustain: 0.5, release: 0.12 },
  }],
  acid: ['Acid', 'Bass', { // filters in series with the waveshaper between them: a squelchy lowpass, a hard clip, then a highpass that trims the rumble
    gain: 0.65, send_reverb: 0.05,
    osc: [{ level: 0.6 }, { wave: 'square', semitones: -12, level: 0 }, OFF],
    filterMode: 'serial', shaperPos: 'mid', shape: 'hard', drive: 4,
    filter: { freq: 280, q: 9, key_track: 0.5 },
    filter2: { mode: 'highpass', freq: 90, q: 0.7, key_track: 0 },
    fenv: { attack: 0.003, decay: 0.2, sustain: 0.1, release: 0.08, amount: 3500 },
    aenv: { attack: 0.003, decay: 0.25, sustain: 0.5, release: 0.08 },
  }],
  tubebass: ['Tube Bass', 'Bass', { // waveshaper, asymmetric: the two halves of the wave clip differently, which adds warm even harmonics
    gain: 1, send_reverb: 0.05,
    osc: [{ wave: 'triangle', level: 0.7 }, { semitones: -12, level: 0.25 }, OFF],
    drive: 3, shape: 'asym', shapeParam: 0.6,
    filter: { freq: 700, q: 0.8, key_track: 0.4 },
    aenv: { attack: 0.004, decay: 0.3, sustain: 0.6, release: 0.12 },
  }],
  foldlead: ['Fold Lead', 'Lead & Keys', { // waveshaper, foldback: the triangle folds back on itself, more drive and more metallic overtones
    gain: 0.55, send_delay: 0.2, send_reverb: 0.2,
    osc: [{ wave: 'triangle', level: 0.6 }, { wave: 'sine', semitones: 12, level: 0.15 }, OFF],
    drive: 3.5, shape: 'fold',
    filter: { freq: 5000, q: 0.8, key_track: 0.5 },
    fenv: { attack: 0.005, decay: 0.3, sustain: 0.5, release: 0.2, amount: 2500 },
    aenv: { attack: 0.01, decay: 0.2, sustain: 0.75, release: 0.25 },
    lfo: { rate: 5.5, pitch: 8 },
  }],
  chip: ['8-Bit Lead', 'Lead & Keys', { // waveshaper, bitcrush: square waves quantised to a few amplitude steps (the "bits" setting)
    gain: 0.4, send_delay: 0.15, send_reverb: 0.1,
    osc: [{ wave: 'square', level: 0.5 }, { wave: 'square', semitones: 12, level: 0.15 }, OFF],
    drive: 1.5, shape: 'crush', shapeParam: 4,
    filter: { freq: 9000, q: 0.7, key_track: 0.3 },
    aenv: { attack: 0.002, decay: 0.1, sustain: 0.8, release: 0.06 },
    lfo: { rate: 6, pitch: 10 },
  }],
  dualpad: ['Dual Filter Pad', 'Pads & FX', { // two filters side by side: the first saw through a dark lowpass, the second (an octave up) through a resonant bandpass; the slow LFO sweeps both
    gain: 0.85, send_delay: 0.15, send_reverb: 0.5,
    osc: [{ unison: 3, spread: 14, level: 0.3 }, { semitones: 12, unison: 3, spread: 12, level: 0.4, route: 2 }, OFF],
    filter: { freq: 650, q: 1.5, key_track: 0.3 },
    filter2: { mode: 'bandpass', freq: 1100, q: 5, key_track: 0.4 },
    lfo: { rate: 0.3, cutoff: 500 },
    aenv: { attack: 0.9, decay: 0.5, sustain: 0.85, release: 1.3 },
  }],
  wind: ['Wind', 'Pads & FX', { // routing: only noise, sent through filter 2 (a resonant bandpass); the LFO and the filter 2 envelope make it breathe
    gain: 1, send_delay: 0.2, send_reverb: 0.6,
    osc: [OFF, OFF, OFF],
    noise: { color: 'pink', level: 1, route: 2 },
    filter2: { mode: 'bandpass', freq: 800, q: 5, key_track: 0 },
    fenv2: { attack: 1.2, decay: 1, sustain: 0.6, release: 1.5, amount: 900 },
    lfo: { rate: 0.3, cutoff: 600 },
    aenv: { attack: 1.5, decay: 0.5, sustain: 0.9, release: 2 },
  }],
  // ---- sound effects: noise and tone sources shaped by filters, fast pitch envelopes and the LFO (held ones are piano-roll tracks, short hits are steps); similar sounds sit together in the menu: weather and water, animals, electronic, machines
  // -- weather and water
  rain: ['Rain', 'Sound FX', { // the noise level is the intensity. Noise through a lowpass, then a 1-bit bitcrusher (the shaper between the filters): the quantiser only lets the noise's peaks through, as random clicks (about 250 a second), which a bandpass turns into drop-like patter. A very slow LFO on the cutoffs makes the intensity drift like gusts; nothing in it repeats at a regular rate
    piano_roll: true,
    gain: 1, send_reverb: 0.6,
    osc: [OFF, OFF, OFF],
    noise: { color: 'white', level: 0.56 },
    filterMode: 'serial', shaperPos: 'mid', shape: 'crush', shapeParam: 1, drive: 1,
    filter: { mode: 'lowpass', freq: 11000, q: 0.7, key_track: 0 },
    filter2: { mode: 'bandpass', freq: 3200, q: 0.8, key_track: 0 },
    lfo: { wave: 'sine', rate: 0.07, cutoff: 1200 },
    aenv: { attack: 1.5, decay: 0.5, sustain: 1, release: 2 },
  }],
  thunder: ['Thunder', 'Sound FX', { // a low rumble of pink noise that opens for the crack and rolls on under a slow LFO, with a 38 Hz sine underneath
    piano_roll: true,
    gain: 0.85, send_reverb: 0.55,
    osc: [{ wave: 'sine', fixed_hz: 38, level: 0.5, route: 0 }, OFF, OFF],
    noise: { color: 'pink', level: 1 },
    drive: 3,
    filter: { freq: 200, q: 0.7, key_track: 0 },
    fenv: { attack: 0.02, decay: 1.2, sustain: 0.15, release: 1.5, amount: 900 },
    aenv: { attack: 0.04, decay: 2.5, sustain: 0.4, release: 2.5 },
    lfo: { rate: 0.8, amp: 0.25 },
  }],
  drop: ['Water Drop', 'Sound FX', { // a sine that starts an octave below and rises fast: the "bloop" of a bubble
    gain: 0.95, send_reverb: 0.45,
    osc: [{ wave: 'sine', semitones: 12, level: 0.8 }, OFF, OFF],
    penv: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.05, amount: -1200 },
    filter: { freq: 3000, q: 0.7, key_track: 0.5 },
    aenv: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.08 },
  }],
  // -- animals
  birdsong: ['Bird Song', 'Sound FX', { // three octaves up, each note a chirp: the pitch envelope rises and falls, a fast vibrato makes the trill
    gain: 0.9, send_delay: 0.15, send_reverb: 0.3,
    osc: [{ wave: 'sine', semitones: 36, level: 0.6 }, { wave: 'sine', semitones: 43, level: 0.15 }, OFF],
    penv: { attack: 0.035, decay: 0.09, sustain: 0, release: 0.05, amount: 1400 },
    filter: { freq: 9000, q: 0.7, key_track: 0.6 },
    lfo: { wave: 'triangle', rate: 22, pitch: 160 },
    aenv: { attack: 0.004, decay: 0.2, sustain: 0, release: 0.1 },
  }],
  squawk: ['Bird Squawk', 'Sound FX', { // two detuned saw "voices" through two parallel bandpass formants that sweep down, with breath noise through the first; the pitch rises then falls, and a fast LFO roughens the formants (a regular slow flutter is what made the first version sound robotic)
    gain: 1, send_delay: 0.05, send_reverb: 0.15,
    filterMode: 'parallel',
    osc: [{ wave: 'sawtooth', semitones: 24, unison: 3, spread: 22, level: 0.45 }, { wave: 'sawtooth', semitones: 24, unison: 3, spread: 28, level: 0.7, route: 2 }, OFF],
    noise: { color: 'pink', level: 0.32 },
    drive: 2.5, shape: 'asym', shapeParam: 0.5,
    penv: { attack: 0.04, decay: 0.45, sustain: 0, release: 0.05, amount: 500 },
    filter: { mode: 'bandpass', freq: 1150, q: 3, key_track: 0.3 },
    filter2: { mode: 'bandpass', freq: 2900, q: 2.5, key_track: 0.3 },
    fenv: { attack: 0.04, decay: 0.55, sustain: 0, release: 0.1, amount: 600 },
    fenv2: { attack: 0.04, decay: 0.55, sustain: 0, release: 0.1, amount: 1000 },
    aenv: { attack: 0.012, decay: 0.9, sustain: 0, release: 0.12 },
    lfo: { wave: 'sine', rate: 72, pitch: 18, cutoff: 300 },
  }],
  crickets: ['Crickets', 'Sound FX', { // two slightly mistuned high tones, pulsed fast by a square LFO into chirps
    piano_roll: true,
    gain: 0.5, send_reverb: 0.3,
    osc: [{ wave: 'sine', fixed_hz: 4400, level: 0.45, route: 0 }, { wave: 'sine', fixed_hz: 4460, level: 0.3, route: 0 }, OFF],
    lfo: { wave: 'square', rate: 16, amp: 0.5 },
    aenv: { attack: 0.3, decay: 0.1, sustain: 0.5, release: 0.5 },
  }],
  insects: ['Angry Insects', 'Sound FX', { // white noise through a highpass and then a lowpass (the filters in series) leaves the hiss band; a fast 17 Hz LFO on the cutoff makes it buzz like a swarm
    piano_roll: true,
    gain: 0.6, send_reverb: 0.35,
    osc: [OFF, OFF, OFF],
    noise: { color: 'white', level: 0.9 },
    filterMode: 'serial',
    filter: { mode: 'highpass', freq: 1200, q: 0.6, key_track: 0 },
    filter2: { mode: 'lowpass', freq: 9500, q: 0.6, key_track: 0 },
    lfo: { wave: 'triangle', rate: 17, cutoff: 500, amp: 0.1 },
    aenv: { attack: 1.2, decay: 0.5, sustain: 0.9, release: 1.5 },
  }],
  // -- electronic
  arcade: ['Arcade', 'Sound FX', { // squares through a bitcrusher; a sawtooth LFO on the pitch makes a stream of rising game blips
    piano_roll: true,
    gain: 0.5, send_delay: 0.2, send_reverb: 0.1,
    osc: [{ wave: 'square', level: 0.4 }, { wave: 'square', semitones: 7, level: 0.15 }, OFF],
    drive: 1.2, shape: 'crush', shapeParam: 5,
    filter: { freq: 7000, q: 0.7, key_track: 0.3 },
    lfo: { wave: 'sawtooth', rate: 5, pitch: 900 },
    aenv: { attack: 0.005, decay: 0.1, sustain: 1, release: 0.05 },
  }],
  beeps: ['Beeps', 'Sound FX', { // a square LFO gates the amplifier on and off (sustain 0.5 plus a depth of 0.5 swings between silence and full): steady computer beeps at the note's pitch
    piano_roll: true,
    gain: 0.45, send_delay: 0.2,
    osc: [{ wave: 'square', level: 0.5 }, { wave: 'square', semitones: 12, level: 0.12 }, OFF],
    drive: 1.2, shape: 'crush', shapeParam: 6,
    filter: { freq: 6000, q: 0.7, key_track: 0.4 },
    lfo: { wave: 'square', rate: 7, amp: 0.5 },
    aenv: { attack: 0.002, decay: 0.05, sustain: 0.5, release: 0.04 },
  }],
  laser: ['Laser', 'Sound FX', { // a saw that starts four octaves up and falls, with FM bite and a resonant filter that closes
    gain: 0.85, send_delay: 0.3, send_reverb: 0.1,
    osc: [{ wave: 'sawtooth', level: 0.5 }, { wave: 'sine', level: 0 }, OFF],
    fm: { on: true, depth: 1.5 },
    drive: 3, shape: 'hard',
    penv: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.05, amount: 4800 },
    filter: { freq: 1500, q: 6, key_track: 0.3 },
    fenv: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.05, amount: 3000 },
    aenv: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.08 },
  }],
  // -- machines
  siren: ['Siren', 'Sound FX', { // a triangle whose pitch swings up and down with a slow triangle LFO
    piano_roll: true,
    gain: 0.6, send_reverb: 0.3,
    osc: [{ wave: 'triangle', level: 0.6 }, { wave: 'square', level: 0.15 }, OFF],
    filter: { freq: 3000, q: 0.8, key_track: 0.5 },
    lfo: { wave: 'triangle', rate: 0.9, pitch: 900 },
    aenv: { attack: 0.2, decay: 0.2, sustain: 1, release: 0.3 },
  }],
  helicopter: ['Helicopter', 'Sound FX', { // noise chopped by a slow LFO (sustain 0.5 plus a depth of 0.5 swings between silence and full), with a 60 Hz thump
    piano_roll: true,
    gain: 1, send_reverb: 0.25,
    osc: [{ wave: 'sine', fixed_hz: 60, level: 0.35, route: 0 }, OFF, OFF],
    noise: { color: 'white', level: 0.9 },
    filter: { freq: 900, q: 0.8, key_track: 0 },
    lfo: { wave: 'triangle', rate: 11, amp: 0.5 },
    aenv: { attack: 0.5, decay: 0.2, sustain: 0.5, release: 0.8 },
  }],
};

const CATEGORIES = ['Basic', 'Drums', 'Bass', 'Lead & Keys', 'Pads & FX', 'Sound FX'];
const sorted = Object.entries(presets).sort((a, b) => CATEGORIES.indexOf(a[1][1]) - CATEGORIES.indexOf(b[1][1]));
const dir = new URL('../client/presets/', import.meta.url);
for (const [key, [label, category, spec]] of sorted) {
  // Sustained, pitched sounds are written as piano-roll tracks (notes drawn until the next note or off); drums and noise hits as steps. Init (the only Basic preset) is a piano-roll track too.
  // A sound effect says which it is with `piano_roll` (held ones such as rain: yes; short hits such as a chirp: no).
  const { piano_roll: roll, ...over } = spec;
  const pianoRoll = roll ?? ['Basic', 'Bass', 'Lead & Keys', 'Pads & FX'].includes(category);
  writeFileSync(new URL(`${key}.json`, dir), JSON.stringify({ label, category, instrument: buildInstrument(key, patch(over), undefined, pianoRoll) }, null, 1) + '\n');
}
writeFileSync(new URL('index.json', dir), JSON.stringify(sorted.map(([k]) => k)) + '\n');
