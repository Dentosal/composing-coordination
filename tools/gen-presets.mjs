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
  init: ['Init', {}],
  bass: ['Bass', {
    gain: 0.9, send_reverb: 0.05,
    osc: [{ level: 0.5 }, { wave: 'square', semitones: -12, level: 0.5 }, OFF],
    filter: { freq: 350, q: 4, key_track: 0.3 },
    fenv: { attack: 0.005, decay: 0.25, sustain: 0.2, release: 0.1, amount: 1800 },
    aenv: { attack: 0.005, decay: 0.2, sustain: 0.7, release: 0.1 },
  }],
  pad: ['Pad', {
    gain: 0.6, send_delay: 0.1, send_reverb: 0.45,
    osc: [{ detune: -9, level: 0.3 }, { detune: 9, level: 0.3 }, { wave: 'triangle', semitones: -12, level: 0.3 }],
    filter: { freq: 1100, q: 0.8, key_track: 0.4 },
    aenv: { attack: 0.6, decay: 0.5, sustain: 0.8, release: 1 },
  }],
  lead: ['Lead', {
    gain: 0.7, send_delay: 0.25, send_reverb: 0.2,
    osc: [{ wave: 'square', level: 0.35 }, { detune: 7, level: 0.35 }, OFF],
    filter: { freq: 2600, q: 1.5, key_track: 0.5 },
    aenv: { attack: 0.01, decay: 0.15, sustain: 0.7, release: 0.2 },
    lfo: { rate: 5.5, pitch: 12 },
  }],
  pluck: ['Pluck', {
    gain: 0.8, send_delay: 0.25, send_reverb: 0.2,
    osc: [{ level: 0.4 }, { wave: 'square', detune: 6, level: 0.4 }, OFF],
    filter: { freq: 500, q: 2, key_track: 0.4 },
    fenv: { attack: 0.002, decay: 0.18, sustain: 0, release: 0.1, amount: 4500 },
    aenv: { attack: 0.002, decay: 0.4, sustain: 0, release: 0.1 },
  }],
  kick: ['Kick', {
    gain: 1, send_reverb: 0, drive: 4, // drive flattens the sine's peaks: more body at the same peak level
    osc: [{ wave: 'sine', fixed_hz: 52, level: 1, filtered: false }, OFF, OFF],
    noise: { level: 0.3 }, // the click: noise through a lowpass that the filter envelope opens for ~15 ms
    filter: { freq: 120, q: 0.7, key_track: 0 },
    fenv: { attack: 0.001, decay: 0.015, sustain: 0, release: 0.02, amount: 6000 },
    penv: { attack: 0.001, decay: 0.07, sustain: 0, release: 0.05, amount: 3000 }, // 52 Hz up to ~290 Hz
    aenv: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.05 },
  }],
  snare: ['Snare', {
    gain: 0.8, send_reverb: 0.2,
    osc: [{ wave: 'triangle', fixed_hz: 190, level: 0.6, filtered: false }, OFF, OFF],
    noise: { level: 0.9 },
    filter: { mode: 'highpass', freq: 1500, q: 0.7, key_track: 0 },
    aenv: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 },
  }],
  hat: ['Hat', {
    gain: 0.6, send_reverb: 0.05,
    osc: [OFF, OFF, OFF],
    noise: { level: 0.8 },
    filter: { mode: 'highpass', freq: 7000, q: 0.7, key_track: 0 },
    aenv: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
  }],
};

const dir = new URL('../client/presets/', import.meta.url);
for (const [key, [label, over]] of Object.entries(presets)) {
  writeFileSync(new URL(`${key}.json`, dir), JSON.stringify({ label, instrument: buildInstrument(key, patch(over)) }, null, 1) + '\n');
}
writeFileSync(new URL('index.json', dir), JSON.stringify(Object.keys(presets)) + '\n');
