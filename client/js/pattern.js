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

  clearStep(lane, row) {
    const l = this.orders.lanes[lane];
    if (l) l.steps = l.steps.filter((s) => s.row !== row);
  }

  changed() {
    this.o.onChange();
    this.render();
  }

  // ---- undo / redo (note data only; instruments have their own controls)

  snap() {
    return JSON.stringify(this.orders.lanes.map((l) => l.steps));
  }

  restore(snapshot) {
    const steps = JSON.parse(snapshot);
    this.orders.lanes.forEach((l, i) => { l.steps = steps[i] ?? []; });
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
      if (!this.drag) return;
      const c = cellAt(e);
      if (!c || (c.lane === this.cur.lane && c.row === this.cur.row)) return;
      const moved = c.lane !== this.cur.lane;
      this.anchor = { ...this.drag };
      this.cur = { ...c };
      this.render();
      if (moved) this.o.onSelect?.();
    });
    this.onMouseUp = () => { this.drag = null; };
    window.addEventListener('mouseup', this.onMouseUp);
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
      const lbtn = (kind, title, pressed, ico, fn) => {
        const b = h('button', { type: 'button', class: `lane-btn ${kind}${pressed ? ' on' : ''}`, title, 'aria-label': title,
          'aria-pressed': String(pressed),
          onmousedown: (e) => e.stopPropagation(), // don't select the track / re-render before the click lands
          onclick: () => { fn(id); this.grid.focus({ preventScroll: true }); } }, icon(ico));
        return b;
      };
      head.append(
        h('div', { class: `lane-head${li === this.cur.lane ? ' active' : ''}${muted ? ' muted' : ''}${solo ? ' soloed' : ''}${audible ? '' : ' silent'}`,
          onmousedown: (e) => { e.preventDefault(); this.select(li); } },
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
            lbtn('solo', solo ? 'Stop listening only to this track' : 'Only listen to this track', solo, 'headphones', (i) => this.o.onToggleSolo?.(i)))),
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
        if (li === this.cur.lane) cls += r === this.cur.row ? ' cur' : ' laneact';
        if (this.inSel(li, r)) cls += ' sel';
        if (this.o.isAudible && !this.o.isAudible(lane.instrument)) cls += ' silent';
        const cell = h('div', { class: cls }, text);
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
