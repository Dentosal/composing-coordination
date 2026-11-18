// Tracker-style pattern editor: one column per lane, one row per loop row.
import { h, clear } from './dom.js';
import { icon } from './icons.js';

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
export const noteName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

// Piano-style keyboard: semitone offsets from the current octave's C.
const KEYMAP = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ',': 12, l: 13, '.': 14, ';': 15, '/': 16,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24, 9: 25, o: 26, 0: 27, p: 28,
};

/** Shared by every editor instance, so a copy survives switching tracks and rebuilding the screen. */
let clipboard = null; // {rows, lanes: [[{row, note, vel}]]}, rows relative to the copied block

const UNDO_LIMIT = 200;
const STEPS = [0, 1, 2, 3, 4, 6, 8];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class PatternEditor {
  /**
   * @param {HTMLElement} root
   * @param {{totalRows:number,rowsPerBar:number,maxLanes:number,
   *   getOrders:()=>import('./types.js').Orders, onChange:()=>void, onSpace?:()=>void,
   *   onSelect?:()=>void, onVolume?:()=>void,
   *   onAudition?:(lane:number, note:number, vel:number)=>void,
   *   isMuted?:(id:string)=>boolean, isSolo?:(id:string)=>boolean, isAudible?:(id:string)=>boolean,
   *   onToggleMute?:(id:string)=>void, onToggleSolo?:(id:string)=>void,
   *   isPads?:(id:string)=>boolean, onToggleView?:(id:string)=>void,
   *   onPlay?:(kind:'cursor'|'region', fromRow:number, toRow?:number)=>void}} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.o = opts;
    this.cur = { lane: 0, row: 0 };
    this.anchor = null; // other corner of the selection rectangle (null: no selection)
    this.octave = 3;
    this.vel = 100;
    this.step = 1; // rows the cursor advances after entering a note
    this.hear = true; // sound the active track's patch while entering notes
    this.undoStack = [];
    this.redoStack = [];
    this.drag = null;
    this.headDrag = null; // reordering a track by its header: {from, x, active, ins}
    this.paint = null; // pad-column painting in progress: {lane, last, mode, changed}
    this.lastNote = new Map(); // instrument id -> note most recently entered on its track (what a pad hit plays)
    this.rowEls = [];
    this.playRow = -1;
    this.grid = h('div.grid', { tabindex: '0', onkeydown: (e) => this.onKey(e) });
    this.bar = this.buildBar();
    this.status = h('div.pattern-status');
    this.help = h('div.pattern-help');
    this.msg = '';
    this.initMouse();
    root.append(this.bar, this.grid, this.status, this.help);
    this.render();
  }

  get orders() {
    return this.o.getOrders();
  }

  destroy() {
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
  }

  // ------------------------------------------------------------ toolbar

  buildBar() {
    const act = (fn) => () => { fn(); this.grid.focus({ preventScroll: true }); };
    const btn = (label, title, fn) => h('button.small', { type: 'button', title, onclick: act(fn) }, label);
    this.undoBtn = btn('↶ Undo', 'Undo (Ctrl+Z)', () => this.undo());
    this.redoBtn = btn('↷ Redo', 'Redo (Ctrl+Shift+Z)', () => this.redo());
    const stepSel = h('select', { title: 'Rows the cursor advances after each note',
      onchange: (e) => { this.step = Number(e.target.value); this.renderStatus(); this.grid.focus({ preventScroll: true }); } },
      STEPS.map((n) => h('option', { value: n, selected: n === this.step }, String(n))));
    const hear = h('label.check', h('input', { type: 'checkbox', checked: this.hear,
      onchange: (e) => { this.hear = e.target.checked; } }), 'hear notes');
    return h('div.pattern-bar',
      h('label', 'step', stepSel), hear,
      h('span.sep'), this.undoBtn, this.redoBtn,
      h('span.sep'),
      btn('Duplicate', 'Copy the selection (default: this bar) right below it (Ctrl+D)', () => this.duplicate()),
      btn('Repeat to end', 'Repeat the selection (default: this bar) to the end of the loop (Ctrl+E)', () => this.repeatToEnd()),
      btn('Clear track', 'Remove every note in the current track (undoable with Ctrl+Z)', () => this.clearTrack()),
      h('span.sep'),
      btn('−12', 'Transpose down an octave (Alt+Shift+↓)', () => this.transpose(-12)),
      btn('−1', 'Transpose down a semitone (Alt+↓)', () => this.transpose(-1)),
      btn('+1', 'Transpose up a semitone (Alt+↑)', () => this.transpose(1)),
      btn('+12', 'Transpose up an octave (Alt+Shift+↑)', () => this.transpose(12)),
      h('span.sep'),
      btn('▶ From cursor', 'Play the mix starting at the cursor row (Enter)', () => this.playFromCursor()),
      btn('↻ Loop selection', 'Loop the selected rows, or this bar (Shift+Enter)', () => this.playRegion()));
  }

  updateBar() {
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  // ------------------------------------------------------------ data

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

  /** True when the track is shown as pads (one hit per row) instead of text cells. Same data either way. */
  isPadLane(lane) {
    const l = this.orders.lanes[lane];
    return !!l && !!this.o.isPads?.(l.instrument);
  }

  /** The note a new pad hit gets: the last one typed on this track, else its first note, else C of the current octave. */
  hitNote(lane) {
    const l = this.orders.lanes[lane];
    return this.lastNote.get(l?.instrument) ?? l?.steps.find((s) => s.note != null)?.note ?? (this.octave + 1) * 12;
  }

  /** Keyboard: add a hit at the cursor with the track's hit note, or remove the one that is there. */
  toggleHit() {
    const { lane, row } = this.cur;
    const s = this.stepAt(lane, row);
    this.anchor = null;
    if (s && s.note != null) return this.edit(() => this.clearStep(lane, row), this.step);
    const note = this.hitNote(lane);
    this.edit(() => this.setStep(lane, row, note, this.vel), this.step);
    this.hearNote(lane, note, this.vel);
  }

  /** Start painting pad hits: pressing on a hit erases (and drags erase), on an empty pad adds; alt+click toggles an accent. */
  startPaint(c, accent) {
    const s = this.stepAt(c.lane, c.row);
    this.pushUndo();
    this.paint = { lane: c.lane, last: c.row, changed: false, mode: accent ? 'accent' : s && s.note != null ? 'erase' : 'paint' };
    this.paintCell(c.row, true);
  }

  paintCell(row, first) {
    const p = this.paint;
    const s = this.stepAt(p.lane, row);
    const on = !!s && s.note != null;
    const note = this.hitNote(p.lane);
    if (p.mode === 'erase') {
      if (s) { this.clearStep(p.lane, row); p.changed = true; }
    } else if (p.mode === 'paint') {
      if (!on) {
        this.setStep(p.lane, row, note, this.vel);
        p.changed = true;
        if (first) this.hearNote(p.lane, note, this.vel);
      }
    } else if (first) {
      if (on) s.vel = s.vel >= 127 ? this.vel : 127;
      else this.setStep(p.lane, row, note, 127);
      p.changed = true;
      this.hearNote(p.lane, s?.note ?? note, 127);
    }
    if (p.changed) this.o.onChange();
  }

  clearStep(lane, row) {
    const l = this.orders.lanes[lane];
    if (l) l.steps = l.steps.filter((s) => s.row !== row);
  }

  changed() {
    this.o.onChange();
    this.render();
  }

  // ---- undo / redo (note data only; instruments have their own controls)

  /** Keyed by instrument id, so undo/redo still lands on the right track after tracks were reordered. */
  snap() {
    return JSON.stringify(this.orders.lanes.map((l) => [l.instrument, l.steps]));
  }

  restore(snapshot) {
    const saved = new Map(JSON.parse(snapshot));
    this.orders.lanes.forEach((l) => { l.steps = saved.get(l.instrument) ?? []; });
  }

  pushUndo() {
    this.undoStack.push(this.snap());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Run a note-data edit as one undoable step, then redraw. `advance` moves the cursor down afterwards. */
  edit(fn, advance = 0) {
    this.pushUndo();
    fn();
    if (advance) this.cur.row = clamp(this.cur.row + advance, 0, this.o.totalRows - 1);
    this.changed();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snap());
    this.restore(this.undoStack.pop());
    this.flash('Undo');
    this.changed();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snap());
    this.restore(this.redoStack.pop());
    this.flash('Redo');
    this.changed();
  }

  // ---- selection

  get hasSel() {
    return !!this.anchor && (this.anchor.lane !== this.cur.lane || this.anchor.row !== this.cur.row);
  }

  /** The selected rectangle, or just the cursor cell. */
  rect() {
    const a = this.hasSel ? this.anchor : this.cur;
    const c = this.cur;
    return { l0: Math.min(a.lane, c.lane), l1: Math.max(a.lane, c.lane), r0: Math.min(a.row, c.row), r1: Math.max(a.row, c.row) };
  }

  /** The selection, or (for bar-wise operations) the cursor's bar in the cursor's lane. */
  blockRect() {
    if (this.hasSel) return this.rect();
    const rpb = this.o.rowsPerBar;
    const r0 = Math.floor(this.cur.row / rpb) * rpb;
    return { l0: this.cur.lane, l1: this.cur.lane, r0, r1: Math.min(r0 + rpb, this.o.totalRows) - 1 };
  }

  setSel(l0, r0, l1, r1) {
    this.anchor = { lane: l0, row: r0 };
    this.cur = { lane: l1, row: r1 };
  }

  inSel(lane, row) {
    if (!this.hasSel) return false;
    const { l0, l1, r0, r1 } = this.rect();
    return lane >= l0 && lane <= l1 && row >= r0 && row <= r1;
  }

  // ---- block operations

  capture({ l0, l1, r0, r1 }) {
    const lanes = [];
    for (let l = l0; l <= l1; l++) {
      lanes.push((this.orders.lanes[l]?.steps ?? []).filter((s) => s.row >= r0 && s.row <= r1)
        .map((s) => ({ row: s.row - r0, note: s.note, vel: s.vel })));
    }
    return { rows: r1 - r0 + 1, lanes };
  }

  clearRect({ l0, l1, r0, r1 }) {
    for (let l = l0; l <= l1; l++) {
      const lane = this.orders.lanes[l];
      if (lane) lane.steps = lane.steps.filter((s) => s.row < r0 || s.row > r1);
    }
  }

  /** Paste overwrites: the destination block is cleared first, then the copied steps go in (clipped to the loop). */
  pasteAt(clip, lane0, row0) {
    const total = this.o.totalRows;
    clip.lanes.forEach((steps, i) => {
      const lane = this.orders.lanes[lane0 + i];
      if (!lane) return;
      const end = Math.min(row0 + clip.rows, total);
      lane.steps = lane.steps.filter((s) => s.row < row0 || s.row >= end);
      for (const st of steps) if (row0 + st.row < total) lane.steps.push({ row: row0 + st.row, note: st.note, vel: st.vel });
      lane.steps.sort((a, b) => a.row - b.row);
    });
  }

  copy() {
    const rc = this.rect();
    clipboard = this.capture(rc);
    this.flash(`Copied ${rc.r1 - rc.r0 + 1} row(s) × ${rc.l1 - rc.l0 + 1} track(s)`);
  }

  cut() {
    const rc = this.rect();
    clipboard = this.capture(rc);
    this.flash(`Cut ${rc.r1 - rc.r0 + 1} row(s) × ${rc.l1 - rc.l0 + 1} track(s)`);
    this.edit(() => this.clearRect(rc));
  }

  paste() {
    if (!clipboard) return this.flash('Nothing copied yet');
    const { l0, r0 } = this.rect();
    const clip = clipboard;
    this.anchor = null;
    this.cur = { lane: l0, row: clamp(r0 + clip.rows, 0, this.o.totalRows - 1) };
    this.edit(() => this.pasteAt(clip, l0, r0));
  }

  /** Remove every step of the cursor's track. Undoable, so no confirmation. */
  clearTrack() {
    const lane = this.orders.lanes[this.cur.lane];
    if (!lane?.steps.length) return this.flash(`Track ${this.cur.lane + 1} is already empty`);
    const n = lane.steps.length;
    this.anchor = null;
    this.edit(() => { lane.steps = []; });
    this.flash(`Cleared track ${this.cur.lane + 1} (${n} step(s)). Ctrl+Z to undo`);
  }

  /** The block as text for messages: "track 1, rows 00-15". */
  describe({ l0, l1, r0, r1 }) {
    const rows = `rows ${String(r0).padStart(2, '0')}-${String(r1).padStart(2, '0')}`;
    return l0 === l1 ? `track ${l0 + 1}, ${rows}` : `tracks ${l0 + 1}-${l1 + 1}, ${rows}`;
  }

  /**
   * Copy the block (the selection, or the cursor's bar in the cursor's track) to directly below itself and select
   * that copy, so pressing it again lays out consecutive copies.
   */
  duplicate() {
    const rc = this.blockRect();
    const clip = this.capture(rc);
    if (rc.r1 + 1 >= this.o.totalRows) return this.flash('Duplicate: no room below the block');
    if (!clip.lanes.some((l) => l.length)) return this.flash(`Duplicate: ${this.describe(rc)} is empty, nothing to copy`);
    const to = rc.r1 + 1;
    this.pushUndo();
    this.pasteAt(clip, rc.l0, to);
    this.setSel(rc.l0, to, rc.l1, Math.min(this.o.totalRows - 1, rc.r1 + clip.rows));
    this.flash(`Duplicated ${this.describe(rc)} to rows ${String(to).padStart(2, '0')}-${String(Math.min(this.o.totalRows - 1, rc.r1 + clip.rows)).padStart(2, '0')}`);
    this.changed();
  }

  /**
   * Repeat the block (the selection, or the cursor's bar in the cursor's track) end to end until the loop runs out,
   * overwriting what is there. The whole filled span ends up selected.
   */
  repeatToEnd() {
    const rc = this.blockRect();
    const clip = this.capture(rc);
    if (rc.r1 + 1 >= this.o.totalRows) return this.flash('Repeat to end: the block already reaches the end of the loop');
    if (!clip.lanes.some((l) => l.length)) return this.flash(`Repeat to end: ${this.describe(rc)} is empty, nothing to repeat`);
    this.pushUndo();
    let copies = 0;
    for (let r = rc.r0 + clip.rows; r < this.o.totalRows; r += clip.rows) { this.pasteAt(clip, rc.l0, r); copies++; }
    this.setSel(rc.l0, rc.r0, rc.l1, this.o.totalRows - 1);
    this.flash(`Repeated ${this.describe(rc)} ${copies} more time(s), to the end of the loop`);
    this.changed();
  }

  transpose(delta) {
    const rc = this.rect();
    let n = 0;
    this.pushUndo();
    for (let l = rc.l0; l <= rc.l1; l++) {
      for (const st of this.orders.lanes[l]?.steps ?? []) {
        if (st.row < rc.r0 || st.row > rc.r1 || st.note == null) continue;
        st.note = clamp(st.note + delta, 0, 127);
        n++;
      }
    }
    if (!n) { this.undoStack.pop(); return this.flash('No notes to transpose'); }
    this.changed();
    const s = this.stepAt(this.cur.lane, this.cur.row);
    if (s?.note != null) this.hearNote(this.cur.lane, s.note, s.vel);
  }

  selectAll() {
    const rows = this.o.totalRows;
    const lanes = this.orders.lanes.length;
    const laneOnly = this.hasSel && this.rect().l0 === this.cur.lane && this.rect().l1 === this.cur.lane
      && this.rect().r0 === 0 && this.rect().r1 === rows - 1;
    if (laneOnly && lanes > 1) this.setSel(0, 0, lanes - 1, rows - 1);
    else this.setSel(this.cur.lane, 0, this.cur.lane, rows - 1);
    this.render();
  }

  // ---- playback hooks

  playFromCursor() {
    this.o.onPlay?.('cursor', this.cur.row);
  }

  playRegion() {
    const { r0, r1 } = this.blockRect();
    this.o.onPlay?.('region', r0, r1);
  }

  hearNote(lane, note, vel) {
    if (this.hear) this.o.onAudition?.(lane, note, vel);
  }

  // ------------------------------------------------------------ view helpers

  instOf(lane) {
    return this.orders.instruments.find((i) => i.id === lane.instrument);
  }

  nameOf(lane) {
    const i = this.instOf(lane);
    return i?.name || i?.id || '';
  }

  /** Refresh header names and volumes in place (after an edit made elsewhere); keeps focus and drags intact. */
  syncHeads() {
    this.grid.querySelectorAll('.lane-head').forEach((el, li) => {
      const lane = this.orders.lanes[li];
      if (!lane) return;
      const name = el.querySelector('.lane-name');
      if (name) { name.textContent = this.nameOf(lane); name.title = name.textContent; }
      const vol = el.querySelector('.lane-vol');
      const g = String(this.instOf(lane)?.gain ?? 0.8);
      if (vol && vol !== document.activeElement && vol.value !== g) vol.value = g;
    });
  }

  select(lane) {
    const moved = lane !== this.cur.lane;
    this.cur.lane = lane;
    this.anchor = null;
    this.render();
    this.grid.focus({ preventScroll: true });
    if (moved) this.o.onSelect?.();
  }

  /** Move the cursor. `extend` grows the selection instead of dropping it (and does not wrap between tracks). */
  move(dLane, dRow, extend = false) {
    const lanes = this.orders.lanes.length;
    if (!lanes) return;
    const before = this.cur.lane;
    if (extend) this.anchor ??= { ...this.cur };
    else this.anchor = null;
    this.cur.lane = extend ? clamp(this.cur.lane + dLane, 0, lanes - 1) : (this.cur.lane + dLane + lanes) % lanes;
    this.cur.row = clamp(this.cur.row + dRow, 0, this.o.totalRows - 1);
    this.render();
    if (this.cur.lane !== before) this.o.onSelect?.();
  }

  flash(text) {
    this.msg = text;
    clearTimeout(this.msgT);
    this.msgT = setTimeout(() => { this.msg = ''; this.renderStatus(); }, 2500);
    this.renderStatus();
  }

  // ------------------------------------------------------------ keyboard

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    const lane = this.cur.lane;
    const row = this.cur.row;
    const hasLane = this.orders.lanes.length > 0;
    let handled = true;

    if (mod && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'z': if (e.shiftKey) this.redo(); else this.undo(); break;
        case 'y': this.redo(); break;
        case 'c': this.copy(); break;
        case 'x': this.cut(); break;
        case 'v': this.paste(); break;
        case 'a': this.selectAll(); break;
        case 'd': this.duplicate(); break;
        case 'e': this.repeatToEnd(); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
      return;
    }
    if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      this.transpose((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1));
      e.preventDefault();
      return;
    }
    if (e.altKey) return;

    const ext = e.shiftKey;
    switch (e.key) {
      case 'ArrowUp': this.move(0, -1, ext); break;
      case 'ArrowDown': this.move(0, 1, ext); break;
      case 'ArrowLeft': this.move(-1, 0, ext); break;
      case 'ArrowRight': this.move(1, 0, ext); break;
      case 'Tab': this.move(e.shiftKey ? -1 : 1, 0); break;
      case 'PageUp': this.move(0, -this.o.rowsPerBar, ext); break;
      case 'PageDown': this.move(0, this.o.rowsPerBar, ext); break;
      case 'Home': this.anchor = ext ? (this.anchor ?? { ...this.cur }) : null; this.cur.row = 0; this.render(); break;
      case 'End': this.anchor = ext ? (this.anchor ?? { ...this.cur }) : null; this.cur.row = this.o.totalRows - 1; this.render(); break;
      case 'Escape': this.anchor = null; this.render(); break;
      case ' ': this.o.onSpace?.(); break;
      case 'Enter': if (e.shiftKey) this.playRegion(); else this.playFromCursor(); break;
      case 'Backspace':
      case 'Delete':
        if (!hasLane) break;
        if (this.hasSel) { const rc = this.rect(); this.edit(() => this.clearRect(rc)); } else this.edit(() => this.clearStep(lane, row), this.step);
        break;
      case '`':
      case '1':
        if (hasLane) { this.anchor = null; this.edit(() => this.setStep(lane, row, null, this.vel), this.step); }
        break;
      case 'a': if (hasLane) this.toggleHit(); break;
      case '[': this.octave = Math.max(0, this.octave - 1); this.renderStatus(); break;
      case ']': this.octave = Math.min(8, this.octave + 1); this.renderStatus(); break;
      case '-':
      case '=': {
        const d = e.key === '=' ? 8 : -8;
        this.vel = clamp(this.vel + d, 1, 127);
        if (this.hasSel) {
          const rc = this.rect();
          this.edit(() => {
            for (let l = rc.l0; l <= rc.l1; l++) {
              for (const st of this.orders.lanes[l]?.steps ?? []) {
                if (st.row >= rc.r0 && st.row <= rc.r1 && st.note != null) st.vel = clamp(st.vel + d, 1, 127);
              }
            }
          });
        } else {
          const s = this.stepAt(lane, row);
          if (s && s.note != null) this.edit(() => { s.vel = this.vel; }); else this.renderStatus();
        }
        break;
      }
      default: {
        const off = KEYMAP[e.key.toLowerCase()];
        if (off !== undefined && hasLane) {
          const note = Math.min(127, (this.octave + 1) * 12 + off);
          this.anchor = null;
          this.lastNote.set(this.orders.lanes[lane].instrument, note);
          this.edit(() => this.setStep(lane, row, note, this.vel), this.step);
          this.hearNote(lane, note, this.vel);
        } else handled = false;
      }
    }
    if (handled) e.preventDefault();
  }

  // ------------------------------------------------------------ mouse

  initMouse() {
    const cellAt = (e) => {
      const c = e.target instanceof Element ? e.target.closest('.cell') : null;
      return c ? { lane: Number(c.dataset.lane), row: Number(c.dataset.row) } : null;
    };
    this.grid.addEventListener('mousedown', (e) => {
      const c = cellAt(e);
      if (!c || e.button !== 0) return;
      // preventDefault: render() replaces this cell mid-click, and browsers that then run the default focus
      // step on the detached node (Safari, Firefox) leave the grid unfocused.
      e.preventDefault();
      const moved = c.lane !== this.cur.lane;
      if (e.shiftKey) {
        this.anchor ??= { ...this.cur };
      } else if (this.isPadLane(c.lane)) {
        this.anchor = null;
        this.startPaint(c, e.altKey);
      } else {
        this.anchor = null;
        this.drag = c;
      }
      this.cur = { ...c };
      this.render();
      this.grid.focus({ preventScroll: true });
      if (moved) this.o.onSelect?.();
    });
    this.grid.addEventListener('mouseover', (e) => {
      const p = this.paint;
      if (p) {
        const c = cellAt(e);
        if (!c || c.lane !== p.lane || c.row === p.last || p.mode === 'accent') return;
        const dir = Math.sign(c.row - p.last);
        for (let r = p.last + dir; ; r += dir) { // fill rows skipped by a fast drag
          this.paintCell(r, false);
          if (r === c.row) break;
        }
        p.last = c.row;
        this.cur = { lane: p.lane, row: c.row };
        this.render();
        return;
      }
      if (!this.drag) return;
      const c = cellAt(e);
      if (!c || (c.lane === this.cur.lane && c.row === this.cur.row)) return;
      const moved = c.lane !== this.cur.lane;
      this.anchor = { ...this.drag };
      this.cur = { ...c };
      this.render();
      if (moved) this.o.onSelect?.();
    });
    this.onMouseMove = (e) => this.onHeadDrag(e);
    window.addEventListener('mousemove', this.onMouseMove);
    this.onMouseUp = () => {
      const d = this.headDrag;
      this.headDrag = null;
      if (d?.active) {
        this.grid.classList.remove('reordering');
        const to = d.ins > d.from ? d.ins - 1 : d.ins;
        if (to !== d.from) this.moveTrack(d.from, to);
        else this.render();
      }
      if (this.paint && !this.paint.changed) this.undoStack.pop(); // a press that changed nothing is not an undo step
      this.paint = null;
      this.drag = null;
    };
    window.addEventListener('mouseup', this.onMouseUp);
  }

  /** Move track `from` to position `to` (lane and its instrument together); the numbers follow the new order. */
  moveTrack(from, to) {
    const o = this.orders;
    const [lane] = o.lanes.splice(from, 1);
    o.lanes.splice(to, 0, lane);
    const byId = new Map(o.instruments.map((i) => [i.id, i]));
    const ids = new Set(o.lanes.map((l) => l.instrument));
    o.instruments.splice(0, o.instruments.length,
      ...o.lanes.map((l) => byId.get(l.instrument)).filter(Boolean), ...o.instruments.filter((i) => !ids.has(i.id)));
    this.cur = { lane: to, row: this.cur.row }; // the cursor stays with the track you moved
    this.anchor = null;
    this.flash(`Moved track ${from + 1} to position ${to + 1}`);
    this.changed();
    this.o.onSelect?.();
  }

  /** Header drag: mark where the track would land (before the head under the pointer's left half). */
  onHeadDrag(e) {
    const d = this.headDrag;
    if (!d) return;
    if (!d.active) {
      if (Math.abs(e.clientX - d.x) < 6) return;
      d.active = true;
      this.grid.classList.add('reordering');
    }
    const heads = [...this.grid.querySelectorAll('.lane-head')];
    let ins = heads.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; });
    if (ins < 0) ins = heads.length;
    d.ins = ins;
    heads.forEach((el, i) => {
      el.classList.toggle('dragging', i === d.from);
      el.classList.toggle('drop-before', i === ins);
      el.classList.toggle('drop-after', ins === heads.length && i === heads.length - 1);
    });
  }

  /** Highlight the playing row (null clears). */
  setPlayhead(row) {
    if (row === this.playRow) return;
    this.rowEls[this.playRow]?.classList.remove('play');
    this.playRow = row ?? -1;
    this.rowEls[this.playRow]?.classList.add('play');
  }

  renderStatus() {
    const rc = this.rect();
    const sel = this.hasSel ? ` · selected ${rc.r1 - rc.r0 + 1} row(s) × ${rc.l1 - rc.l0 + 1} track(s)` : '';
    const base = `octave ${this.octave} · velocity ${this.vel} · step ${this.step}${sel}`;
    this.status.textContent = this.msg ? `${this.msg} · ${base}` : base; // a transient message never hides the selection
    this.help.textContent =
      'keys: z s x d c v … piano, q 2 w 3 e … upper octave · ` or 1 note-off · ⌫ clear · [ ] octave · - = velocity · ' +
      'shift+arrows or drag select · ctrl+c/x/v copy/cut/paste · ctrl+z undo · ctrl+d duplicate · ctrl+e repeat to end · ' +
      'drag a track header to reorder · pad tracks: click or drag to add/erase hits · alt+click accent · a toggle hit at cursor · ' +
      'alt+↑↓ transpose (+shift: octave) · enter play from cursor · shift+enter loop selection · space play/stop';
  }

  render() {
    const orders = this.orders;
    const lanes = orders.lanes;
    if (this.cur.lane >= lanes.length) this.cur.lane = Math.max(0, lanes.length - 1);
    const hadFocus = this.grid.contains(document.activeElement) || document.activeElement === this.grid;
    clear(this.grid);
    this.rowEls = [];
    this.grid.style.setProperty('--lanes', Math.max(1, lanes.length));

    const head = h('div.grid-row.head', h('div.rownum', ''));
    lanes.forEach((lane, li) => {
      const id = lane.instrument;
      const muted = !!this.o.isMuted?.(id);
      const solo = !!this.o.isSolo?.(id);
      const audible = this.o.isAudible ? this.o.isAudible(id) : true;
      const pads = !!this.o.isPads?.(id);
      const lbtn = (kind, title, pressed, ico, fn) => {
        const b = h('button', { type: 'button', class: `lane-btn ${kind}${pressed ? ' on' : ''}`, title, 'aria-label': title,
          'aria-pressed': String(pressed),
          onmousedown: (e) => e.stopPropagation(), // don't select the track / re-render before the click lands
          onclick: () => { fn(id); this.grid.focus({ preventScroll: true }); } }, icon(ico));
        return b;
      };
      head.append(
        h('div', { class: `lane-head${li === this.cur.lane ? ' active' : ''}${muted ? ' muted' : ''}${solo ? ' soloed' : ''}${audible ? '' : ' silent'}`,
          onmousedown: (e) => {
            e.preventDefault();
            if (e.button === 0) this.headDrag = { from: li, x: e.clientX, active: false, ins: li };
            this.select(li);
          } },
          h('strong', `Track ${li + 1}`),
          h('div.lane-name', { title: this.nameOf(lane) }, this.nameOf(lane)),
          h('input.lane-vol', { type: 'range', min: '0', max: '1', step: '0.01', title: 'Track volume',
            value: String(this.instOf(lane)?.gain ?? 0.8),
            // No selection / re-render on press: this slider must survive the drag.
            onmousedown: (e) => e.stopPropagation(),
            oninput: (e) => {
              const inst = this.instOf(lane);
              if (!inst) return;
              inst.gain = Number(e.target.value);
              this.o.onChange();
              this.o.onVolume?.();
            } }),
          h('div.lane-btns',
            lbtn('mute', muted ? 'Unmute track' : 'Mute track', muted, muted ? 'muted' : 'speaker', (i) => this.o.onToggleMute?.(i)),
            lbtn('solo', solo ? 'Stop listening only to this track' : 'Only listen to this track', solo, 'headphones', (i) => this.o.onToggleSolo?.(i)),
            lbtn('view', pads ? 'Show this track as note text' : 'Show this track as pads (one hit per row)', pads, 'pads', (i) => this.o.onToggleView?.(i)))),
      );
    });
    this.grid.append(head);

    const padLane = lanes.map((l) => !!this.o.isPads?.(l.instrument));
    const rpb = this.o.rowsPerBar / 4;
    for (let r = 0; r < this.o.totalRows; r++) {
      const row = h('div.grid-row', { class: [r % this.o.rowsPerBar === 0 ? 'bar' : '', r % rpb === 0 ? 'beat' : ''].join(' ') },
        h('div.rownum', String(r).padStart(2, '0')));
      lanes.forEach((lane, li) => {
        const s = lane.steps.find((x) => x.row === r);
        let text = '··· ···';
        let cls = 'cell';
        if (padLane[li]) { // pads: the cell is drawn by CSS (a bar whose strength follows the velocity)
          text = '';
          cls += ' pad';
          if (s) cls += s.note == null ? ' off' : ' hit';
        } else if (s) {
          if (s.note == null) { text = 'OFF'; cls += ' off'; }
          else { text = `${noteName(s.note)} ${String(s.vel).padStart(3, ' ')}`; cls += ' note'; }
        }
        if (li === this.cur.lane) cls += r === this.cur.row ? ' cur' : ' laneact';
        if (this.inSel(li, r)) cls += ' sel';
        if (this.o.isAudible && !this.o.isAudible(lane.instrument)) cls += ' silent';
        const cell = h('div', { class: cls }, text);
        if (padLane[li] && s) {
          cell.style.setProperty('--v', String(s.vel / 127));
          cell.title = s.note == null ? 'note off' : `${noteName(s.note)} · velocity ${s.vel}`;
        }
        cell.dataset.lane = String(li);
        cell.dataset.row = String(r);
        row.append(cell);
      });
      this.rowEls.push(row);
      this.grid.append(row);
    }
    if (this.playRow >= 0) this.rowEls[this.playRow]?.classList.add('play');
    this.renderStatus();
    this.updateBar();
    if (hadFocus) this.grid.focus({ preventScroll: true });
    this.grid.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  }
}
