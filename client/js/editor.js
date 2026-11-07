// Instrument panel (no graph editing yet): preset picker, level sliders, remove.
import { h, clear } from './dom.js';

let presetCache = null;

export async function loadPresets() {
  if (presetCache) return presetCache;
  const names = await (await fetch('presets/index.json')).json();
  const entries = await Promise.all(
    names.map(async (n) => [n, await (await fetch(`presets/${n}.json`)).json()]),
  );
  presetCache = new Map(entries);
  return presetCache;
}

function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}${i}`.slice(0, 32);
    if (!taken.has(id)) return id;
  }
}

export class InstrumentPanel {
  /**
   * @param {HTMLElement} root
   * @param {{maxInstruments:number,maxLanes:number,getOrders:()=>import('./types.js').Orders,
   *   onChange:()=>void,presets:Map<string,any>}} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.o = opts;
    this.pick = 'bass';
    this.render();
  }

  addPreset(key) {
    const orders = this.o.getOrders();
    if (orders.instruments.length >= this.o.maxInstruments) return;
    const p = this.o.presets.get(key);
    if (!p) return;
    const inst = structuredClone(p.instrument);
    inst.id = uniqueId(key, new Set(orders.instruments.map((i) => i.id)));
    orders.instruments.push(inst);
    if (orders.lanes.length < this.o.maxLanes) orders.lanes.push({ instrument: inst.id, steps: [] });
    this.o.onChange();
    this.render();
    this.o.onStructure?.();
  }

  remove(id) {
    const orders = this.o.getOrders();
    orders.instruments = orders.instruments.filter((i) => i.id !== id);
    orders.lanes = orders.lanes.filter((l) => l.instrument !== id);
    this.o.onChange();
    this.render();
    this.o.onStructure?.();
  }

  slider(inst, field, label) {
    return h('label.slider', h('span', label),
      h('input', {
        type: 'range', min: '0', max: '1', step: '0.01', value: String(inst[field]),
        oninput: (e) => { inst[field] = parseFloat(e.target.value); this.o.onChange(); },
      }));
  }

  render() {
    const orders = this.o.getOrders();
    clear(this.root);
    const full = orders.instruments.length >= this.o.maxInstruments;
    const list = h('div.instruments');
    for (const inst of orders.instruments) {
      list.append(h('div.instrument',
        h('div.instrument-head', h('strong', inst.id),
          h('button.icon', { title: 'Remove instrument', onclick: () => this.remove(inst.id) }, '×')),
        this.slider(inst, 'gain', 'level'),
        this.slider(inst, 'send_delay', 'delay'),
        this.slider(inst, 'send_reverb', 'reverb')));
    }
    if (!orders.instruments.length) list.append(h('p.muted', 'No instruments yet. Pick a preset below.'));

    const sel = h('select', { onchange: (e) => { this.pick = e.target.value; } },
      [...this.o.presets].map(([k, p]) => h('option', { value: k, selected: k === this.pick }, p.label ?? k)));
    this.root.append(list,
      h('div.preset-picker', sel,
        h('button', { disabled: full, onclick: () => this.addPreset(this.pick) },
          full ? `Limit ${this.o.maxInstruments} reached` : 'Add instrument')),
      orders.instruments.length && orders.lanes.length < this.o.maxLanes
        ? h('button.link', { onclick: () => {
            orders.lanes.push({ instrument: orders.instruments[0].id, steps: [] });
            this.o.onChange(); this.o.onStructure?.();
          } }, '+ add lane')
        : null);
  }
}
