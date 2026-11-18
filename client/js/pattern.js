// Tracker-style pattern editor: one column per lane, one row per loop row.
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { helpButton } from './help.js';

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

/**
 * For a piano-roll track: the cells a note holds after its first one. A note lasts until the next step of the track
 * (a note or an off) or the end of the song. Returns Map row -> {span}, with `.spans` (start row -> span) for the
 * first cells; a span is {start, end, note, vel} with `end` exclusive.
 */
function heldCells(lane, totalRows) {
  const steps = lane.steps.filter((s) => s.row < totalRows).sort((a, b) => a.row - b.row);
  const held = new Map();
  held.spans = new Map();
  steps.forEach((s, i) => {
    if (s.note == null) return;
    const span = { start: s.row, end: steps[i + 1]?.row ?? totalRows, note: s.note, vel: s.vel };
    held.spans.set(s.row, span);
    for (let r = s.row + 1; r < span.end; r++) held.set(r, { span });
  });
  return held;
}

const key = (t) => h('kbd', t);
/** Contents of the roll's help dialog: what the mouse and keyboard do. */
const rollHelp = () => [
  h('h3', 'Mouse'),
  h('ul',
    h('li', 'Click a cell to put the cursor there; drag to select a block of cells.'),
    h('li', 'Hold ', key('Shift'), ' while clicking or dragging to paint hits (drag across tracks too). Click a hit to erase it. The "quick paint" box swaps these two.'),
    h('li', key('Alt'), ' + click places an off (✕) on a cell, or removes it. A note keeps sounding through empty cells until the next note or off.'),
    h('li', 'Piano-roll tracks: painting a run of cells draws one note with an off after it; typing a note adds an off after it (one edit step) unless that cell already has a note or an off.'),
    h('li', 'Drag a track label up or down to reorder the tracks.'),
    h('li', 'Drag across the bar numbers to loop a region: click the loop to clear it, drag it to move it, double-click a bar to loop that bar.')),
  h('h3', 'Entering notes'),
  h('ul',
    h('li', key('Z'), ' ', key('S'), ' ', key('X'), ' ', key('D'), ' ', key('C'), ' … are piano keys; the row above (', key('Q'), ' ', key('2'), ' ', key('W'), ' ', key('3'), ' …) is the next octave up.'),
    h('li', key('['), ' ', key(']'), ' change octave; ', key('-'), ' ', key('='), ' change velocity.'),
    h('li', key('`'), ' or ', key('1'), ' puts a note-off; ', key('A'), ' toggles a hit at the cursor; ', key('Backspace'), ' clears.')),
  h('h3', 'Selection and editing'),
  h('ul',
    h('li', key('Shift'), ' + arrows extend the selection; arrows otherwise move left/right in time and up/down between tracks.'),
    h('li', key('Ctrl'), ' + ', key('C'), ' / ', key('X'), ' / ', key('V'), ' copy, cut, paste; ', key('Ctrl'), ' + ', key('Z'), ' undoes.'),
    h('li', key('Ctrl'), ' + ', key('D'), ' duplicates the selection (or this bar) after itself; ', key('Ctrl'), ' + ', key('E'), ' repeats it to the end of the song.'),
    h('li', key('Alt'), ' + ', key('↑'), ' / ', key('↓'), ' transposes a semitone (add ', key('Shift'), ' for an octave).')),
  h('h3', 'Playback'),
  h('ul',
    h('li', key('Space'), ' plays or stops; ', key('Enter'), ' plays from the cursor; ', key('Shift'), ' + ', key('Enter'), ' loops the selection or this bar.')),
];
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
   *    *   onPlay?:(kind:'cursor'|'region', fromRow:number, toRow?:number)=>void}} opts
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
    // Mouse: by default click/drag selects and shift paints; "quick paint" swaps the two.
    this.paintMode = false;
    try { this.paintMode = localStorage.getItem('directPaint') === '1'; } catch {}
    this.drag = null; // selecting with the mouse: the cell the drag started on
    this.loop = this.o.getLoop?.() ?? null; // the loop region {from, to} (rows, inclusive), set by dragging on the bar numbers
    this.loopDrag = null; // a gesture on the bar numbers: {mode: 'new'|'move', start, orig, moved}
    this.undoStack = [];
    this.redoStack = [];
    this.headDrag = null; // reordering a track by its label: {from, y, active, ins}
    this.paint = null; // pad-column painting in progress: {lane, last, mode, changed}
    this.lastNote = new Map(); // instrument id -> note most recently entered on its track (what a pad hit plays)
    this.playRow = -1;
    this.bar = this.buildBar();
    this.status = h('div.pattern-status');
    this.msg = '';
    // The labels column stays put; only the steps (rollScroll) scroll sideways. Both persist across renders so the scroll position survives edits.
    this.rollLabels = h('div.roll-labels');
    this.rollScroll = h('div.roll-scroll');
    this.roll = h('div.roll', this.rollLabels, this.rollScroll);
    this.rollCols = []; // per step column of the drum roll: its cells, for the playhead
    this.initMouse();
    this.main = h('div.pattern-main', { tabindex: '0', onkeydown: (e) => this.onKey(e) }, this.roll); // takes the keyboard
    this.main.classList.toggle('paint-mode', this.paintMode);
    root.append(this.bar, this.main, this.status);
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
    const act = (fn) => () => { fn(); this.main.focus({ preventScroll: true }); };
    const btn = (label, title, fn) => h('button.small', { type: 'button', title, onclick: act(fn) }, label);
    this.undoBtn = btn('↶ Undo', 'Undo (Ctrl+Z)', () => this.undo());
    this.redoBtn = btn('↷ Redo', 'Redo (Ctrl+Shift+Z)', () => this.redo());
    const stepSel = h('select', { title: 'Rows the cursor advances after each note',
      onchange: (e) => { this.step = Number(e.target.value); this.renderStatus(); this.main.focus({ preventScroll: true }); } },
      STEPS.map((n) => h('option', { value: n, selected: n === this.step }, String(n))));
    const hear = h('label.check', h('input', { type: 'checkbox', checked: this.hear,
      onchange: (e) => { this.hear = e.target.checked; } }), 'hear notes');
    const direct = h('label.check', { title: 'Off: click or drag selects cells, shift+click or shift+drag paints hits (across steps and tracks). On: the other way round.' },
      h('input', { type: 'checkbox', checked: this.paintMode, onchange: (e) => {
        this.paintMode = e.target.checked;
        try { localStorage.setItem('directPaint', this.paintMode ? '1' : '0'); } catch {}
        this.main.classList.toggle('paint-mode', this.paintMode);
        this.renderStatus();
        this.main.focus({ preventScroll: true });
      } }), 'quick paint');
    return h('div.pattern-bar',
      h('label', 'step', stepSel), hear, direct,
      h('span.sep'), this.undoBtn, this.redoBtn,
      h('span.sep'),
      btn('Duplicate', 'Copy the selection (default: this bar of the track) to directly after it, to the right. Press again for the next copy (Ctrl+D)', () => this.duplicate()),
      btn('Repeat to end', 'Repeat the selection (default: this bar of the track) one copy after another to the end of the song (Ctrl+E)', () => this.repeatToEnd()),
      btn('Clear track', 'Remove every note in the current track (undoable with Ctrl+Z)', () => this.clearTrack()),
      h('span.sep'),
      btn('−12', 'Transpose down an octave (Alt+Shift+↓)', () => this.transpose(-12)),
      btn('−1', 'Transpose down a semitone (Alt+↓)', () => this.transpose(-1)),
      btn('+1', 'Transpose up a semitone (Alt+↑)', () => this.transpose(1)),
      btn('+12', 'Transpose up an octave (Alt+Shift+↑)', () => this.transpose(12)),
      h('span.sep'),
      btn('▶ From cursor', 'Play the mix starting at the cursor row (Enter). With a loop set (drag on the bar numbers), it loops that region.', () => this.playFromCursor()),
      helpButton({ title: 'Editing the track roll', label: 'Help: editing the track roll', body: rollHelp() }));
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

  /** The note a new pad hit gets: the last one typed on this track, else its first note, else C of the current octave. */
  hitNote(lane) {
    const l = this.orders.lanes[lane];
    return this.lastNote.get(l?.instrument) ?? l?.steps.find((s) => s.note != null)?.note ?? (this.octave + 1) * 12;
  }

  /** The lanes of rectangle `rc`. */
  lanesOf({ l0, l1 }) {
    return Array.from({ length: l1 - l0 + 1 }, (_, i) => l0 + i);
  }

  /** Keyboard: add a hit at the cursor with the track's hit note, or remove the one that is there. */
  toggleHit() {
    const { lane, row } = this.cur;
    const s = this.stepAt(lane, row);
    this.anchor = null;
    if (s && s.note != null) return this.edit(() => this.clearStep(lane, row), this.step);
    const note = this.hitNote(lane);
    this.edit(() => { this.setStep(lane, row, note, this.vel); this.offAfterStep(lane, row); }, this.step);
    this.hearNote(lane, note, this.vel);
  }

  /**
   * Piano-roll tracks, typed notes: the note lasts as long as the edit step (at least one row), so an off goes there,
   * unless that cell already has a note or an off. The next note typed at the cursor then simply replaces the off.
   */
  offAfterStep(lane, row) {
    const l = this.orders.lanes[lane];
    const at = row + Math.max(1, this.step);
    if (!this.isPianoRoll(l) || at >= this.o.totalRows || l.steps.some((s) => s.row === at)) return;
    this.setStep(lane, at, null, this.vel);
  }

  /**
   * Start painting hits: pressing on a hit erases (and the drag erases), on an empty cell adds. The drag may run
   * across steps and tracks alike.
   */
  startPaint(c) {
    const s = this.stepAt(c.lane, c.row);
    this.pushUndo();
    // cells/base: piano-roll tracks, see paintPianoRoll
    this.paint = { last: { ...c }, changed: false, mode: s && s.note != null ? 'erase' : 'paint', cells: new Map(), base: new Map() };
    this.paintCell(c.lane, c.row, true);
  }

  /** Continue a paint drag onto cell `c`, filling the cells a fast drag skipped on the straight line from the last one. */
  paintTo(c) {
    const p = this.paint;
    if (c.lane === p.last.lane && c.row === p.last.row) return;
    const dl = c.lane - p.last.lane;
    const dr = c.row - p.last.row;
    const n = Math.max(Math.abs(dl), Math.abs(dr));
    for (let i = 1; i <= n; i++) this.paintCell(Math.round(p.last.lane + (dl * i) / n), Math.round(p.last.row + (dr * i) / n), false);
    const moved = c.lane !== this.cur.lane;
    p.last = { ...c };
    this.cur = { ...c };
    this.render();
    if (moved) this.o.onSelect?.();
  }

  /** Alt+click: place an off (a step that ends the note) on the cell, or remove it if the cell already has one. */
  toggleOff(c) {
    const s = this.stepAt(c.lane, c.row);
    this.anchor = null;
    this.cur = { ...c };
    this.edit(() => {
      if (s && s.note == null) this.clearStep(c.lane, c.row);
      else this.setStep(c.lane, c.row, null, this.vel); // replaces a note that was there
    });
  }

  /**
   * Painting on a piano-roll track draws notes, not single steps: each unbroken run of painted cells becomes ONE note
   * at its first cell, with an off right after its last cell (unless that cell already has a note or an off).
   * The track's steps are rebuilt from how they were when the drag began, so extending a run never leaves stale offs.
   */
  paintPianoRoll(lane, row) {
    const p = this.paint;
    const l = this.orders.lanes[lane];
    if (!p.base.has(lane)) { p.base.set(lane, l.steps.map((s) => ({ ...s }))); p.cells.set(lane, new Set()); }
    p.cells.get(lane).add(row);
    const note = this.hitNote(lane);
    const total = this.o.totalRows;
    const runs = [];
    for (const r of [...p.cells.get(lane)].sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && r === last.hi + 1) last.hi = r;
      else runs.push({ lo: r, hi: r });
    }
    let steps = p.base.get(lane).map((s) => ({ ...s }));
    for (const { lo, hi } of runs) {
      steps = steps.filter((s) => s.row < lo || s.row > hi); // painting overwrites what was there
      steps.push({ row: lo, note, vel: this.vel });
    }
    for (const { hi } of runs) {
      if (hi + 1 < total && !steps.some((s) => s.row === hi + 1)) steps.push({ row: hi + 1, note: null, vel: this.vel });
    }
    l.steps = steps.sort((a, b) => a.row - b.row);
  }

  paintCell(lane, row, first) {
    const p = this.paint;
    const s = this.stepAt(lane, row);
    const on = !!s && s.note != null;
    const note = this.hitNote(lane);
    if (p.mode === 'paint' && this.isPianoRoll(this.orders.lanes[lane])) {
      this.paintPianoRoll(lane, row);
      p.changed = true;
      if (first) this.hearNote(lane, note, this.vel);
    } else if (p.mode === 'erase') {
      if (s) { this.clearStep(lane, row); p.changed = true; }
    } else if (p.mode === 'paint') {
      if (!on) {
        this.setStep(lane, row, note, this.vel);
        p.changed = true;
        if (first) this.hearNote(lane, note, this.vel);
      }
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
    const lanes = this.lanesOf({ l0, l1 }).map((l) => (this.orders.lanes[l]?.steps ?? [])
      .filter((s) => s.row >= r0 && s.row <= r1).map((s) => ({ row: s.row - r0, note: s.note, vel: s.vel })));
    return { rows: r1 - r0 + 1, lanes };
  }

  clearRect({ l0, l1, r0, r1 }) {
    for (const l of this.lanesOf({ l0, l1 })) {
      const lane = this.orders.lanes[l];
      if (lane) lane.steps = lane.steps.filter((s) => s.row < r0 || s.row > r1);
    }
  }

  /** Paste overwrites: the destination block is cleared first, then the copied steps go in (clipped to the song). */
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
    this.flash(`Copied ${rc.r1 - rc.r0 + 1} row(s) × ${this.lanesOf(rc).length} track(s)`);
  }

  cut() {
    const rc = this.rect();
    clipboard = this.capture(rc);
    this.flash(`Cut ${rc.r1 - rc.r0 + 1} row(s) × ${this.lanesOf(rc).length} track(s)`);
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
   * Copy the block (the selection, or the cursor's bar in the cursor's track) to directly after itself (in time) and select
   * that copy, so pressing it again lays out consecutive copies.
   */
  duplicate() {
    const rc = this.blockRect();
    const clip = this.capture(rc);
    if (rc.r1 + 1 >= this.o.totalRows) return this.flash('Duplicate: no room after the block');
    if (!clip.lanes.some((l) => l.length)) return this.flash(`Duplicate: ${this.describe(rc)} is empty, nothing to copy`);
    const to = rc.r1 + 1;
    this.pushUndo();
    this.pasteAt(clip, rc.l0, to);
    this.setSel(rc.l0, to, rc.l1, Math.min(this.o.totalRows - 1, rc.r1 + clip.rows));
    this.flash(`Duplicated ${this.describe(rc)} to rows ${String(to).padStart(2, '0')}-${String(Math.min(this.o.totalRows - 1, rc.r1 + clip.rows)).padStart(2, '0')}`);
    this.changed();
  }

  /**
   * Repeat the block (the selection, or the cursor's bar in the cursor's track) end to end until the song runs out,
   * overwriting what is there. The whole filled span ends up selected.
   */
  repeatToEnd() {
    const rc = this.blockRect();
    const clip = this.capture(rc);
    if (rc.r1 + 1 >= this.o.totalRows) return this.flash('Repeat to end: the block already reaches the end of the song');
    if (!clip.lanes.some((l) => l.length)) return this.flash(`Repeat to end: ${this.describe(rc)} is empty, nothing to repeat`);
    this.pushUndo();
    let copies = 0;
    for (let r = rc.r0 + clip.rows; r < this.o.totalRows; r += clip.rows) { this.pasteAt(clip, rc.l0, r); copies++; }
    this.setSel(rc.l0, rc.r0, rc.l1, this.o.totalRows - 1);
    this.flash(`Repeated ${this.describe(rc)} ${copies} more time(s), to the end of the song`);
    this.changed();
  }

  transpose(delta) {
    const rc = this.rect();
    let n = 0;
    this.pushUndo();
    for (const l of this.lanesOf(rc)) {
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

  /** True when the track is shown as a piano roll (a setting of its patch; the sound is the same). */
  isPianoRoll(lane) {
    return this.instOf(lane)?.piano_roll === true;
  }

  instOf(lane) {
    return this.orders.instruments.find((i) => i.id === lane.instrument);
  }

  nameOf(lane) {
    const i = this.instOf(lane);
    return i?.name || i?.id || '';
  }

  /** Refresh track names in place (after an edit made elsewhere); keeps focus and drags intact. */
  syncHeads() {
    this.roll.querySelectorAll('.roll-label[data-lane]').forEach((el) => {
      const lane = this.orders.lanes[Number(el.dataset.lane)];
      const name = el.querySelector('.roll-name');
      if (lane && name) { name.textContent = this.nameOf(lane); el.title = name.textContent; }
    });
  }

  select(lane) {
    const moved = lane !== this.cur.lane;
    this.cur.lane = lane;
    this.anchor = null;
    this.render();
    this.main.focus({ preventScroll: true });
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
    switch (e.key) { // time runs left to right and the tracks stack up and down
      case 'ArrowUp': this.move(-1, 0, ext); break;
      case 'ArrowDown': this.move(1, 0, ext); break;
      case 'ArrowLeft': this.move(0, -1, ext); break;
      case 'ArrowRight': this.move(0, 1, ext); break;
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
            for (const l of this.lanesOf(rc)) {
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
          this.edit(() => { this.setStep(lane, row, note, this.vel); this.offAfterStep(lane, row); }, this.step);
          this.hearNote(lane, note, this.vel);
        } else handled = false;
      }
    }
    if (handled) e.preventDefault();
  }

  // ------------------------------------------------------------ mouse

  initMouse() {
    const rollCellAt = (e) => {
      const c = e.target instanceof Element ? e.target.closest('.roll-cell') : null;
      return c ? { lane: Number(c.dataset.lane), row: Number(c.dataset.row) } : null;
    };
    // The bar numbers: drag to set a loop, click the loop to clear it, drag the loop to move it.
    const headRowAt = (e) => {
      const c = e.target instanceof Element ? e.target.closest('.roll-hcell') : null;
      return c ? Number(c.dataset.row) : null;
    };
    this.roll.addEventListener('mousedown', (e) => {
      const hr = headRowAt(e);
      if (hr == null || e.button !== 0) return;
      e.preventDefault();
      const lp = this.loop;
      const inside = !!lp && hr >= lp.from && hr <= lp.to;
      // Was a loop active before this click (or double-click)? The first click of a double-click may clear it.
      if (e.detail <= 1) this.loopBeforeClick = !!lp; // detail: 1 = first click, 2 = the second click of a double-click
      this.loopDrag = { mode: inside ? 'move' : 'new', start: hr, orig: lp && { ...lp }, moved: false };
      this.main.focus({ preventScroll: true });
    });
    this.roll.addEventListener('dblclick', (e) => { // double-click with no loop: loop the bar that was clicked
      const hr = headRowAt(e);
      if (hr == null || this.loopBeforeClick) return;
      const rpb = this.o.rowsPerBar;
      this.loop = { from: Math.floor(hr / rpb) * rpb, to: Math.min(Math.floor(hr / rpb) * rpb + rpb, this.o.totalRows) - 1 };
      this.o.onLoop?.(this.loop, true);
      this.render();
    });
    this.roll.addEventListener('mouseover', (e) => {
      const d = this.loopDrag;
      const hr = d && headRowAt(e);
      if (hr == null || hr === d.start) return;
      d.moved = true;
      if (d.mode === 'move') {
        const len = d.orig.to - d.orig.from;
        const from = clamp(d.orig.from + hr - d.start, 0, this.o.totalRows - 1 - len);
        this.loop = { from, to: from + len };
      } else {
        this.loop = { from: Math.min(d.start, hr), to: Math.max(d.start, hr) };
      }
      this.o.onLoop?.(this.loop, false);
      this.render();
    });
    this.roll.addEventListener('mousedown', (e) => {
      const c = rollCellAt(e);
      if (!c || e.button !== 0) return;
      e.preventDefault(); // render() replaces the cell mid-click
      const moved = c.lane !== this.cur.lane;
      if (e.altKey) { // an off note
        this.toggleOff(c);
        this.main.focus({ preventScroll: true });
        if (moved) this.o.onSelect?.();
        return;
      }
      if (this.paintMode !== e.shiftKey) { // painting: plain click in quick paint mode, shift+click otherwise
        this.anchor = null;
        this.startPaint(c);
      } else if (e.shiftKey) { // quick paint mode + shift: extend the selection from the cursor to here
        this.anchor ??= { ...this.cur };
      } else { // selecting: the click puts the cursor here, dragging grows a rectangle from it
        this.anchor = null;
        this.drag = c;
      }
      this.cur = { ...c };
      this.render();
      this.main.focus({ preventScroll: true });
      if (moved) this.o.onSelect?.();
    });
    this.roll.addEventListener('mouseover', (e) => {
      const c = rollCellAt(e);
      if (!c) return;
      if (this.paint) return this.paintTo(c);
      if (!this.drag || (c.lane === this.cur.lane && c.row === this.cur.row)) return;
      const moved = c.lane !== this.cur.lane;
      this.anchor = { ...this.drag };
      this.cur = { ...c };
      this.render();
      if (moved) this.o.onSelect?.();
    });
    this.onMouseMove = (e) => this.onHeadDrag(e);
    window.addEventListener('mousemove', this.onMouseMove);
    this.onMouseUp = () => {
      const ld = this.loopDrag;
      this.loopDrag = null;
      if (ld) {
        if (ld.mode === 'move' && !ld.moved) this.loop = null; // clicking the loop again turns it off
        if (ld.moved || ld.mode === 'move') {
          this.o.onLoop?.(this.loop, true);
          this.render();
        }
      }
      const d = this.headDrag;
      this.headDrag = null;
      if (d?.active) {
        this.main.classList.remove('reordering');
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

  /**
   * Track drag (a roll label, up and down): mark where the track would land. `ins` is the lane index it would be
   * inserted before (lane count: at the end).
   */
  onHeadDrag(e) {
    const d = this.headDrag;
    if (!d) return;
    if (!d.active) {
      if (Math.abs(e.clientY - d.y) < 6) return;
      d.active = true;
      this.main.classList.add('reordering');
    }
    const items = [...this.roll.querySelectorAll('.roll-row:not(.head)')];
    let k = items.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (k < 0) k = items.length;
    d.ins = k < items.length ? Number(items[k].dataset.lane) : Number(items[items.length - 1].dataset.lane) + 1;
    items.forEach((el, i) => {
      for (const m of [el, this.rollLabels.querySelector(`.roll-label[data-lane="${el.dataset.lane}"]`)]) { // the row and its label
        m?.classList.toggle('dragging', Number(el.dataset.lane) === d.from);
        m?.classList.toggle('drop-before', i === k);
        m?.classList.toggle('drop-after', k === items.length && i === items.length - 1);
      }
    });
  }

  /** Highlight the playing row (null clears). */
  setPlayhead(row) {
    if (row === this.playRow) return;
    this.playRow = row ?? -1;
    this.markRollPlayhead();
    this.followPlayhead();
  }

  /** While playing, scroll the roll when the playhead leaves the visible steps (back to the start when the loop wraps). */
  followPlayhead() {
    const cell = this.playRow >= 0 ? this.rollCols[this.playRow]?.[0] : null;
    if (!cell) return;
    const box = this.rollScroll.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    if (c.left >= box.left && c.right <= box.right) return;
    this.rollScroll.scrollLeft += c.left - box.left - 24; // land a little in from the left edge
  }

  /** Drum roll: the playing step's column. */
  markRollPlayhead() {
    for (const col of this.rollCols) for (const el of col) el.classList.remove('play');
    if (this.playRow >= 0) for (const el of this.rollCols[this.playRow] ?? []) el.classList.add('play');
  }

  /**
   * The track view (a "drum roll"): the whole song laid out horizontally, a row per track (bars, beats, steps). Click or drag
   * to paint hits (alt+click: place an off). Arrow keys: left/right in time, up/down between tracks.
   */
  renderRoll() {
    const rpb = this.o.rowsPerBar;
    const bars = Math.ceil(this.o.totalRows / rpb);
    const beat = rpb / 4;
    const tracks = this.orders.lanes.map((lane, li) => ({ lane, li }));
    this.rollCols = Array.from({ length: this.o.totalRows }, () => []);
    clear(this.rollLabels);
    clear(this.rollScroll);
    this.roll.style.setProperty('--beat', String(beat));
    this.rollLabels.append(h('div.roll-title', 'Tracks'));
    // Bars hold beat groups of `beat` steps: the groups and bars get the gaps, so every cell has the same width.
    const stepsOf = (row, fn) => {
      const body = h('div.roll-body');
      for (let b = 0; b < bars; b++) {
        const bar = h('div.roll-bar');
        for (let g = 0; g < 4; g++) {
          const group = h('div.roll-group');
          for (let c = 0; c < beat; c++) fn(group, b * rpb + g * beat + c, c === 0, g === 0 && c === 0, c === beat - 1, g === 3 && c === beat - 1);
          bar.append(group);
        }
        body.append(bar);
      }
      row.append(body);
    };
    const head = h('div.roll-row.head');
    const lp = this.loop;
    stepsOf(head, (group, r, beatStart, barStart) => {
      const bar = Math.floor(r / rpb) + 1;
      const n = (r % rpb) / beat + 1;
      const inLoop = !!lp && r >= lp.from && r <= lp.to;
      const cell = h('div', { class: `roll-hcell${barStart ? ' bar' : ''}${inLoop ? ' in-loop' : ''}`,
        title: inLoop ? 'Loop: click to clear it, drag to move it' : 'Drag across these to loop that region, double-click to loop the bar' },
        beatStart ? h('div.rc-text', h('span', barStart ? `${bar}` : `${bar}.${n}`)) : null);
      cell.dataset.row = String(r);
      group.append(cell);
    });
    this.rollScroll.append(head);
    for (const { lane, li } of tracks) {
      const held = this.isPianoRoll(lane) ? heldCells(lane, this.o.totalRows) : null;
      const id = lane.instrument;
      const audible = this.o.isAudible ? this.o.isAudible(id) : true;
      const state = `${li === this.cur.lane ? ' active' : ''}${audible ? '' : ' silent'}`;
      const label = h('div', { class: `roll-label${state}`,
        title: `${this.nameOf(lane)} (drag to reorder)`,
        onmousedown: (e) => {
          e.preventDefault();
          if (e.button === 0) this.headDrag = { from: li, x: e.clientX, y: e.clientY, axis: 'y', active: false, ins: li };
          this.select(li);
        } },
        h('strong', String(li + 1)), h('span.roll-name', this.nameOf(lane)), h('span.roll-btns', this.muteSoloBtns(id)));
      label.dataset.lane = String(li);
      this.rollLabels.append(label);
      const row = h('div', { class: `roll-row${state}` });
      row.dataset.lane = String(li);
      stepsOf(row, (group, r, _beatStart, _barStart, groupEnd, barEnd) => {
        const s = lane.steps.find((x) => x.row === r);
        let cls = 'roll-cell';
        if (s) cls += s.note == null ? ' off' : ' hit';
        // Piano roll tracks: the note's bar runs on through the cells until the next step (note or off), joined into one box.
        const hold = held?.get(r);
        if (hold) cls += ' hold';
        const span = s && s.note != null ? held?.spans.get(r) : hold?.span;
        if (span && r + 1 < span.end) cls += ' cont';
        if (groupEnd) cls += ' gend';
        if (barEnd) cls += ' bend';
        if (li === this.cur.lane && r === this.cur.row) cls += ' cur';
        if (this.inSel(li, r)) cls += ' sel';
        if (lp && r >= lp.from && r <= lp.to) cls += ' in-loop';
        const cell = h('div', { class: cls });
        cell.dataset.lane = String(li);
        cell.dataset.row = String(r);
        if (hold) {
          cell.title = `${noteName(hold.span.note)} · held from row ${hold.span.start} (to ${hold.span.end >= this.o.totalRows ? 'the end of the song' : `row ${hold.span.end}`})`;
          cell.style.setProperty('--a', `${Math.round((0.3 + 0.7 * hold.span.vel / 127) * 100)}%`);
          if (hold.span.vel < 70) cell.classList.add('soft');
        }
        if (s) {
          cell.title = s.note == null ? 'Off: ends the note (alt+click to remove)' : `${noteName(s.note)} · velocity ${s.vel}`;
          if (s.note == null) cell.append(h('div.rc-text', h('span.off-mark', '✕')));
          else {
            cell.style.setProperty('--a', `${Math.round((0.3 + 0.7 * s.vel / 127) * 100)}%`); // louder hits are brighter
            if (s.vel < 70) cell.classList.add('soft'); // the bright background needs dark text, the dim one light text
            cell.append(h('div.rc-text', h('span', noteName(s.note).replace('-', '')), h('span.rc-v', String(s.vel))));
          }
        }
        this.rollCols[r].push(cell);
        group.append(cell);
      });
      this.rollScroll.append(row);
    }
    this.markRollPlayhead();
  }

  renderStatus() {
    const rc = this.rect();
    const sel = this.hasSel ? ` · selected ${rc.r1 - rc.r0 + 1} row(s) × ${this.lanesOf(rc).length} track(s)` : '';
    const cs = this.stepAt(this.cur.lane, this.cur.row);
    const at = `track ${this.cur.lane + 1}, row ${this.cur.row}: ${cs ? (cs.note == null ? 'note off' : `${noteName(cs.note)} vel ${cs.vel}`) : 'empty'}`;
    const base = `${at} · octave ${this.octave} · velocity ${this.vel} · step ${this.step}${sel}`;
    this.status.textContent = this.msg ? `${this.msg} · ${base}` : base; // a transient message never hides the selection
  }

  /** A mute / solo button for a track label. */
  laneBtn(id, kind, title, pressed, ico, fn) {
    return h('button', { type: 'button', class: `lane-btn ${kind}${pressed ? ' on' : ''}`, title, 'aria-label': title,
      'aria-pressed': String(pressed),
      onmousedown: (e) => e.stopPropagation(), // don't select the track / re-render before the click lands
      onclick: () => { fn(id); this.main.focus({ preventScroll: true }); } }, icon(ico));
  }

  muteSoloBtns(id) {
    const muted = !!this.o.isMuted?.(id);
    const solo = !!this.o.isSolo?.(id);
    return [
      this.laneBtn(id, 'mute', muted ? 'Unmute track' : 'Mute track', muted, muted ? 'muted' : 'speaker', (i) => this.o.onToggleMute?.(i)),
      this.laneBtn(id, 'solo', solo ? 'Stop listening only to this track' : 'Only listen to this track', solo, 'headphones', (i) => this.o.onToggleSolo?.(i)),
    ];
  }

  render() {
    const lanes = this.orders.lanes;
    if (this.cur.lane >= lanes.length) this.cur.lane = Math.max(0, lanes.length - 1);
    const hadFocus = this.main.contains(document.activeElement);
    this.renderRoll();
    this.renderStatus();
    this.updateBar();
    if (hadFocus && document.activeElement !== this.main) this.main.focus({ preventScroll: true });
    this.roll.querySelector('.roll-cell.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
