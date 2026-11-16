// Tracker-style pattern editor: one column per lane, one row per loop row.
import { h, clear } from './dom.js';
import { ensureLanes } from './editor.js';

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
export const noteName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

// Piano-style keyboard: semitone offsets from the current octave's C.
const KEYMAP = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ',': 12, l: 13, '.': 14, ';': 15, '/': 16,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24, 9: 25, o: 26, 0: 27, p: 28,
};

export class PatternEditor {
  /**
   * @param {HTMLElement} root
   * @param {{totalRows:number,rowsPerBar:number,maxLanes:number,
   *   getOrders:()=>import('./types.js').Orders, onChange:()=>void, onSpace?:()=>void}} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.o = opts;
    this.cur = { lane: 0, row: 0 };
    this.octave = 3;
    this.vel = 100;
    this.rowEls = [];
    this.playRow = -1;
    this.grid = h('div.grid', { tabindex: '0', onkeydown: (e) => this.onKey(e) });
    this.status = h('div.pattern-help');
    root.append(this.grid, this.status);
    this.render();
  }

  get orders() {
    return this.o.getOrders();
  }

  stepAt(lane, row) {
    return this.orders.lanes[lane]?.steps.find((s) => s.row === row);
  }

  setStep(lane, row, note, vel) {
    const l = this.orders.lanes[lane];
    if (!l) return;
    const existing = l.steps.find((s) => s.row === row);
    if (existing) {
      existing.note = note;
      existing.vel = vel;
    } else {
      l.steps.push({ row, note, vel });
      l.steps.sort((a, b) => a.row - b.row);
    }
  }

  clearStep(lane, row) {
    const l = this.orders.lanes[lane];
    if (l) l.steps = l.steps.filter((s) => s.row !== row);
  }

  changed() {
    this.o.onChange();
    this.render();
  }

  move(dLane, dRow) {
    const lanes = this.orders.lanes.length;
    if (!lanes) return;
    this.cur.lane = (this.cur.lane + dLane + lanes) % lanes;
    this.cur.row = Math.min(this.o.totalRows - 1, Math.max(0, this.cur.row + dRow));
    this.render();
  }

  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const lane = this.cur.lane;
    const row = this.cur.row;
    const hasLane = this.orders.lanes.length > 0;
    let handled = true;
    switch (e.key) {
      case 'ArrowUp': this.move(0, -1); break;
      case 'ArrowDown': this.move(0, 1); break;
      case 'ArrowLeft': this.move(-1, 0); break;
      case 'ArrowRight': this.move(1, 0); break;
      case 'Tab': this.move(e.shiftKey ? -1 : 1, 0); break;
      case 'PageUp': this.move(0, -this.o.rowsPerBar); break;
      case 'PageDown': this.move(0, this.o.rowsPerBar); break;
      case 'Home': this.cur.row = 0; this.render(); break;
      case 'End': this.cur.row = this.o.totalRows - 1; this.render(); break;
      case ' ': this.o.onSpace?.(); break;
      case 'Backspace':
      case 'Delete':
        if (hasLane) { this.clearStep(lane, row); this.changed(); this.move(0, 1); }
        break;
      case '`':
      case '1':
        if (hasLane) { this.setStep(lane, row, null, this.vel); this.changed(); this.move(0, 1); }
        break;
      case '[': this.octave = Math.max(0, this.octave - 1); this.renderStatus(); break;
      case ']': this.octave = Math.min(8, this.octave + 1); this.renderStatus(); break;
      case '-':
      case '=': {
        const d = e.key === '=' ? 8 : -8;
        this.vel = Math.min(127, Math.max(1, this.vel + d));
        const s = this.stepAt(lane, row);
        if (s && s.note != null) { s.vel = this.vel; this.changed(); } else this.renderStatus();
        break;
      }
      default: {
        const off = KEYMAP[e.key.toLowerCase()];
        if (off !== undefined && hasLane) {
          const note = Math.min(127, (this.octave + 1) * 12 + off);
          this.setStep(lane, row, note, this.vel);
          this.changed();
          this.move(0, 1);
        } else handled = false;
      }
    }
    if (handled) e.preventDefault();
  }

  /** Highlight the playing row (null clears). */
  setPlayhead(row) {
    if (row === this.playRow) return;
    this.rowEls[this.playRow]?.classList.remove('play');
    this.playRow = row ?? -1;
    this.rowEls[this.playRow]?.classList.add('play');
  }

  renderStatus() {
    this.status.textContent =
      `octave ${this.octave} · velocity ${this.vel} · keys: z s x d c v … piano, q 2 w 3 e … upper octave, ` +
      '` or 1 note-off, ⌫ clear, [ ] octave, - = velocity, arrows move, space play/stop';
  }

  render() {
    const orders = this.orders;
    ensureLanes(orders, this.o.maxLanes);
    const lanes = orders.lanes;
    if (this.cur.lane >= lanes.length) this.cur.lane = Math.max(0, lanes.length - 1);
    const hadFocus = this.grid.contains(document.activeElement) || document.activeElement === this.grid;
    clear(this.grid);
    this.rowEls = [];
    this.grid.style.setProperty('--lanes', Math.max(1, lanes.length));

    if (!lanes.length) {
      this.grid.append(h('div.empty', 'Add an instrument to start writing notes.'));
      this.renderStatus();
      return;
    }

    const head = h('div.grid-row.head', h('div.rownum', ''));
    lanes.forEach((lane, li) => {
      head.append(
        h('div.lane-head',
          h('select', { onchange: (e) => { lane.instrument = e.target.value; this.changed(); } },
            orders.instruments.map((i) => h('option', { value: i.id, selected: i.id === lane.instrument }, i.id)))),
      );
    });
    this.grid.append(head);

    const rpb = this.o.rowsPerBar / 4;
    for (let r = 0; r < this.o.totalRows; r++) {
      const row = h('div.grid-row', { class: [r % this.o.rowsPerBar === 0 ? 'bar' : '', r % rpb === 0 ? 'beat' : ''].join(' ') },
        h('div.rownum', String(r).padStart(2, '0')));
      lanes.forEach((lane, li) => {
        const s = lane.steps.find((x) => x.row === r);
        let text = '··· ···';
        let cls = 'cell';
        if (s) {
          if (s.note == null) { text = 'OFF'; cls += ' off'; }
          else { text = `${noteName(s.note)} ${String(s.vel).padStart(3, ' ')}`; cls += ' note'; }
        }
        if (li === this.cur.lane && r === this.cur.row) cls += ' cur';
        row.append(h('div', {
          class: cls,
          // preventDefault: render() replaces this cell mid-click, and browsers that then run the
          // default focus step on the detached node (Safari, Firefox) leave the grid unfocused.
          onmousedown: (e) => {
            e.preventDefault();
            this.cur = { lane: li, row: r };
            this.render();
            this.grid.focus({ preventScroll: true });
          },
        }, text));
      });
      this.rowEls.push(row);
      this.grid.append(row);
    }
    if (this.playRow >= 0) this.rowEls[this.playRow]?.classList.add('play');
    this.renderStatus();
    if (hadFocus) this.grid.focus({ preventScroll: true });
    this.grid.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }
}
