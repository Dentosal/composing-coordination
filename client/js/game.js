// Game screen controller: lobby wait, round play, end screen.
import * as api from './api.js';
import { LoopPlayer, decode, unlock } from './audio.js';
import { h, clear } from './dom.js';
import { InstrumentPanel, ensureTracks, loadPresets } from './editor.js';
import { PatternEditor } from './pattern.js';

const fmtTime = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

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
    // Local preview of this seat's uncommitted part, rendered by the server and looped over the mix.
    this.previewPlayer = new LoopPlayer();
    this.previewOn = false;
    this.previewT = null;
    this.previewBusy = false;
    this.previewStale = false;
    this.previewMsg = '';
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
    this.es?.close();
    clearInterval(this.tickT);
    clearTimeout(this.saveT);
    clearTimeout(this.previewT);
    this.player.stop();
    this.previewPlayer.stop();
    this.panel?.destroy();
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
    if (this.previewOn) this.schedulePreview(600);
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
    ensureTracks(this.orders, tracks, this.presets); // every player always has the full set of tracks
    const r = this.refs;
    const cfg = this.st.config;
    const totalRows = cfg.bars * cfg.rows_per_bar;
    r.round = h('span'); r.timer = h('span'); r.ready = h('span'); r.seats = h('span');
    r.endBtn = this.host
      ? h('button.small', { onclick: async (e) => {
          if (!confirm('End the session after the current round resolves?')) return;
          try { await api.end(this.sid, this.host); this.st.end_requested = true; this.updateTop(); } catch (err) { alert(err.message); }
        } }, 'End after this round')
      : null;
    r.errors = h('ul.errors');
    r.commit = h('button.primary', { onclick: () => this.commit() }, 'Commit & ready');
    r.commitInfo = h('span.muted.commit-info');
    r.top = h('header.topbar', r.round, r.timer, r.ready, r.seats, h('span.spacer'), r.endBtn, r.commitInfo, r.commit);

    r.playBtn = h('button.primary', { onclick: () => this.togglePlay() }, '▶ Play mix');
    r.previewBtn = h('button', { onclick: () => this.togglePreview() }, '🎧 Preview my part');
    r.mixInfo = h('span.muted');
    r.mix = h('section.mix', r.playBtn, r.previewBtn, r.mixInfo);

    const instRoot = h('div');
    const patRoot = h('div');
    this.pattern = new PatternEditor(patRoot, {
      totalRows, rowsPerBar: cfg.rows_per_bar, maxLanes: cfg.max_lanes,
      getOrders: () => this.orders, onChange: () => this.touch(), onSpace: () => this.togglePlay(),
      onSelect: () => this.panel.render(), // the active column picks the patch shown in the instrument panel
      onVolume: () => this.panel.render(),
    });
    this.panel = new InstrumentPanel(instRoot, {
      presets: this.presets, bpm: cfg.bpm, seed: cfg.seed, getActive: () => this.pattern.cur.lane,
      getOrders: () => this.orders, onChange: () => { this.touch(); this.pattern.syncHeads(); },
      onRename: () => this.pattern.syncHeads(),
    });

    this.root.append(r.top, r.errors, r.mix,
      h('div.workspace',
        h('aside.panel', h('h3', 'Patch'), instRoot),
        h('section.panel.pattern', h('h3', 'Pattern'), patRoot)));
  }

  updateTop() {
    const r = this.refs;
    if (this.view !== 'game' || !r.round) return;
    const st = this.st;
    r.round.textContent = `Round ${st.round?.n ?? '–'}${st.config.rounds ? ` / ${st.config.rounds}` : ''}`;
    r.ready.textContent = `ready ${st.ready_count} / ${st.eligible_count}`;
    r.seats.textContent = `${st.seat_count} seated`;
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
    if (this.view !== 'game' || !r.mix) return;
    const hasAudio = !!this.mixRound || (this.previewOn && !!this.previewPlayer.buffer);
    r.playBtn.disabled = !hasAudio;
    r.playBtn.textContent = this.playing ? '■ Stop' : this.mixRound ? '▶ Play mix' : '▶ Play';
    r.previewBtn.classList.toggle('active', this.previewOn);
    r.previewBtn.textContent = this.previewOn ? '🎧 Previewing my part' : '🎧 Preview my part';
    const mixText = this.mixRound
      ? `Looping the band mix from round ${this.mixRound}.`
      : this.previewOn ? '' : 'No mix yet: round 1 is written blind. Use Preview to hear your part.';
    let previewText = '';
    if (this.previewOn) {
      previewText = this.previewMsg || (this.previewBusy || !this.previewPlayer.buffer ? 'Rendering preview…' : 'Preview is on.');
      if (this.mixRound) previewText += ' (The mix already contains your last committed part.)';
    }
    r.mixInfo.textContent = [mixText, previewText].filter(Boolean).join(' ');
  }

  /** Start or stop the whole transport: the band mix and, if on, the preview, started on the same tick. */
  async togglePlay() {
    if (this.playing) {
      this.playing = false;
      this.player.stop();
      this.previewPlayer.stop();
    } else {
      const c = await unlock();
      const when = c.currentTime + 0.05;
      this.playing = true;
      await Promise.all([this.player.play(when), this.previewOn ? this.previewPlayer.play(when) : null]);
      if (!this.player.playing && !this.previewPlayer.playing) this.playing = false;
    }
    this.updateMix();
  }

  togglePreview() {
    this.previewOn = !this.previewOn;
    this.previewMsg = '';
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

  schedulePreview(ms) {
    clearTimeout(this.previewT);
    this.previewT = setTimeout(() => this.renderPreview(), ms);
  }

  /** Render the current draft on the server and swap it into the preview loop at the next boundary. */
  async renderPreview() {
    if (this.previewBusy) {
      this.previewStale = true;
      return;
    }
    this.previewBusy = true;
    this.previewStale = false;
    this.updateMix();
    let retry = 0;
    try {
      const snapshot = JSON.parse(JSON.stringify(this.orders));
      const buf = await decode(await api.fetchPreview(this.sid, this.token, snapshot));
      if (this.previewOn && !this.dead) {
        this.previewMsg = '';
        this.previewPlayer.setBuffer(buf);
        await this.startPreviewInSync();
      }
    } catch (e) {
      if (e.status === 429) retry = 1500;
      else this.previewMsg = e.errors?.length ? `Preview needs valid orders: ${e.message}` : `Preview failed: ${e.message}`;
    } finally {
      this.previewBusy = false;
    }
    if (this.previewOn && (this.previewStale || retry)) this.schedulePreview(retry || 100);
    this.updateMix();
  }

  /** If the transport is running but the preview is not yet (first render finished late), join on the mix's next loop boundary. */
  async startPreviewInSync() {
    if (!this.playing || this.previewPlayer.playing || !this.previewPlayer.buffer) return;
    const when = this.player.playing ? this.player.nextBoundary() : undefined;
    await this.previewPlayer.play(when);
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
