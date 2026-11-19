// Game screen controller: lobby wait, round play, end screen.
import * as api from './api.js';
import { LoopPlayer, decode, getCtx, unlock } from './audio.js';
import { h, clear } from './dom.js';
import { InstrumentPanel, ensureTracks, loadPresets, newTrack } from './editor.js';
import { LiveSequencer } from './live.js';
import { PatternEditor } from './pattern.js';
import { helpButton } from './help.js';
import { downloadBlob, downloadText } from './download.js';
import { menuButton } from './menu.js';
import { renderSong } from './offline.js';
import { sceneFile } from './scene.js';
import { icon } from './icons.js';
import { Spectrum } from './spectrum.js';

/** Local date and time for file names: 20261119-1432. */
const fileStamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

const fmtTime = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The most tracks a player can have in an unlimited session (the server enforces the same ceiling). */
const MAX_UNLIMITED_TRACKS = 64;
/** The longest freeform song, in bars (the server enforces the same). */
const MAX_FREEFORM_BARS = 256;

export class Game {
  /** @param {HTMLElement} root @param {{sid:string,seat:string|null,host:string|null,onLeave:()=>void}} o */
  constructor(root, o) {
    this.root = root;
    this.sid = o.sid;
    this.seat = o.seat;
    this.host = o.host;
    this.onLeave = o.onLeave;
    this.token = o.seat || o.host;
    this.st = null;
    this.orders = { instruments: [], lanes: [] };
    this.ready = false;
    this.dirty = false;
    this.errors = [];
    this.view = null;
    this.player = new LoopPlayer();
    // Preview of this seat's uncommitted part, played over the mix. Two engines: a live sequencer in the browser
    // (instant, the default) and the server's canonical render looped like the mix (see previewPlayer).
    this.serverPlayer = new LoopPlayer();
    this.livePlayer = new LiveSequencer({
      config: () => this.st.config,
      seat: () => this.st.you?.seat_index ?? 0,
      part: () => ({ instruments: this.orders.instruments, lanes: this.orders.lanes.filter((l) => this.isAudible(l.instrument)) }),
    });
    this.previewOn = true; // your own draft plays along by default
    // Whether the previous round's band mix plays in the background (when there is one).
    this.playMix = true;
    try { this.playMix = localStorage.getItem('playPrevRound') !== '0'; } catch {}
    this.serverPreview = false;
    try { this.serverPreview = localStorage.getItem('serverPreview') === '1'; } catch {}
    this.previewT = null;
    this.previewBusy = false;
    this.previewStale = false;
    this.previewMsg = '';
    // Local-only listening state per track (keyed by instrument id). Never part of the orders, so it can't be committed.
    this.muted = new Set();
    this.loop = null; // loop region {from, to} (rows, inclusive) chosen on the bar numbers; null: play the whole song
    this.solo = new Set();
    this.playing = false;
    this.mixRound = null;
    this.mixLoading = null;
    this.queue = Promise.resolve();
    this.saveT = null;
    this.firstOpen = true;
    this.refs = {};
    this.dead = false;
  }

  async start() {
    this.presets = await loadPresets();
    try {
      await this.refresh(true);
    } catch (e) {
      this.fatal(e);
      return;
    }
    if (this.freeform && this.st.phase === 'lobby' && this.host) { // a freeform session has no lobby: begin at once
      try {
        await api.start(this.sid, this.host);
        await this.refresh(true);
      } catch (e) {
        this.fatal(e);
        return;
      }
    }
    this.connect();
    this.tickT = setInterval(() => this.tick(), 250);
    const frame = () => {
      if (this.dead) return;
      this.updatePlayhead();
      requestAnimationFrame(frame);
    };
    frame();
  }

  destroy() {
    this.dead = true;
    this.spectrum?.destroy();
    if (this.onFullscreen) document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.es?.close();
    clearInterval(this.tickT);
    clearTimeout(this.saveT);
    clearTimeout(this.previewT);
    this.player.stop();
    this.serverPlayer.stop();
    this.livePlayer.stop();
    this.panel?.destroy();
    this.pattern?.destroy();
  }

  fatal(e) {
    clear(this.root).append(
      h('div.card', h('h2', 'Cannot open session'), h('p', e.message || String(e)),
        h('button', { onclick: () => this.onLeave() }, 'Back')));
  }

  // ------------------------------------------------------------ data flow

  async refresh(first = false) {
    const st = await api.getState(this.sid, this.token);
    this.st = st;
    if (first && st.you?.orders) {
      this.orders = { instruments: st.you.orders.instruments ?? [], lanes: st.you.orders.lanes ?? [] };
    }
    this.ready = !!st.you?.ready;
    this.render();
    if (st.latest_mix != null && st.latest_mix !== this.mixRound) this.loadMix(st.latest_mix);
    if (this.dirty && this.canEdit()) this.scheduleSave(50);
  }

