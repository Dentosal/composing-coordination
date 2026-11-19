// Tracker-style pattern editor: one column per lane, one row per loop row.
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { helpButton } from './help.js';
import { dragByHandle } from './draggable.js';
import { ARP_MAX_OFFSETS, ARP_TICKS_PER_ROW, DEFAULT_ARP, MAX_SLIDE, clearFx, fxAt, fxLabel, fxTitle, setFxField } from './fx.js';
import { MAX_FX_PARAMS, SLIDER_STEPS, accepts, automatable, describeParam, fromPosition, fromShown, ownValue, paramOf, pruneParams, toPosition, toShown } from './automation.js';

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
export const noteName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

// Piano-style keyboard: semitone offsets from the current octave's C.
const KEYMAP = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ',': 12, l: 13, '.': 14, ';': 15, '/': 16,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24, 9: 25, o: 26, 0: 27, p: 28,
};

/** Shared by every editor instance, so a copy survives switching tracks and rebuilding the screen. */
let clipboard = null; // {rows, domain: 'note'|'auto'|'both', lanes: [[item]], fx?: [[item]]}: the copied steps or effect cells (domain 'both': steps in `lanes`, effect cells in `fx`), rows relative to the copied block

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
/** Contents of the effect dialog's help: what each effect does. */
const effectsHelp = () => [
  'Effect cells (the thin lane above each track) change the notes that are sounding during their own row. A row is split into six ticks, and the effects below work in ticks.',
  h('h3', 'Editing'),
  h('ul',
    h('li', 'Select cells in an effect lane (click, drag, or shift+click) and this dialog edits them. Every control you change is written into all the selected cells; unticking a box removes that effect from them. "Clear effects" empties the selected cells.'),
    h('li', 'A cell shows one letter per effect: ', h('strong', 'V'), ' volume, ', h('strong', 'A'), ' arpeggio, ', h('strong', 'S'), ' slide, ', h('strong', 'C'), ' cut, ', h('strong', 'R'), ' retrigger, ', h('strong', 'P'), ' parameters. Hover a cell for the values.'),
    h('li', 'Cells copy, paste, delete, duplicate and repeat like notes (select effect cells first). Effects are saved with the track and heard in the preview and in the mix.')),
  h('h3', 'The effects'),
  h('ul',
    h('li', h('strong', 'Volume'), ': scales the level of the notes in that row, from 0 (silent) to 100%.'),
    h('li', h('strong', 'Arpeggio'), ': the pitch steps through up to four offsets in semitones, one per tick, six steps per row, and starts again at the next row. "0 4 7" is a major chord; one offset such as "12" just raises the row an octave.'),
    h('li', h('strong', 'Slide'), ': moves the pitch by this many semitones over the row (negative: down), reaching it at the last tick. The pitch stays there afterwards, and consecutive slide rows add up. A new note starts from its own pitch again.'),
    h('li', h('strong', 'Note cut'), ': silences the note sounding in the row at the chosen tick (0 to 5). Tick 0 on the row where a note starts means it is never heard.'),
    h('li', h('strong', 'Parameters'), ': sets up to three parameters of the track\'s instrument for that row (filter cutoff and resonance, oscillator and noise levels, LFO rate and depths, FM depth). In every row without an entry for a parameter it is back at the instrument\'s own value at once, and the loop starts there too, so give each row you want changed its own entry (select several cells to fill them together). A value is the parameter\'s own setting for the row, so envelopes and the LFO still add to it, and cutoffs follow the note\'s pitch like the instrument\'s own. "Glide" moves to the value over the row, starting where the row before left off. Pasting onto a track whose instrument lacks a parameter drops that entry.'),
    h('li', h('strong', 'Retrigger'), ': restarts the note every N ticks within the row (not at tick 0), each time with a fresh envelope. The previous restart is silenced, so a short interval gives a stuttering, gated sound.')),
  h('p.muted', 'Effects combine: a cell can hold all five at once, and a slide and an arpeggio add their pitch changes.'),
];

