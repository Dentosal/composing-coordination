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
    osc: [{ wave: 'square', unison: 3, spread: 8, level: 0.35 }, { detune: 7, unison: 3, spread: 8, level: 0.35 }, OFF],
    filter: { freq: 2600, q: 1.5, key_track: 0.5 },
    aenv: { attack: 0.01, decay: 0.15, sustain: 0.7, release: 0.2 },
    lfo: { rate: 5.5, pitch: 12 },
  }],
  pluck: ['Pluck', 'Lead & Keys', {
    gain: 0.8, send_delay: 0.25, send_reverb: 0.2,
    osc: [{ level: 0.4 }, { wave: 'square', detune: 6, level: 0.4 }, OFF],
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
    osc: [{ detune: -8, level: 0.4 }, { detune: 8, level: 0.4 }, { wave: 'square', semitones: -12, level: 0.4 }],
    filter: { freq: 900, q: 6, key_track: 0.2 }, // the LFO swings the cutoff 900 ± 700 Hz; keep it above 0
    aenv: { attack: 0.005, decay: 0.2, sustain: 0.9, release: 0.1 },
    lfo: { rate: 2, cutoff: 700 },
  }],
  stab: ['Stab', 'Lead & Keys', {
    gain: 0.7, send_delay: 0.3, send_reverb: 0.2,
    osc: [{ level: 0.35 }, { detune: 12, level: 0.35 }, { semitones: 7, level: 0.25 }],
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
    osc: [{ wave: 'sine', level: 0.35 }, { wave: 'sine', semitones: 12, detune: 8, level: 0.25 }, { wave: 'triangle', semitones: 28, level: 0.12 }],
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
};

const CATEGORIES = ['Basic', 'Drums', 'Bass', 'Lead & Keys', 'Pads & FX'];
const sorted = Object.entries(presets).sort((a, b) => CATEGORIES.indexOf(a[1][1]) - CATEGORIES.indexOf(b[1][1]));
const dir = new URL('../client/presets/', import.meta.url);
for (const [key, [label, category, over]] of sorted) {
  // Sustained, pitched sounds are written as piano-roll tracks (notes drawn until the next note or off); drums and noise hits as steps. Init (the only Basic preset) is a piano-roll track too.
  const pianoRoll = ['Basic', 'Bass', 'Lead & Keys', 'Pads & FX'].includes(category);
  writeFileSync(new URL(`${key}.json`, dir), JSON.stringify({ label, category, instrument: buildInstrument(key, patch(over), undefined, pianoRoll) }, null, 1) + '\n');
}
writeFileSync(new URL('index.json', dir), JSON.stringify(sorted.map(([k]) => k)) + '\n');