  connect() {
    const es = new EventSource(api.eventsUrl(this.sid, this.token));
    this.es = es;
    const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data || '{}')));
    on('seat_count', (d) => { this.st.seat_count = d.count; this.updateTop(); this.updateLobby(); });
    on('ready_count', (d) => { this.st.ready_count = d.ready; this.st.eligible_count = d.total; this.updateTop(); });
    on('config', (d) => this.applyBars(d.bars)); // freeform: the song's length changed (another tab, or this one)
    on('round_opened', () => this.refresh().catch(() => {}));
    on('round_resolved', (d) => this.loadMix(d.n));
    on('session_ended', () => this.refresh().catch(() => {}));
    on('song_ready', () => this.refresh().catch(() => {}));
    on('resync', () => this.refresh().catch(() => {}));
    es.onopen = () => {
      if (this.firstOpen) this.firstOpen = false;
      else this.refresh().catch(() => {});
    };
  }

  async loadMix(n) {
    if (n === this.mixRound || this.mixLoading === n) return;
    this.mixLoading = n;
    try {
      const buf = await decode(await api.fetchMix(this.sid, this.token, n));
      if (this.mixRound == null || n > this.mixRound) {
        this.mixRound = n;
        this.player.setBuffer(buf);
        this.updateMix();
      }
    } catch (e) {
      console.warn(e);
    } finally {
      this.mixLoading = null;
    }
  }

  // ------------------------------------------------------------ editing

  canEdit() {
    const r = this.st?.round;
    return !!r && r.state === 'open' && !!this.st.you?.eligible;
  }

  enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  touch() {
    this.dirty = true;
    if (this.ready) {
      this.ready = false;
      this.enqueue(() => api.setReady(this.sid, this.token, false)).catch(() => {});
      this.updateCommit();
    }
    this.scheduleSave(800);
    if (this.previewOn && this.serverPreview) { // the live sequencer reads the orders as it plays
      this.editAt ??= performance.now(); // first edit not yet heard; used for latency logging
      this.schedulePreview(600);
    }
  }

  scheduleSave(ms) {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.enqueue(() => this.saveNow()).catch(() => {}), ms);
  }

  /** PUT current orders. Returns true if accepted. */
  async saveNow() {
    if (!this.canEdit()) return false; // stays dirty; flushed when the next round opens
    try {
      const r = await api.putOrders(this.sid, this.token, this.orders);
      if (r.ok) {
        this.errors = [];
        this.dirty = false;
      } else {
        this.errors = r.errors;
      }
      this.updateErrors();
      return !!r.ok;
    } catch (e) {
      if (e.status !== 409) this.errors = [{ path: '', message: e.message }];
      this.updateErrors();
      return false;
    }
  }

  async commit() {
    try {
      if (this.ready) {
        this.ready = false;
        this.updateCommit();
        await this.enqueue(() => api.setReady(this.sid, this.token, false));
        return;
      }
      clearTimeout(this.saveT);
      const ok = await this.enqueue(() => this.saveNow());
      if (!ok) return;
      await this.enqueue(() => api.setReady(this.sid, this.token, true));
      this.ready = true;
      this.updateCommit();
    } catch (e) {
      this.errors = [{ path: '', message: e.message }];
      this.updateErrors();
    }
  }

  // ------------------------------------------------------------ rendering

  render() {
    const phase = this.st.phase;
    const want = phase === 'lobby' ? 'lobby' : phase === 'ended' ? 'end' : 'game';
    if (want !== this.view) {
      this.view = want;
      clear(this.root);
      this.refs = {};
      if (want === 'lobby') this.buildLobby();
      else if (want === 'end') this.buildEnd();
      else this.buildGame();
    }
    this.updateTop();
    this.updateMix();
    this.updateCommit();
    this.updateLobby();
    this.updateEnd();
    this.updateErrors();
  }

  inviteLink() {
    return `${location.origin}${location.pathname}#/s/${this.sid}`;
  }

  buildLobby() {
    const r = this.refs;
    r.seats = h('strong');
    r.startBtn = this.host
      ? h('button.primary', { onclick: async (e) => {
          e.target.disabled = true;
          await unlock();
          try { await api.start(this.sid, this.host); } catch (err) { alert(err.message); e.target.disabled = false; }
        } }, 'Start session')
      : h('p.muted', 'Waiting for the host to start…');
    this.root.append(h('div.card.lobby',
      h('h2', 'Lobby'),
      h('p', 'Seats taken: ', r.seats),
      h('p.muted', 'Share this link so others can join:'),
      h('div.invite', h('input', { readonly: true, value: this.inviteLink(), onfocus: (e) => e.target.select() }),
        h('button', { onclick: () => navigator.clipboard?.writeText(this.inviteLink()) }, 'Copy')),
      r.startBtn));
  }

  updateLobby() {
    if (this.view !== 'lobby') return;
    this.refs.seats.textContent = String(this.st.seat_count);
  }

  buildGame() {
    const tracks = Math.min(this.st.config.max_lanes, this.st.config.max_instruments);
    // Every player always has the full set of tracks; with unlimited tracks that is "at least the starting number".
    ensureTracks(this.orders, this.unlimited ? Math.max(tracks, this.orders.lanes.length) : tracks, this.presets);
    const r = this.refs;
    const cfg = this.st.config;
    const totalRows = cfg.bars * cfg.rows_per_bar;
    const free = this.freeform;
    if (!free) { // the round machinery of a game; a freeform session has none of it
      r.round = h('span'); r.timer = h('span'); r.ready = h('span'); r.seats = h('span');
      r.endBtn = this.host
        ? h('button.small', { onclick: async (e) => {
            if (!confirm('End the session after the current round resolves?')) return;
            try { await api.end(this.sid, this.host); this.st.end_requested = true; this.updateTop(); } catch (err) { alert(err.message); }
          } }, 'End after this round')
        : null;
      r.commit = h('button.primary', { onclick: () => this.commit() }, 'Commit & ready');
      r.commitInfo = h('span.muted.commit-info');
    }
    r.errors = h('ul.errors');
    r.help = helpButton({
      title: free ? 'Freeform' : 'How this works',
      body: free ? [
        'A workspace for one person: write patterns and effects with as many tracks as you like. There are no rounds and nothing to commit.',
        h('ul', h('li', 'Each row of the track roll is one instrument. Click a track to shape its sound in the panel above, and place notes in its cells.'),
          h('li', 'Drag across the bar numbers to loop a section while you work.'),
          h('li', 'The footer plays everything you have written; your work is kept while the session is open.'),
          h('li', 'The download menu in the header saves the song as audio (rendered on the server or in this browser), or all your patches, notes and effects as one scene file.')),
      ] : [
        'Every round, each player writes a short looping part. When everyone has committed, the parts are mixed into one band loop that plays under the next round.',
        h('ul', h('li', 'Each row of the track roll is one instrument. Click a track to shape its sound in the panel above, and place notes in its cells.'),
          h('li', 'Drag across the bar numbers to loop a section while you work.'),
          h('li', 'The footer plays your draft, optionally over the previous round.'),
          h('li', 'Commit & ready sends your part. The round ends when everyone is ready.'),
          h('li', 'The download menu in the header saves the song so far or your own part as audio, or your patches, notes and effects as one scene file.')),
      ],
    });
    // Fullscreen toggle (hidden where the browser has no fullscreen API, e.g. iPhones).
    r.fsBtn = h('button.icon-btn', { type: 'button', onclick: () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    } });
    r.fsBtn.hidden = !document.fullscreenEnabled;
    this.onFullscreen = () => this.updateFullscreenBtn();
    document.addEventListener('fullscreenchange', this.onFullscreen);
    this.updateFullscreenBtn();
    r.exportBtn = menuButton(h('button.icon-btn', { type: 'button', title: 'Download: the song as audio, or everything as a scene file', 'aria-label': 'Download' }, icon('download')),
      () => this.downloadItems(), 'Download');
    r.top = free
      ? h('header.topbar', r.fsBtn, h('strong.mode-name', 'Freeform'), h('span.spacer'), r.exportBtn, r.help)
      : h('header.topbar', r.fsBtn, r.round, r.timer, r.ready, r.seats, h('span.spacer'), r.endBtn, r.commitInfo, r.commit, r.exportBtn, r.help);

    r.playBtn = h('button.primary', { onclick: () => this.togglePlay() }, '▶ Play');
    r.previewBtn = h('button', { onclick: () => this.togglePreview() }, '🎧 Preview my part');
    if (!free) { // the previous round's mix: a game has one, a freeform session does not
      r.prevChk = h('input', { type: 'checkbox', checked: this.playMix, onchange: (e) => this.setPlayMix(e.target.checked) });
      r.prevLbl = h('label.muted', {}, r.prevChk, ' Previous round');
    }
    r.serverChk = h('input', { type: 'checkbox', checked: this.serverPreview, onchange: (e) => this.setServerPreview(e.target.checked) });
    r.serverLbl = h('label.muted', { title: 'Render the preview on the server, exactly like the final band mix (slower, edits are heard after a short delay). Off: play it live in your browser.' }, r.serverChk, ' Server render');
    r.mixInfo = h('span.muted');
    this.spectrum?.destroy();
    this.spectrum = new Spectrum();
    r.foot = h('footer.bottombar', r.playBtn, r.previewBtn, free ? null : r.prevLbl, r.serverLbl, r.mixInfo, this.spectrum.el);

    const instRoot = h('div');
    const patRoot = h('div');
    this.pattern = new PatternEditor(patRoot, {
      totalRows, rowsPerBar: cfg.rows_per_bar, maxLanes: cfg.max_lanes,
      getOrders: () => this.orders, onChange: () => this.touch(), onSpace: () => this.togglePlay(),
      onSelect: () => this.panel.render(), // the active column picks the patch shown in the instrument panel
      onVolume: () => this.panel.render(),
      // Typing a note sounds the active track's patch (the panel owns the shared auditioner).
      onAudition: (lane, note, vel) => {
        const inst = this.orders.instruments.find((i) => i.id === this.orders.lanes[lane]?.instrument);
        if (inst && this.isAudible(inst.id)) this.panel.aud.once(inst, note, vel);
      },
      onPlay: (kind, a, b) => this.playPattern(kind, a, b),
      isMuted: (id) => this.muted.has(id),
      isSolo: (id) => this.solo.has(id),
      isAudible: (id) => this.isAudible(id),
      onToggleMute: (id) => this.toggleMute(id),
      onToggleSolo: (id) => this.toggleSolo(id),
      onAddTrack: this.unlimited ? () => this.addTrack() : null,
      // Freeform: the buttons at the right end of the roll make the song one bar longer or shorter.
      onBars: this.freeform ? (delta) => this.setBars(this.st.config.bars + delta) : null,
      getBars: () => this.st.config.bars,
      canAddTrack: () => this.orders.lanes.length < MAX_UNLIMITED_TRACKS,
      getLoop: () => this.loop,
      onLoop: (loop, final) => this.setLoop(loop, final),
    });
    this.panel = new InstrumentPanel(instRoot, {
      presets: this.presets, bpm: cfg.bpm, seed: cfg.seed, getActive: () => this.pattern.cur.lane,
      getOrders: () => this.orders, onChange: () => { this.touch(); this.pattern.syncHeads(); },
      onRename: () => this.pattern.syncHeads(),
      onMode: () => this.pattern.render(), // piano roll on/off changes how the roll draws the track
      onFxChange: () => this.pattern.render(), // the instrument change dropped effect-cell entries for nodes it no longer has
      onDeleteTrack: this.unlimited ? (lane) => this.deleteTrack(lane) : null,
      canDeleteTrack: () => this.orders.lanes.length > 1,
    });

    this.root.append(r.top, r.errors,
      h('div.workspace',
        h('aside.panel', instRoot),
        h('section.panel.pattern', patRoot)),
      r.foot);
    this.applyMixMute();
    if (this.previewOn && this.serverPreview) this.renderPreview(); // the live preview needs no render
    this.updateMix();
  }

  updateFullscreenBtn() {
    const b = this.refs.fsBtn;
    if (!b) return;
    const on = !!document.fullscreenElement;
    const label = on ? 'Exit fullscreen' : 'Fullscreen';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.replaceChildren(icon(on ? 'collapse' : 'expand'));
  }

  updateTop() {
    const r = this.refs;
    if (this.view !== 'game' || !r.round) return;
    const st = this.st;
    r.round.textContent = `Round ${st.round?.n ?? '–'}${st.config.rounds ? ` / ${st.config.rounds}` : ''}`;
    r.ready.textContent = `ready ${st.ready_count} / ${st.eligible_count}`;
    const waiting = st.seat_count - st.eligible_count; // seated, but their first round is the next one
    r.seats.textContent = waiting > 0 ? `${waiting} joining next round` : '';
    r.seats.hidden = waiting <= 0;
    if (st.end_requested) r.round.textContent += ' (last)';
    this.tick();
  }

  tick() {
    const r = this.refs;
    if (this.view !== 'game' || !r.timer) return;
    const d = this.st.round?.deadline;
    if (!d) r.timer.textContent = this.st.round?.state === 'rendering' ? 'rendering…' : 'no timer';
    else {
      const left = d - Date.now();
      r.timer.textContent = left > 0 ? `⏱ ${fmtTime(left)}` : this.st.config.timeout_policy === 'Wait' ? 'overdue, waiting' : 'time up';
    }
    if (this.st.round?.state === 'rendering') r.timer.textContent = 'rendering…';
  }

  updateMix() {
    const r = this.refs;
    if (this.view !== 'game' || !r.foot) return;
    const hasAudio = (!!this.mixRound && this.playMix) || (this.previewOn && !!this.previewPlayer.buffer);
    r.playBtn.disabled = !hasAudio;
    r.playBtn.textContent = this.playing ? '■ Stop' : '▶ Play';
    if (r.prevChk) r.prevChk.checked = this.playMix && !!this.mixRound;
    if (r.prevChk) r.prevChk.disabled = !this.mixRound;
    if (r.prevLbl) r.prevLbl.title = this.mixRound
      ? `Play the band mix of round ${this.mixRound} in the background while you listen to your draft.`
      : 'There is no previous round to play yet.';
    r.previewBtn.classList.toggle('active', this.previewOn);
    r.previewBtn.textContent = this.previewOn ? '🎧 Previewing my part' : '🎧 Preview my part';
    const free = this.freeform;
    const mixText = free
      ? (this.previewOn ? '' : 'Turn on Preview to hear your tracks.')
      : this.mixRound
        ? (this.playMix ? `Round ${this.mixRound}'s band mix plays in the background.` : '')
        : this.previewOn ? '' : 'No mix yet: round 1 is written blind. Use Preview to hear your part.';
    let previewText = '';
    if (this.previewOn) {
      previewText = this.previewMsg || (this.previewBusy || !this.previewPlayer.buffer ? 'Rendering preview…' : 'Preview is on.');
      if (this.mixRound && this.playMix) previewText += ' (The mix already contains your last committed part.)';
    }
    let listenText = '';
    if (this.solo.size) listenText = free ? 'Solo: you hear only the soloed track.' : 'Solo: the band mix is silenced; you hear only the soloed track(s) of your draft.';
    else if (this.muted.size) listenText = free ? '' : 'Muted tracks are silent in the preview only (the band mix still has your last committed part).';
    r.mixInfo.textContent = [mixText, previewText, listenText].filter(Boolean).join(' ');
  }

  /**
   * Save the whole draft as one file: every patch (with its piano-roll setting), all notes and all effects, exactly as
   * the orders format holds them, plus the loop's tempo and size for context.
   */
  async exportAll() {
    // Copy the scene as it is now: the version lookup can take a moment, and edits made meanwhile must not slip in.
    const cfg = { ...this.st.config };
    const orders = structuredClone(this.orders);
    const file = sceneFile(cfg, orders, await api.version());
    downloadText(`band-game-tracks-${fileStamp()}.json`, JSON.stringify(file, null, 1) + '\n');
  }

  /** The header's download menu: audio files of the song (freeform: rendered on the server or in this browser; a game:
   *  the rounds so far, or your own draft), and the scene file. The audio has every track, whatever is muted or soloed. */
  downloadItems() {
    const seat = this.st.you?.seat_index ?? 0;
    const save = (name, wav) => downloadBlob(`${name}-${fileStamp()}.wav`, new Blob([wav], { type: 'audio/wav' }));
    const scene = { label: 'Scene file', detail: 'All patches, notes and effects (.json), to open again from the start page', run: () => this.exportAll() };
    if (this.freeform) {
      return [
        { label: 'Song, rendered on the server', detail: 'Audio (.wav), made by the server',
          run: async (progress) => { progress('Rendering on the server…'); save('song-server', await api.fetchRender(this.sid, this.token, this.orders)); } },
        { label: 'Song, rendered in this browser', detail: 'Audio (.wav): the same file, made on this computer',
          run: async (progress) => {
            progress('Rendering… 0%');
            save('song-browser', await renderSong(this.st.config, seat, this.orders, (f) => progress(`Rendering… ${Math.round(f * 100)}%`)));
          } },
        'sep', scene,
      ];
    }
    return [
      { label: 'Song so far', detail: 'Audio (.wav): every round played so far, back to back',
        disabled: this.st.latest_mix == null && 'Audio (.wav): available once the first round has been played',
        run: async (progress) => { progress('Rendering on the server…'); save('song-so-far', await api.fetchSongSoFar(this.sid, this.token)); } },
      { label: 'My part', detail: 'Audio (.wav): your current draft on its own',
        run: async (progress) => { progress('Rendering on the server…'); save('my-part', await api.fetchRender(this.sid, this.token, this.orders)); } },
      'sep', scene,
    ];
  }

  /** Freeform: ask for a different length (asking before it drops anything), then apply it. */
  async setBars(value) {
    const cfg = this.st.config;
    const bars = Math.round(Number(value));
    if (!this.freeform || !Number.isFinite(bars) || bars < 1 || bars > MAX_FREEFORM_BARS || bars === cfg.bars) return;
    const total = bars * cfg.rows_per_bar;
    const loses = this.orders.lanes.some((l) => l.steps.some((s) => s.row >= total) || (l.fx ?? []).some((f) => f.row >= total));
    if (loses && !confirm(`Shorten the song to ${bars} bar${bars === 1 ? '' : 's'}? The notes and effects after the end are deleted.`)) return;
    try {
      await this.enqueue(() => this.saveNow()); // the server drops what is past the end from its copy; make sure it has the latest
      await api.setBars(this.sid, this.token, bars);
    } catch (e) {
      alert(e.message);
      return;
    }
    this.applyBars(bars);
  }

  /** The song length changed: trim the draft, resize the roll and stop playback (it was cut to the old length). */
  applyBars(bars) {
    const cfg = this.st.config;
    if (bars === cfg.bars) return;
    const grew = bars > cfg.bars;
    cfg.bars = bars;
    const total = bars * cfg.rows_per_bar;
    for (const lane of this.orders.lanes) {
      lane.steps = lane.steps.filter((s) => s.row < total);
      if (lane.fx) {
        lane.fx = lane.fx.filter((f) => f.row < total);
        if (!lane.fx.length) delete lane.fx;
      }
    }
    if (this.loop && this.loop.from >= total) this.loop = null;
    else if (this.loop) this.loop = { from: this.loop.from, to: Math.min(this.loop.to, total - 1) };
    if (this.playing) {
      this.playing = false;
      this.player.stop();
      this.livePlayer.stop();
      this.serverPlayer.stop();
    }
    if (this.pattern) this.pattern.loop = this.loop; // the editor keeps its own copy of the loop
    this.pattern?.setTotalRows(total, grew);
    if (this.previewOn && this.serverPreview) this.schedulePreview(0);
    this.updateMix();
  }

  /** Sessions where players add and delete tracks themselves. */
  get unlimited() {
    return !!this.st?.config.unlimited_tracks || this.freeform;
  }

  /** Freeform mode: one person, no game (no rounds, no committing, nobody else). */
  get freeform() {
    return !!this.st?.config.freeform;
  }

  addTrack() {
    if (!this.unlimited || this.orders.lanes.length >= MAX_UNLIMITED_TRACKS) return;
    const { instrument, lane } = newTrack(this.orders, this.presets);
    this.orders.instruments.push(instrument);
    this.orders.lanes.push(lane);
    this.pattern.setDomain('note');
    this.pattern.anchor = null;
    this.pattern.cur = { lane: this.orders.lanes.length - 1, row: this.pattern.cur.row }; // the new track becomes the active one
    this.touch();
    this.pattern.render();
    this.panel.render();
  }

  /** Delete a track (its instrument, notes and effects). Never the last one. */
  deleteTrack(index) {
    const lane = this.orders.lanes[index];
    if (!this.unlimited || !lane || this.orders.lanes.length <= 1) return;
    const inst = this.orders.instruments.find((i) => i.id === lane.instrument);
    if (!confirm(`Delete track ${index + 1} "${inst?.name || lane.instrument}"? Its patch, notes and effects are lost.`)) return;
    this.orders.lanes.splice(index, 1);
    this.orders.instruments = this.orders.instruments.filter((i) => i.id !== lane.instrument);
    this.muted.delete(lane.instrument);
    this.solo.delete(lane.instrument);
    this.pattern.setDomain('note');
    this.pattern.anchor = null;
    this.pattern.cur = { lane: Math.min(index, this.orders.lanes.length - 1), row: this.pattern.cur.row };
    this.touch();
    this.pattern.render();
    this.panel.render();
    this.applyMixMute();
    this.updateMix();
  }

  /** With a track soloed only that track is heard, otherwise everything not muted. */
  isAudible(id) {
    return this.solo.size ? this.solo.has(id) : !this.muted.has(id);
  }

  /** Solo is exclusive (at most one track) and soloing a muted track unmutes it. */
  toggleSolo(id) {
    if (this.solo.has(id)) this.solo.clear();
    else {
      this.solo.clear();
      this.solo.add(id);
      this.muted.delete(id);
    }
    this.applyListening();
  }

  /** Muting the soloed track ends its solo, so a track is never both. */
  toggleMute(id) {
    if (!this.muted.delete(id)) {
      this.muted.add(id);
      this.solo.delete(id);
    }
    this.applyListening();
  }

  /** Update what is heard after a mute/solo change. Only affects local playback, never the orders. */
  /** The band mix is silenced while a track is soloed (it can't be split per track) or when "Previous round" is off. */
  applyMixMute() {
    this.player.setMuted(this.solo.size > 0 || !this.playMix);
  }

  setPlayMix(on) {
    this.playMix = on;
    try { localStorage.setItem('playPrevRound', on ? '1' : '0'); } catch {}
    this.applyMixMute();
    this.updateMix();
  }

  applyListening() {
    this.pattern.render();
    // Solo means "hear only this": silence the band mix (it can't be split per track) and make sure the draft preview is on.
    this.applyMixMute();
    if (this.solo.size && !this.previewOn) this.togglePreview();
    else if (this.previewOn) this.schedulePreview(150);
    this.updateMix();
  }

  /** True when there is nothing to play yet: no band mix (round 1) and no rendered preview. */
  needsPreview() {
    return !(this.mixRound && this.playMix) && !(this.previewOn && this.previewPlayer.buffer);
  }

  /** Nothing to hear yet: turn the preview on and start `what` as soon as it has rendered. */
  playWhenPreviewReady(what) {
    this.pendingPlay = what;
    if (!this.previewOn) this.togglePreview();
    else this.updateMix();
  }

  /** Playback region for the current loop, starting at `fromRow` if that is inside it (else at the loop's start). No loop: undefined, or the whole song from `fromRow`. */
  transportRegion(fromRow) {
    const cfg = this.st.config;
    const rowSecs = 60 / (cfg.bpm * (cfg.rows_per_bar / 4));
    const lp = this.loop;
    if (!lp) return fromRow ? { offset: fromRow * rowSecs, loopStart: 0, loopEnd: cfg.bars * cfg.rows_per_bar * rowSecs } : undefined;
    const inside = fromRow != null && fromRow >= lp.from && fromRow <= lp.to;
    return { offset: (inside ? fromRow : lp.from) * rowSecs, loopStart: lp.from * rowSecs, loopEnd: (lp.to + 1) * rowSecs };
  }

  /** The loop was set, moved or cleared. When it is released while playing, carry on inside it (or the whole song). */
  setLoop(loop, final) {
    this.loop = loop;
    if (!final || !this.playing) return;
    const pos = this.player.position() ?? this.previewPlayer.position();
    const cfg = this.st.config;
    const rowSecs = 60 / (cfg.bpm * (cfg.rows_per_bar / 4));
    this.playPattern('cursor', pos == null ? 0 : Math.floor(pos / rowSecs) % (cfg.bars * cfg.rows_per_bar));
  }

  /** Start or stop the whole transport: the band mix and, if on, the preview, started on the same tick. */
  async togglePlay() {
    if (!this.playing && this.needsPreview()) return this.playWhenPreviewReady({ kind: 'full' });
    if (this.playing) {
      this.playing = false;
      this.player.stop();
      this.previewPlayer.stop();
    } else {
      const c = await unlock();
      const when = c.currentTime + 0.05;
      this.playing = true;
      const region = this.transportRegion();
      await Promise.all([this.player.play(when, region), this.previewOn ? this.previewPlayer.play(when, region) : null]);
      if (!this.player.playing && !this.previewPlayer.playing) this.playing = false;
    }
    this.updateMix();
  }

  /**
   * Play from a pattern position: 'cursor' starts at row `a` and loops the loop region (or the whole mix when there is
   * none); 'region' loops rows a..b.
   * Restarts if already playing. The preview, if on, follows the same region.
   */
  async playPattern(kind, a, b) {
    if (this.needsPreview()) return this.playWhenPreviewReady({ kind, a, b });
    const rowSecs = 60 / (this.st.config.bpm * (this.st.config.rows_per_bar / 4));
    const region = kind === 'cursor'
      ? this.transportRegion(a) ?? { offset: 0, loopStart: 0, loopEnd: this.st.config.bars * this.st.config.rows_per_bar * rowSecs }
      : { offset: a * rowSecs, loopStart: a * rowSecs, loopEnd: (b + 1) * rowSecs };
    if (this.playing) {
      this.player.stop();
      this.previewPlayer.stop();
    }
    const c = await unlock();
    const when = c.currentTime + 0.05;
    this.playing = true;
    await Promise.all([this.player.play(when, region), this.previewOn ? this.previewPlayer.play(when, region) : null]);
    if (!this.player.playing && !this.previewPlayer.playing) this.playing = false;
    this.updateMix();
  }

  togglePreview() {
    this.previewOn = !this.previewOn;
    this.previewMsg = '';
    if (!this.previewOn) this.pendingPlay = null;
    clearTimeout(this.previewT);
    if (this.previewOn) {
      this.renderPreview();
    } else {
      this.previewStale = false;
      this.previewPlayer.stop();
      if (!this.player.playing) this.playing = false;
    }
    this.updateMix();
  }

  get previewPlayer() {
    return this.serverPreview ? this.serverPlayer : this.livePlayer;
  }

  setServerPreview(on) {
    this.serverPlayer.stop();
    this.livePlayer.stop();
    this.serverPreview = on;
    try { localStorage.setItem('serverPreview', on ? '1' : '0'); } catch {}
    if (this.previewOn) this.renderPreview(); // live: joins the running transport at once; server: render first
  }

  schedulePreview(ms) {
    clearTimeout(this.previewT);
    this.previewT = setTimeout(() => this.renderPreview(), ms);
  }

  /** The live preview needs no render: start it (or the play command that was waiting for it). */
  async previewReady() {
    this.previewMsg = '';
    const pending = this.pendingPlay;
    this.pendingPlay = null;
    if (pending?.kind === 'full') await this.togglePlay();
    else if (pending) await this.playPattern(pending.kind, pending.a, pending.b);
    else await this.startPreviewInSync();
    this.updateMix();
  }

  /** Server mode: render the current draft on the server and swap it into the preview loop at the playhead. */
  async renderPreview() {
    if (!this.serverPreview) return this.previewReady();
    if (this.previewBusy) {
      this.previewStale = true;
      return;
    }
    this.previewBusy = true;
    this.previewStale = false;
    this.updateMix();
    let retry = 0;
    const t0 = performance.now();
    const editAt = this.editAt ?? t0;
    this.editAt = null;
    try {
      const snapshot = JSON.parse(JSON.stringify(this.orders));
      for (const lane of snapshot.lanes) if (!this.isAudible(lane.instrument)) lane.steps = []; // muted / not soloed
      const wav = await api.fetchPreview(this.sid, this.token, snapshot);
      const t1 = performance.now();
      const size = wav.byteLength;
      const buf = await decode(wav);
      const t2 = performance.now();
      if (this.previewOn && this.serverPreview && !this.dead) {
        this.previewMsg = '';
        this.serverPlayer.setBuffer(buf, true); // swap in at the current playhead, don't wait for the loop boundary
        const f = (x) => Math.round(x);
        console.log(
          `[preview] edit→audible ${f(t2 - editAt)}ms = wait-before-render ${f(t0 - editAt)} + server ${f(t1 - t0)} (${(size / 1024) | 0} KiB) + decode ${f(t2 - t1)} (loop ${buf.duration.toFixed(2)}s)`,
        );
        const pending = this.pendingPlay;
        this.pendingPlay = null;
        if (pending) { // a play command was waiting for the first render
          if (pending.kind === 'full') await this.togglePlay();
          else await this.playPattern(pending.kind, pending.a, pending.b);
        } else await this.startPreviewInSync();
      }
    } catch (e) {
      if (e.status === 429) retry = 1500;
      else this.previewMsg = e.errors?.length ? `Preview needs valid orders: ${e.message}` : `Preview failed: ${e.message}`;
    } finally {
      this.previewBusy = false;
    }
    if (this.previewMsg && !this.serverPlayer.buffer) this.pendingPlay = null; // the render failed: don't play later by surprise
    if (this.previewOn && this.serverPreview && (this.previewStale || retry)) this.schedulePreview(retry || 100);
    this.updateMix();
  }

  /** If the transport is running but the preview is not yet (first render finished late), join on the mix's next loop boundary. */
  async startPreviewInSync() {
    if (!this.playing || this.previewPlayer.playing || !this.previewPlayer.buffer) return;
    const reg = this.player.playing ? this.player.loopRegion() : undefined;
    let when = this.player.playing ? this.player.nextBoundary() : undefined;
    let region = reg;
    const pos = reg && this.previewPlayer === this.livePlayer ? this.player.position() : null;
    if (pos != null) { // live: join at the next row of the running mix instead of waiting for the loop boundary
      const rowSecs = 60 / (this.st.config.bpm * (this.st.config.rows_per_bar / 4));
      let next = Math.ceil(pos / rowSecs - 1e-6) * rowSecs;
      when = getCtx().currentTime + 0.02 + (next - pos);
      if (next >= reg.loopEnd - 1e-6) next = reg.loopStart;
      region = { ...reg, offset: next };
    }
    await this.previewPlayer.play(when, region);
  }

  updatePlayhead() {
    if (this.view !== 'game' || !this.pattern) return;
    const pos = this.player.position() ?? this.previewPlayer.position();
    if (pos == null) return this.pattern.setPlayhead(null);
    const cfg = this.st.config;
    const rowSecs = 60 / (cfg.bpm * (cfg.rows_per_bar / 4));
    this.pattern.setPlayhead(Math.floor(pos / rowSecs) % (cfg.bars * cfg.rows_per_bar));
  }

  updateCommit() {
    const r = this.refs;
    if (this.view !== 'game' || !r.commit) return;
    const rs = this.st.round?.state;
    const eligible = this.st.you?.eligible;
    r.commit.disabled = false;
    r.commit.classList.toggle('ready', this.ready);
    if (!eligible) {
      r.commit.disabled = true;
      r.commit.textContent = 'You join next round';
      r.commitInfo.textContent = 'You can keep editing; your part starts in the next round.';
    } else if (rs !== 'open') {
      r.commit.disabled = true;
      r.commit.textContent = 'Rendering mix…';
      r.commitInfo.textContent = '';
    } else if (this.ready) {
      r.commit.textContent = '✓ Ready. Click to keep editing';
      r.commitInfo.textContent = 'Waiting for the others.';
    } else {
      r.commit.textContent = 'Commit & ready';
      r.commitInfo.textContent = '';
    }
  }

  updateErrors() {
    const r = this.refs;
    if (this.view !== 'game' || !r.errors) return;
    clear(r.errors).append(...this.errors.map((e) => h('li', e.path ? h('code', e.path, ': ') : null, e.message)));
  }

  buildEnd() {
    const r = this.refs;
    r.endBody = h('div');
    this.root.append(h('div.card.end', h('h2', 'Session ended'), r.endBody,
      h('button', { onclick: () => this.onLeave() }, 'Back to start')));
  }

  updateEnd() {
    if (this.view !== 'end') return;
    const body = clear(this.refs.endBody);
    if (!this.st.round && !this.st.latest_mix) {
      body.append(h('p.muted', 'The session ended before any round was played.'));
    } else if (this.st.song_ready) {
      body.append(
        h('p', 'The full song, all rounds back to back:'),
        h('audio', { controls: true, src: api.songUrl(this.sid, this.token) }),
        h('p', h('a.button', { href: api.songUrl(this.sid, this.token, true), download: 'song.wav' }, 'Download song.wav')));
    } else {
      body.append(h('p.muted', 'Rendering the full song…'));
    }
  }
}