/** Contents of the roll's help dialog: what the track roll shows and what the mouse and keyboard do. */
const rollHelp = () => [
  'Each row is a track and time runs left to right: 16 steps to a bar, grouped by beat. A note lasts until the next note or off in its track, or until the end of the song. Above every track is a thinner effect lane.',
  h('h3', 'Mouse'),
  h('ul',
    h('li', 'Click a cell to put the cursor there; drag to select a block of cells.'),
    h('li', 'Hold ', key('Shift'), ' while clicking or dragging to paint notes (drag across tracks too). Clicking an existing note erases it. The "quick paint" box swaps what plain and shifted clicks do.'),
    h('li', key('Alt'), ' + click places an off (✕) on a cell, or removes it. Offs end the note that is sounding.'),
    h('li', 'Hold ', key('Alt'), ' while you drag (or ', key('Alt'), ' + ', key('Shift'), ' + click, or ', key('Alt'), ' + click an effect cell) to select the notes and the effect cells together. Delete, copy, cut, paste, duplicate and repeat then work on both. A copy holding both always pastes both, wherever you paste it; copy plain note cells or plain effect cells to paste just those.'),
    h('li', 'Drag a track label up or down to reorder the tracks. The speaker and headphones buttons on a label mute and solo the track.'),
    h('li', 'In sessions with unlimited tracks, the + beside "Tracks" adds a track, and the trash button next to "Load preset" deletes the selected one.')),
  h('h3', 'Entering notes'),
  h('ul',
    h('li', key('Z'), ' ', key('S'), ' ', key('X'), ' ', key('D'), ' ', key('C'), ' … are piano keys; the row above (', key('Q'), ' ', key('2'), ' ', key('W'), ' ', key('3'), ' …) is the next octave up. Each key puts a note at the cursor and moves on by the "step" setting; "hear notes" plays them as you type.'),
    h('li', key('['), ' ', key(']'), ' change octave; ', key('-'), ' ', key('='), ' change velocity.'),
    h('li', key('`'), ' or ', key('1'), ' puts an off; ', key('A'), ' toggles a note at the cursor; ', key('Backspace'), ' or ', key('Delete'), ' clears.')),
  h('h3', 'Piano-roll tracks'),
  h('ul',
    h('li', 'The "Piano roll" box next to a patch name draws each of its notes as one bar, from its first cell to the next note or off. The sound is the same; it just shows how long notes last.'),
    h('li', 'On a piano-roll track, painting a run of cells draws one note with an off after it, and typing a note adds an off one step later, unless that cell already has a note or an off.')),
  h('h3', 'Effects'),
  h('ul',
    h('li', 'The thin lane above each track holds effects: volume, arpeggio, slide, cut and retrigger. Click or drag across its cells to select them and the effect dialog opens; the ? in that dialog explains each effect. The "FX" box shows or hides the lanes.')),
  h('h3', 'Selecting and editing'),
  h('ul',
    h('li', key('Shift'), ' + arrows extend the selection; arrows otherwise move left and right in time and up and down between tracks. ', key('PageUp'), ' / ', key('PageDown'), ' jump a bar, ', key('Home'), ' / ', key('End'), ' go to the start and end, ', key('Ctrl'), ' + ', key('A'), ' selects the track (again: all tracks).'),
    h('li', key('Ctrl'), ' + ', key('C'), ' / ', key('X'), ' / ', key('V'), ' copy, cut, paste (copy one cell, select several and paste to fill them all). ', key('Ctrl'), ' + ', key('Z'), ' undoes, ', key('Ctrl'), ' + ', key('Shift'), ' + ', key('Z'), ' redoes.'),
    h('li', key('Ctrl'), ' + ', key('D'), ' duplicates the selection (or this bar) after itself; ', key('Ctrl'), ' + ', key('E'), ' repeats it to the end of the song.'),
    h('li', key('Alt'), ' + ', key('↑'), ' / ', key('↓'), ' transposes a semitone (add ', key('Shift'), ' for an octave).'),
    h('li', 'All of this works on the layer you selected: note cells, effect cells, or both (hold Alt). Copied effects can only be pasted onto effect cells or a combined selection, and transposing is for notes only.')),
  h('h3', 'Looping and playing'),
  h('ul',
    h('li', 'Drag across the bar numbers to loop a region. Click the loop to clear it, drag it to move it, or double-click a bar number to loop that whole bar. Playback loops the region while one is set.'),
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
   *   onAddTrack?:()=>void, canAddTrack?:()=>boolean, onBars?:(delta:number)=>void, getBars?:()=>number,
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
    this.showFx = true; // the effect (automation) lane above each track; the "FX" checkbox shows and hides them
    try { this.showFx = localStorage.getItem('showFx') !== '0'; } catch {}
    this.drag = null; // selecting with the mouse: the cell the drag started on
    // The cursor and selection live in one layer at a time: the note cells or the effect (automation) cells. A selection
    // that starts in one layer only ever covers cells of that layer.
    this.domain = 'note';
    this.adrag = null; // selecting effect cells with the mouse: the cell the drag started on
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
    this.effectInfo = h('p.effect-info');
    const effectHead = h('div.effect-head', { title: 'Drag to move' }, h('strong', 'Effect'),
      h('span.effect-head-btns', helpButton({ title: 'Effects', label: 'Help: effects', body: effectsHelp() }),
        h('button.small', { type: 'button', 'aria-label': 'Close the effect dialog', onclick: () => this.closeEffectDialog() }, '✕')));
    this.effectDlg = h('dialog.effect-dialog', { 'aria-label': 'Effect', onkeydown: (e) => e.stopPropagation() }, // typing in it must not drive the roll
      effectHead,
      this.effectInfo,
      this.buildEffectControls());
    dragByHandle(this.effectDlg, effectHead);
    this.main = h('div.pattern-main', { tabindex: '0', onkeydown: (e) => this.onKey(e) }, this.roll, this.effectDlg); // takes the keyboard
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
    const btn = (label, title, fn, aria = null) => h('button.small', { type: 'button', title, 'aria-label': aria, onclick: act(fn) }, label);
    this.undoBtn = btn('↶', 'Undo (Ctrl+Z)', () => this.undo(), 'Undo');
    this.redoBtn = btn('↷', 'Redo (Ctrl+Shift+Z)', () => this.redo(), 'Redo');
    const stepSel = h('select', { title: 'Rows the cursor advances after each note',
      onchange: (e) => { this.step = Number(e.target.value); this.renderStatus(); this.main.focus({ preventScroll: true }); } },
      STEPS.map((n) => h('option', { value: n, selected: n === this.step }, String(n))));
    const hear = h('label.check', h('input', { type: 'checkbox', checked: this.hear,
      onchange: (e) => { this.hear = e.target.checked; } }), 'hear notes');
    const fxChk = h('label.check', { title: 'Show the effect lane above each track' },
      h('input', { type: 'checkbox', checked: this.showFx, onchange: (e) => {
        this.showFx = e.target.checked;
        try { localStorage.setItem('showFx', this.showFx ? '1' : '0'); } catch {}
        if (!this.showFx) this.setDomain('note'); // a selection of hidden cells would be invisible: back to the notes
        this.render();
        this.main.focus({ preventScroll: true });
      } }), 'FX');
    const direct = h('label.check', { title: 'Off: click or drag selects cells, shift+click or shift+drag paints hits (across steps and tracks). On: the other way round.' },
      h('input', { type: 'checkbox', checked: this.paintMode, onchange: (e) => {
        this.paintMode = e.target.checked;
        try { localStorage.setItem('directPaint', this.paintMode ? '1' : '0'); } catch {}
        this.main.classList.toggle('paint-mode', this.paintMode);
        this.renderStatus();
        this.main.focus({ preventScroll: true });
      } }), 'quick paint');
    return h('div.pattern-bar',
      h('label', 'step', stepSel), hear, fxChk, direct,
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
    // An edit made outside the dialog (paste, delete, undo ...) can change what is selected or under the cursor.
    if (this.domain === 'auto' && this.effectDlg.open && !this.effectDlg.contains(document.activeElement)) this.refreshEffectDialog();
  }

  // ---- undo / redo (note data only; instruments have their own controls)

  /** Keyed by instrument id, so undo/redo still lands on the right track after tracks were reordered. */
  snap() {
    return JSON.stringify(this.orders.lanes.map((l) => [l.instrument, l.steps, l.fx ?? []]));
  }

  restore(snapshot) {
    const saved = new Map(JSON.parse(snapshot).map(([id, steps, fx]) => [id, { steps, fx }]));
    this.orders.lanes.forEach((l) => {
      const v = saved.get(l.instrument);
      if (!v) return; // a track added after the snapshot keeps what it has
      l.steps = v.steps;
      if (v?.fx?.length) l.fx = v.fx; else delete l.fx;
    });
    pruneParams(this.orders); // the instruments may have changed since the snapshot: no entries for nodes they no longer have
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

  /** Is the cell in the selection? Only cells of the layer (note / effect) the selection lives in can be; a 'both' selection (Alt) has both. */
  inSel(lane, row, domain = 'note') {
    if ((this.domain !== domain && this.domain !== 'both') || !this.hasSel) return false;
    const { l0, l1, r0, r1 } = this.rect();
    return lane >= l0 && lane <= l1 && row >= r0 && row <= r1;
  }

  // ---- block operations

  /** The layers the selection works on: 'note' (steps) and/or 'auto' (effect cells). Alt selects both. */
  get layers() {
    return this.domain === 'both' ? ['note', 'auto'] : [this.domain];
  }

  /** The items of one layer of a lane: its steps or its effect cells. */
  itemsOf(lane, layer) {
    return layer === 'auto' ? (lane.fx ?? []) : lane.steps;
  }

  setItemsOf(lane, layer, items) {
    if (layer === 'auto') {
      if (items.length) lane.fx = items; else delete lane.fx;
    } else lane.steps = items;
  }

  /** "notes", "effects" or "notes and effects": for messages. */
  get layerName() {
    return this.domain === 'both' ? 'notes and effects' : this.domain === 'auto' ? 'effects' : 'notes';
  }

  /** The block's items, rows relative to its first row. With notes and effects together the clipboard holds both. */
  capture({ l0, l1, r0, r1 }) {
    const layer = (name) => this.lanesOf({ l0, l1 }).map((l) => {
      const lane = this.orders.lanes[l];
      return lane ? this.itemsOf(lane, name).filter((it) => it.row >= r0 && it.row <= r1).map((it) => ({ ...structuredClone(it), row: it.row - r0 })) : [];
    });
    const clip = { rows: r1 - r0 + 1, lanes: layer(this.domain === 'auto' ? 'auto' : 'note'), domain: this.domain };
    if (this.domain === 'both') clip.fx = layer('auto');
    return clip;
  }

  /** Does the clipboard (or a captured block) hold anything? */
  clipHasItems(clip) {
    return clip.lanes.some((l) => l.length) || !!clip.fx?.some((l) => l.length);
  }

  clearRect({ l0, l1, r0, r1 }) {
    for (const l of this.lanesOf({ l0, l1 })) {
      const lane = this.orders.lanes[l];
      if (!lane) continue;
      for (const layer of this.layers) this.setItemsOf(lane, layer, this.itemsOf(lane, layer).filter((it) => it.row < r0 || it.row > r1));
    }
  }

  /**
   * Paste overwrites: the destination block is cleared first, then the copied items go in (clipped to the song). A clipboard
   * with notes and effects together pastes both, wherever it is pasted (onto note cells, effect cells or a combined selection).
   */
  pasteAt(clip, lane0, row0) {
    const held = clip.domain === 'both' ? { note: clip.lanes, auto: clip.fx } : { [clip.domain]: clip.lanes };
    for (const [layer, items] of Object.entries(held)) this.pasteLayer(layer, items, clip.rows, lane0, row0);
  }

  pasteLayer(layer, laneItems, rows, lane0, row0) {
    const total = this.o.totalRows;
    laneItems.forEach((items, i) => {
      const lane = this.orders.lanes[lane0 + i];
      if (!lane) return;
      const end = Math.min(row0 + rows, total);
      const next = this.itemsOf(lane, layer).filter((it) => it.row < row0 || it.row >= end);
      for (const it of items) {
        if (row0 + it.row >= total) continue;
        const copy = { ...structuredClone(it), row: row0 + it.row };
        if (layer === 'auto' && copy.params) { // a parameter the target track's instrument does not have cannot be kept
          const inst = this.instOf(lane);
          copy.params = copy.params.filter((e) => accepts(inst, e));
          if (!copy.params.length) delete copy.params;
          if (Object.keys(copy).every((k) => k === 'row')) continue; // nothing left in the cell
        }
        next.push(copy);
      }
      this.setItemsOf(lane, layer, next.sort((a, b) => a.row - b.row));
    });
  }

  copy() {
    const rc = this.rect();
    clipboard = this.capture(rc);
    this.flash(`Copied ${this.layerName}: ${rc.r1 - rc.r0 + 1} row(s) × ${this.lanesOf(rc).length} track(s)`);
  }

  cut() {
    const rc = this.rect();
    clipboard = this.capture(rc);
    this.flash(`Cut ${this.layerName}: ${rc.r1 - rc.r0 + 1} row(s) × ${this.lanesOf(rc).length} track(s)`);
    this.edit(() => this.clearRect(rc));
  }

  paste() {
    if (!clipboard) return this.flash('Nothing copied yet');
    // A combined selection takes anything, and a combined clipboard goes anywhere (it pastes both layers).
    if (clipboard.domain !== this.domain && clipboard.domain !== 'both' && this.domain !== 'both') {
      return this.flash(`That clipboard holds ${clipboard.domain === 'auto' ? 'effects' : 'notes'}: select ${clipboard.domain === 'auto' ? 'effect' : 'note'} cells to paste it`);
    }
    const rc = this.rect();
    const { l0, r0 } = rc;
    const clip = clipboard;
    // One copied cell pastes into every selected cell (also into an empty one: that clears them). The selection stays, so it
    // can be pasted again, or the selection changed. A larger clipboard pastes at the selection's first cell, as before.
    if (clip.rows === 1 && clip.lanes.length === 1 && (rc.l1 > rc.l0 || rc.r1 > rc.r0)) {
      const lanes = this.lanesOf(rc);
      this.edit(() => {
        for (const l of lanes) for (let r = rc.r0; r <= rc.r1; r++) this.pasteAt(clip, l, r);
      });
      this.flash(`Pasted into ${lanes.length * (rc.r1 - rc.r0 + 1)} cells`);
      return;
    }
    this.anchor = null;
    this.cur = { lane: l0, row: clamp(r0 + clip.rows, 0, this.o.totalRows - 1) };
    this.edit(() => this.pasteAt(clip, l0, r0));
  }

  /** Delete / Backspace: clear the selected cells (or the cursor cell, then move on by the edit step). */
  deleteCells() {
    if (this.hasSel) {
      const rc = this.rect();
      this.edit(() => this.clearRect(rc));
    } else {
      const { lane, row } = this.cur;
      this.edit(() => this.clearRect({ l0: lane, l1: lane, r0: row, r1: row }), this.step);
    }
  }

  /** Remove every note (or, in the effect layer, every effect) of the cursor's track. Undoable, so no confirmation. */
  clearTrack() {
    const lane = this.orders.lanes[this.cur.lane];
    const n = lane ? this.layers.reduce((sum, layer) => sum + this.itemsOf(lane, layer).length, 0) : 0;
    if (!n) return this.flash(`Track ${this.cur.lane + 1} has no ${this.layerName} to clear`);
    this.anchor = null;
    this.edit(() => { for (const layer of this.layers) this.setItemsOf(lane, layer, []); });
    this.flash(`Cleared ${n} ${this.layerName === 'notes' ? 'step(s)' : this.layerName === 'effects' ? 'effect cell(s)' : 'step(s) and effect cell(s)'} of track ${this.cur.lane + 1}. Ctrl+Z to undo`);
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
    if (!this.clipHasItems(clip)) return this.flash(`Duplicate: ${this.describe(rc)} is empty, nothing to copy`);
    const to = rc.r1 + 1;
    this.pushUndo();
    this.pasteAt(clip, rc.l0, to);
    this.setSel(rc.l0, to, rc.l1, Math.min(this.o.totalRows - 1, rc.r1 + clip.rows));
    this.flash(`Duplicated ${this.layerName === 'notes' ? '' : `${this.layerName} of `}${this.describe(rc)} to rows ${String(to).padStart(2, '0')}-${String(Math.min(this.o.totalRows - 1, rc.r1 + clip.rows)).padStart(2, '0')}`);
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
    if (!this.clipHasItems(clip)) return this.flash(`Repeat to end: ${this.describe(rc)} is empty, nothing to repeat`);
    this.pushUndo();
    let copies = 0;
    for (let r = rc.r0 + clip.rows; r < this.o.totalRows; r += clip.rows) { this.pasteAt(clip, rc.l0, r); copies++; }
    this.setSel(rc.l0, rc.r0, rc.l1, this.o.totalRows - 1);
    this.flash(`Repeated ${this.describe(rc)} ${copies} more time(s), to the end of the song`);
    this.changed();
  }

  transpose(delta) {
    if (!this.notesOnly()) return;
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

  /** The effect cells covered by the selection (the cursor cell when nothing is dragged out). */
  effectCells() {
    const rc = this.rect();
    const cells = [];
    for (const lane of this.lanesOf(rc)) for (let row = rc.r0; row <= rc.r1; row++) cells.push({ lane, row });
    return cells;
  }

  /**
   * Controls for the selected effect cells. Every control writes its own field (volume, arpeggio) into all the selected
   * cells right away; the dialog shows the cell under the cursor. One gesture (a drag, a typing session) is one undo step.
   */
  buildEffectControls() {
    const ui = (this.fxUi = {});
    this.fxGesture = false;
    const field = (name, chk, ...rest) => h('div.fx-field', h('label.check.fx-head', chk, name), ...rest);
    ui.volChk = h('input', { type: 'checkbox', onchange: () => this.applyVolume() });
    ui.volRange = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '100', 'aria-label': 'Volume',
      oninput: () => { ui.volOut.textContent = `${ui.volRange.value}%`; ui.volChk.checked = true; this.applyVolume(); } });
    ui.volOut = h('output', '100%');
    ui.arpChk = h('input', { type: 'checkbox', onchange: () => this.applyArp() });
    ui.arpOffsets = h('input.fx-offsets', { type: 'text', value: DEFAULT_ARP.offsets.join(' '), spellcheck: 'false', 'aria-label': 'Arpeggio offsets in semitones',
      title: `Semitones above the note, up to ${ARP_MAX_OFFSETS}, for example "0 4 7" for a major chord. The pitch steps through them six times per row.`,
      oninput: () => { if (this.parseArpOffsets()) ui.arpChk.checked = true; this.applyArp(); } });
    const signed = (n) => (n > 0 ? `+${n}` : String(n));
    ui.slideChk = h('input', { type: 'checkbox', onchange: () => this.applySlide() });
    ui.slideRange = h('input', { type: 'range', min: String(-Math.min(12, MAX_SLIDE)), max: String(Math.min(12, MAX_SLIDE)), step: '1', value: '2', 'aria-label': 'Slide in semitones per row',
      title: 'Semitones the pitch moves over the row (negative: down). It stays there afterwards, and consecutive rows add up.',
      oninput: () => { ui.slideOut.textContent = `${signed(Number(ui.slideRange.value))} st`; ui.slideChk.checked = true; this.applySlide(); } });
    ui.slideOut = h('output', '+2 st');
    const ticks = (n) => Array.from({ length: n }, (_, i) => i);
    ui.cutChk = h('input', { type: 'checkbox', onchange: () => this.applyCut() });
    ui.cutTick = h('select', { 'aria-label': 'Cut at tick', title: `The note is cut at this tick of the row (${ARP_TICKS_PER_ROW} ticks per row)`,
      onchange: () => { ui.cutChk.checked = true; this.applyCut(); } },
      ticks(ARP_TICKS_PER_ROW).map((n) => h('option', { value: String(n), selected: n === 3 }, `at tick ${n}`)));
    ui.retrigChk = h('input', { type: 'checkbox', onchange: () => this.applyRetrig() });
    ui.retrigN = h('select', { 'aria-label': 'Retrigger every', title: 'The note restarts every N ticks within the row',
      onchange: () => { ui.retrigChk.checked = true; this.applyRetrig(); } },
      ticks(ARP_TICKS_PER_ROW - 1).map((i) => h('option', { value: String(i + 1), selected: i + 1 === 2 }, `every ${i + 1} tick${i ? 's' : ''}`)));
    // Parameters: up to MAX_FX_PARAMS rows, each a parameter of the track's instrument, its value for the row and a glide.
    ui.paramRows = [];
    ui.foreign = []; // entries of the cursor cell the editor has no name for (kept untouched)
    ui.params = h('div.fx-params');
    ui.addParam = h('button.small', { type: 'button', title: 'Automate another parameter of the instrument in this row', onclick: () => this.addParamRow() }, '+ parameter');
    ui.paramHint = h('p.muted.fx-hint');
    ui.clear = h('button.small', { type: 'button', onclick: () => this.clearEffects() }, 'Clear effects');
    const wrap = h('div.fx-controls',
      field('Volume', ui.volChk, ui.volRange, ui.volOut),
      field('Arpeggio', ui.arpChk, ui.arpOffsets),
      field('Slide', ui.slideChk, ui.slideRange, ui.slideOut),
      field('Note cut', ui.cutChk, ui.cutTick),
      field('Retrigger', ui.retrigChk, ui.retrigN),
      h('div.fx-params-field', h('div.fx-head', 'Parameters'), ui.params, h('div.fx-params-add', ui.addParam, ui.paramHint)),
      h('div.fx-actions', ui.clear));
    // One gesture = one undo step: the first change pushes the undo snapshot, the end of the gesture re-arms it.
    for (const ev of ['change', 'focusout']) wrap.addEventListener(ev, () => { this.fxGesture = false; });
    return wrap;
  }

  /** The offsets typed in the dialog, or null (and a red outline) when they are not 1-4 whole numbers within ±48. */
  parseArpOffsets() {
    const parts = this.fxUi.arpOffsets.value.split(/[\s,]+/).filter(Boolean);
    const nums = parts.map(Number);
    const ok = parts.length >= 1 && parts.length <= ARP_MAX_OFFSETS && nums.every((n) => Number.isInteger(n) && n >= -48 && n <= 48);
    this.fxUi.arpOffsets.classList.toggle('bad', !ok);
    return ok ? nums : null;
  }

  /** Write (or, with `null`, remove) one effect field on every selected cell; the roll redraws and the change is saved. */
  applyFxField(field, value) {
    if (!this.fxGesture) {
      this.pushUndo();
      this.fxGesture = true;
    }
    for (const { lane, row } of this.effectCells()) {
      const l = this.orders.lanes[lane];
      setFxField(l, row, field, typeof value === 'function' ? value(l, row) : value); // a function: a value that depends on the cell
    }
    this.changed();
  }

  applyVolume() {
    const ui = this.fxUi;
    this.applyFxField('volume', ui.volChk.checked ? Number(ui.volRange.value) / 100 : null);
  }

  applyArp() {
    const ui = this.fxUi;
    if (!ui.arpChk.checked) return this.applyFxField('arp', null);
    const offsets = this.parseArpOffsets();
    if (offsets) this.applyFxField('arp', { offsets });
  }

  applySlide() {
    const ui = this.fxUi;
    this.applyFxField('slide', ui.slideChk.checked ? Number(ui.slideRange.value) : null);
  }

  applyCut() {
    const ui = this.fxUi;
    this.applyFxField('cut', ui.cutChk.checked ? Number(ui.cutTick.value) : null);
  }

  applyRetrig() {
    const ui = this.fxUi;
    this.applyFxField('retrig', ui.retrigChk.checked ? Number(ui.retrigN.value) : null);
  }

  // ---- parameter rows of the effects dialog

  /** The instrument of the track under the cursor: the dialog offers its parameters. */
  cursorInst() {
    const lane = this.orders.lanes[this.cur.lane];
    return lane && this.instOf(lane);
  }

  /** One row: a parameter menu, a slider with its value, a glide checkbox and a remove button. */
  makeParamRow(inst, p, shown, glide) {
    const ui = this.fxUi;
    const row = { p, el: null };
    const options = automatable(inst);
    row.sel = h('select', { 'aria-label': 'Parameter',
      onchange: () => {
        row.p = options.find((o) => o.id === row.sel.value);
        this.setParamSlider(row, ownValue(inst, row.p)); // a new parameter starts at the instrument's own value
        this.disableUsedParams();
        this.applyParams();
      } }, options.map((o) => h('option', { value: o.id, selected: o.id === p.id }, o.label)));
    row.range = h('input', { type: 'range', min: '0', max: String(SLIDER_STEPS), step: '1', 'aria-label': 'Value', title: 'The parameter\'s value during this row (double-click for the instrument\'s own value)',
      oninput: () => { row.out.textContent = this.paramText(row); this.applyParams(); },
      ondblclick: () => { this.setParamSlider(row, ownValue(inst, row.p)); this.applyParams(); } });
    row.out = h('output');
    row.glide = h('input', { type: 'checkbox', 'aria-label': 'Glide', onchange: () => this.applyParams() });
    row.remove = h('button.small.fx-remove', { type: 'button', 'aria-label': 'Remove this parameter', title: 'Remove', onclick: () => {
      ui.paramRows = ui.paramRows.filter((r) => r !== row);
      row.el.remove();
      this.disableUsedParams();
      this.applyParams();
      this.updateAddParam();
    } }, '×');
    row.el = h('div.fx-param', row.sel, h('div.fx-param-value', row.range, row.out),
      h('label.check.fx-glide', { title: 'Move to the value over the row, from where the row before left off, instead of jumping' }, row.glide, 'glide'), row.remove);
    this.setParamSlider(row, shown);
    row.glide.checked = !!glide;
    return row;
  }

  setParamSlider(row, shown) {
    row.range.value = String(toPosition(row.p, shown));
    row.out.textContent = this.paramText(row);
  }

  /** The row's value as shown next to its slider. */
  paramShown(row) {
    return fromPosition(row.p, Number(row.range.value));
  }

  paramText(row) {
    return `${Number(this.paramShown(row).toPrecision(3))}${row.p.unit}`;
  }

  updateAddParam() {
    const ui = this.fxUi;
    const inst = this.cursorInst();
    const offered = automatable(inst);
    ui.addParam.hidden = !offered.length;
    ui.addParam.disabled = ui.paramRows.length + ui.foreign.length >= MAX_FX_PARAMS || ui.paramRows.length >= offered.length;
    ui.paramHint.textContent = offered.length ? '' : 'This track\'s instrument has nothing to automate here.';
  }

  /** Add a row for the first parameter not used yet (or, with a parameter and entry, show that entry). */
  addParamRow(p, entry) {
    const ui = this.fxUi;
    const inst = this.cursorInst();
    const offered = automatable(inst);
    const free = p ?? offered.find((o) => !ui.paramRows.some((r) => r.p.id === o.id));
    if (!free) return;
    const row = this.makeParamRow(inst, free, entry ? toShown(inst, free, entry.value) : ownValue(inst, free), entry?.glide);
    ui.paramRows.push(row);
    ui.params.append(row.el);
    this.disableUsedParams();
    if (!entry) this.applyParams();
    this.updateAddParam();
  }

  /** A parameter can be in one row of a cell only: each row's menu has the parameters of the other rows greyed out. */
  disableUsedParams() {
    for (const row of this.fxUi.paramRows) {
      for (const opt of row.sel.options) opt.disabled = this.fxUi.paramRows.some((r) => r !== row && r.p.id === opt.value);
    }
  }

  /** Show the cursor cell's parameter entries as rows (entries the editor has no name for are kept untouched, out of sight). */
  syncParamRows() {
    const ui = this.fxUi;
    const lane = this.orders.lanes[this.cur.lane];
    const inst = this.cursorInst();
    const cell = lane && fxAt(lane, this.cur.row);
    ui.params.replaceChildren();
    ui.paramRows = [];
    ui.foreign = [];
    for (const e of cell?.params ?? []) {
      const p = paramOf(inst, e);
      if (p) this.addParamRow(p, e); else ui.foreign.push(e);
    }
    this.updateAddParam();
  }

  /** Write the rows into every selected cell: each track gets those parameters its own instrument has. */
  applyParams() {
    const ui = this.fxUi;
    const seen = new Set();
    const entries = [];
    for (const row of ui.paramRows) {
      const dup = seen.has(row.p.id);
      row.el.classList.toggle('bad', dup); // the same parameter twice in one cell: only the first counts
      if (dup) continue;
      seen.add(row.p.id);
      const e = { node: row.p.node, port: row.p.port, value: fromShown(this.cursorInst(), row.p, this.paramShown(row)) };
      if (row.glide.checked) e.glide = true;
      entries.push(e);
    }
    this.applyFxField('params', (lane, row) => {
      const inst = this.instOf(lane);
      const mine = entries.filter((e) => paramOf(inst, e));
      const others = (fxAt(lane, row)?.params ?? []).filter((e) => !paramOf(inst, e)); // not the editor's to change
      return [...mine, ...others].slice(0, MAX_FX_PARAMS);
    });
  }

  clearEffects() {
    this.pushUndo();
    this.fxGesture = false;
    const cells = this.effectCells();
    for (const lane of new Set(cells.map((c) => c.lane))) clearFx(this.orders.lanes[lane], cells.filter((c) => c.lane === lane).map((c) => c.row));
    this.syncEffectDialog();
    this.changed();
  }

  /** Show the cursor cell's effects in the dialog controls. */
  syncEffectDialog() {
    const ui = this.fxUi;
    const lane = this.orders.lanes[this.cur.lane];
    const cell = lane && fxAt(lane, this.cur.row);
    ui.volChk.checked = cell?.volume !== undefined;
    ui.volRange.value = String(Math.round((cell?.volume ?? 1) * 100));
    ui.volOut.textContent = `${ui.volRange.value}%`;
    ui.arpChk.checked = !!cell?.arp;
    ui.arpOffsets.value = (cell?.arp?.offsets ?? DEFAULT_ARP.offsets).join(' ');
    ui.arpOffsets.classList.remove('bad');
    ui.slideChk.checked = cell?.slide !== undefined;
    ui.slideRange.value = String(cell?.slide ?? 2);
    ui.slideOut.textContent = `${Number(ui.slideRange.value) > 0 ? '+' : ''}${ui.slideRange.value} st`;
    ui.cutChk.checked = cell?.cut !== undefined;
    ui.cutTick.value = String(cell?.cut ?? 3);
    ui.retrigChk.checked = cell?.retrig !== undefined;
    ui.retrigN.value = String(cell?.retrig ?? 2);
    this.syncParamRows();
  }

  /** The song got longer or shorter (freeform): keep the cursor inside it and drop the undo history, which holds rows beyond the new end. */
  setTotalRows(total, revealEnd = false) {
    this.o.totalRows = total;
    this.cur.row = Math.min(this.cur.row, total - 1);
    if (this.anchor) this.anchor.row = Math.min(this.anchor.row, total - 1);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.keepScroll = true; // the cursor may be far from where you are looking (the buttons at the end): don't jump to it
    this.render();
    this.keepScroll = false;
    if (revealEnd) this.rollScroll.scrollLeft = this.rollScroll.scrollWidth; // show the bar that was just added
  }

  /** Switch the layer the cursor lives in. Leaving the effect layer closes its dialog. */
  setDomain(domain) {
    if (this.domain === domain) return;
    this.domain = domain;
    this.anchor = null;
    if (domain !== 'auto') this.closeEffectDialog();
  }

  /** Placeholder dialog for the selected effect steps (non-modal: the roll stays usable while it is open). */
  refreshEffectDialog() {
    const rc = this.rect();
    const lanes = this.lanesOf(rc).map((l) => `${l + 1} ${this.nameOf(this.orders.lanes[l])}`).join(', ');
    this.effectInfo.textContent = `Track ${lanes} · steps ${rc.r0}–${rc.r1} (${rc.r1 - rc.r0 + 1})`;
    this.syncEffectDialog();
  }

  openEffectDialog() {
    this.refreshEffectDialog();
    if (!this.effectDlg.open) {
      this.effectDlg.show();
      this.main.focus({ preventScroll: true }); // show() moves focus into the dialog; the roll keeps the keyboard
    }
  }

  closeEffectDialog() {
    if (this.effectDlg.open) this.effectDlg.close();
  }

  /** Block operations edit notes only; with an effect selection they say so instead of touching the notes. */
  notesOnly() {
    if (this.domain !== 'auto') return true; // note cells, or notes and effects together
    this.flash('That works on notes: select some note cells first');
    return false;
  }

  select(lane) {
    const moved = lane !== this.cur.lane;
    this.setDomain('note');
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

    if (this.domain === 'auto' && !mod && !e.altKey) { // effect cells: move and select only, nothing edits notes
      const ext = e.shiftKey;
      const nav = {
        ArrowUp: () => this.move(-1, 0, ext), ArrowDown: () => this.move(1, 0, ext),
        ArrowLeft: () => this.move(0, -1, ext), ArrowRight: () => this.move(0, 1, ext),
        PageUp: () => this.move(0, -this.o.rowsPerBar, ext), PageDown: () => this.move(0, this.o.rowsPerBar, ext),
        Escape: () => { this.anchor = null; this.closeEffectDialog(); this.render(); },
        ' ': () => this.o.onSpace?.(),
        Enter: () => this.playFromCursor(),
        Delete: () => this.deleteCells(),
        Backspace: () => this.deleteCells(),
      }[e.key];
      if (nav) {
        nav();
        if (e.key.startsWith('Arrow') || e.key.startsWith('Page')) this.openEffectDialog();
        e.preventDefault();
      }
      return;
    }

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
        if (hasLane) this.deleteCells();
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
    // Effect cells: click / shift+click / drag select them like note cells, but not together with notes, unless Alt is held.
    const effectCellAt = (e) => {
      const c = e.target instanceof Element ? e.target.closest('.roll-acell') : null;
      return c ? { lane: Number(c.dataset.lane), row: Number(c.dataset.row) } : null;
    };
    this.roll.addEventListener('mousedown', (e) => {
      const c = effectCellAt(e);
      if (!c || e.button !== 0) return;
      e.preventDefault();
      const moved = c.lane !== this.cur.lane;
      const both = e.altKey; // Alt: the note cells and the effect cells together
      this.setDomain(both ? 'both' : 'auto');
      if (e.shiftKey && this.anchor === null) this.anchor = { ...this.cur };
      else if (!e.shiftKey) { this.anchor = null; if (both) this.bdrag = c; else this.adrag = c; }
      this.cur = { ...c };
      this.render();
      this.main.focus({ preventScroll: true });
      if (moved) this.o.onSelect?.();
      if (e.shiftKey && !both) this.openEffectDialog();
    });
    this.roll.addEventListener('mouseover', (e) => {
      const c = this.adrag && effectCellAt(e); // notes under the pointer are ignored: the selection stays in the effect layer
      if (!c || (c.lane === this.cur.lane && c.row === this.cur.row)) return;
      const moved = c.lane !== this.cur.lane;
      this.anchor = { ...this.adrag };
      this.cur = { ...c };
      this.render();
      if (moved) this.o.onSelect?.();
    });
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
      if (e.altKey && this.showFx) {
        // Alt with the effect lane showing: notes and effects are selected together. Shift+click extends the selection; a drag
        // makes one (see the mouseover below); a plain click that does not move is still the off note (on mouse up).
        if (e.shiftKey) {
          this.setDomain('both');
          this.anchor ??= { ...this.cur };
          this.cur = { ...c };
          this.render();
          this.main.focus({ preventScroll: true });
          if (moved) this.o.onSelect?.();
        } else {
          this.bdrag = c;
          this.pendingOff = c;
        }
        return;
      }
      this.setDomain('note');
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
    this.roll.addEventListener('mouseover', (e) => { // an Alt drag over note cells and effect cells: the block of both layers
      const d = this.bdrag;
      const c = d && (rollCellAt(e) ?? effectCellAt(e));
      if (!c || (c.lane === d.lane && c.row === d.row && this.pendingOff)) return; // still on the cell the press began on: not a drag yet
      this.pendingOff = null; // it is a drag, not a click
      const moved = c.lane !== this.cur.lane;
      this.setDomain('both');
      this.anchor = { ...d };
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
      this.bdrag = null;
      if (this.pendingOff) { // an Alt click on a note cell that did not turn into a drag: the off note
        const c = this.pendingOff;
        this.pendingOff = null;
        const moved = c.lane !== this.cur.lane;
        this.setDomain('note');
        this.toggleOff(c);
        this.main.focus({ preventScroll: true });
        if (moved) this.o.onSelect?.();
      }
      if (this.adrag) { // a click or drag on effect cells ended: open the (placeholder) effect dialog for the selection
        this.adrag = null;
        this.openEffectDialog();
      }
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
    const items = [...this.roll.querySelectorAll('.roll-row:not(.head):not(.auto)')];
    let k = items.findIndex((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (k < 0) k = items.length;
    d.ins = k < items.length ? Number(items[k].dataset.lane) : Number(items[items.length - 1].dataset.lane) + 1;
    items.forEach((el, i) => {
      const lane = el.dataset.lane;
      const q = (root, sel) => root.querySelector(`${sel}[data-lane="${lane}"]`);
      // A track is four elements: its automation row and label above, its note row and label. The drop marker sits above
      // the automation lane (before) or below the note row (after).
      const top = [q(this.roll, '.roll-row.auto'), q(this.rollLabels, '.roll-auto-label')];
      const bottom = [el, q(this.rollLabels, '.roll-label')];
      for (const m of [...top, ...bottom]) m?.classList.toggle('dragging', Number(lane) === d.from);
      for (const m of top) m?.classList.toggle('drop-before', i === k);
      for (const m of bottom) m?.classList.toggle('drop-after', k === items.length && i === items.length - 1);
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
    const title = h('div.roll-title', h('span', 'Tracks'));
    if (this.o.onAddTrack) { // sessions with unlimited tracks
      title.append(h('button.roll-add', { type: 'button', title: 'Add a track', 'aria-label': 'Add a track', disabled: !(this.o.canAddTrack?.() ?? true),
        onmousedown: (e) => e.stopPropagation(), onclick: () => this.o.onAddTrack() }, icon('plus')));
    }
    this.rollLabels.append(title);
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
      // Freeform: the end of the song carries the buttons that add or remove a bar. Every row reserves the same room, so
      // the cells of all rows (and the bar numbers) stay lined up.
      if (this.o.onBars) row.append(row.classList.contains('head') ? lengthButtons() : h('div.roll-len-spacer'));
    };
    const lengthButtons = () => {
      const bars = this.o.getBars?.() ?? 0;
      const btn = (delta, text, title, off) => h('button.roll-len-btn', { type: 'button', title, 'aria-label': title, disabled: off,
        onmousedown: (e) => e.stopPropagation(), onclick: () => this.o.onBars(delta) }, text);
      return h('div.roll-len', btn(-1, '−', 'Remove the last bar', bars <= 1), btn(1, '+', 'Add a bar at the end', bars >= 64));
    };
    const head = h('div.roll-row.head');
    const lp = this.loop;
    stepsOf(head, (group, r, beatStart, barStart) => {
      const bar = Math.floor(r / rpb) + 1;
      const n = (r % rpb) / beat + 1;
      const inLoop = !!lp && r >= lp.from && r <= lp.to;
      const cell = h('div', { class: `roll-hcell${barStart ? ' bar' : ''}${inLoop ? ' in-loop' : ''}`,
        title: inLoop ? 'Loop: click to clear it, drag to move it' : 'Drag across these to loop that region, double-click to loop the bar' },
        beatStart ? h('div.rc-text', h('span', barStart ? `${bar}` : `.${n}`)) : null);
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
      // An automation / effect lane above each track: cells like the note cells, half as high and dimmer (no data yet).
      const fxByRow = new Map((lane.fx ?? []).map((f) => [f.row, f]));
      if (this.showFx) {
        const autoLabel = h('div.roll-auto-label', { title: 'Automation lane' }, 'auto');
        autoLabel.dataset.lane = String(li);
        this.rollLabels.append(autoLabel);
      }
      this.rollLabels.append(label);
      const autoRow = h('div', { class: `roll-row auto${state}` });
      autoRow.dataset.lane = String(li);
      if (this.showFx) stepsOf(autoRow, (group, r, _b, _bb, groupEnd, barEnd) => {
        let acls = 'roll-acell';
        if (groupEnd) acls += ' gend';
        if (barEnd) acls += ' bend';
        if (this.domain === 'auto' && li === this.cur.lane && r === this.cur.row) acls += ' cur';
        if (this.inSel(li, r, 'auto')) acls += ' sel';
        const fxCell = fxByRow.get(r);
        if (fxCell) acls += ` has${fxLabel(fxCell).length > 3 ? ' many' : ''}`;
        const cell = h('div', { class: acls });
        cell.dataset.lane = String(li);
        cell.dataset.row = String(r);
        if (fxCell) {
          cell.title = fxTitle(fxCell, (e) => describeParam(this.instOf(lane), e));
          cell.append(h('div.rc-text', h('span', fxLabel(fxCell))));
        }
        this.rollCols[r].push(cell);
        group.append(cell);
      });
      if (this.showFx) this.rollScroll.append(autoRow);
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
        if (this.domain !== 'auto' && li === this.cur.lane && r === this.cur.row) cls += ' cur';
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
    const at = this.domain === 'auto'
      ? `effect lane of track ${this.cur.lane + 1}, row ${this.cur.row}`
      : `track ${this.cur.lane + 1}, row ${this.cur.row}: ${cs ? (cs.note == null ? 'note off' : `${noteName(cs.note)} vel ${cs.vel}`) : 'empty'}${this.domain === 'both' ? ' (notes and effects)' : ''}`;
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
    if (hadFocus && document.activeElement !== this.main && !this.effectDlg.contains(document.activeElement)) this.main.focus({ preventScroll: true });
    if (!this.keepScroll) this.roll.querySelector('.roll-cell.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
