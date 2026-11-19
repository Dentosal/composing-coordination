// The dialog after each round of a game: the song so far (every round back to back), played in this browser. When the
// game is over it also offers the song as audio (the server's render) and the whole game as one scene file.
import * as api from './api.js';
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { StreamPlayer } from './stream.js';
import { renderSong } from './offline.js';
import { combineRounds } from './combine.js';
import { sceneFile } from './scene.js';
import { downloadBlob, downloadText } from './download.js';

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The whole game so far as one song: `{cfg, bars, parts, merged}` (see combineRounds), with the song's own config. */
export async function loadSong(sid, token, cfg) {
  const song = combineRounds(await api.fetchSongParts(sid, token), cfg);
  return { ...song, cfg: { bpm: cfg.bpm, bars: song.bars, rows_per_bar: cfg.rows_per_bar, seed: cfg.seed } };
}

/** Save a loaded song (see loadSong) as one scene file, to open in the freeform editor. */
async function saveScene(song, stamp) {
  downloadText(`band-game-song-${stamp}.json`, JSON.stringify(sceneFile(song.cfg, song.merged, await api.version()), null, 1) + '\n');
}

/** Save the whole game as one scene file: every player's tracks over every round. */
export async function downloadGameScene(sid, token, cfg, stamp) {
  await saveScene(await loadSong(sid, token, cfg), stamp);
}

export class SongDialog {
  /**
   * @param {{sid:string, token:string, state:() => any, stamp:() => string, onListen:() => void, onClose:() => void}} o
   *   `state()` is the session state (config, phase, song_ready); `onListen` is called when the song starts playing (the
   *   editor stops its own playback).
   */
  constructor(o) {
    this.o = o;
    this.n = 0;
    this.song = null;
    this.error = '';
    this.offset = 0; // where playback starts, seconds
    this.player = null;
    this.title = h('h2');
    this.status = h('p.muted');
    this.playBtn = h('button.primary.song-play', { type: 'button', onclick: () => this.toggle() });
    this.seek = h('input.song-seek', { type: 'range', min: 0, max: 1, step: 0.01, value: 0, 'aria-label': 'Position',
      oninput: () => { this.offset = Number(this.seek.value); this.showTime(this.offset); },
      onchange: () => { if (this.player?.playing) this.playFrom(this.offset); } });
    this.time = h('span.song-time.muted');
    this.controls = h('div.song-player', this.playBtn, this.seek, this.time);
    this.audio = h('audio', { controls: true }); // the fallback: the song rendered whole first
    this.audio.addEventListener('play', () => this.o.onListen());
    this.downloads = h('div.round-downloads');
    this.el = h('dialog.round-dialog', { onclose: () => this.close() },
      this.title, this.status, this.controls, this.audio, this.downloads,
      h('form.round-close', { method: 'dialog' }, h('button', { type: 'submit' }, 'Close')));
    document.body.append(this.el); // not in the game's root: the view under it is rebuilt when the session ends
    this.el.showModal();
    this.frame = () => { this.tick(); this.raf = requestAnimationFrame(this.frame); };
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Round `n` has been played: load the song up to it. */
  async show(n) {
    if (n <= this.n) return;
    this.n = n;
    this.stop();
    this.song = null;
    this.error = '';
    this.update();
    try {
      const cfg = this.o.state().config;
      const song = await loadSong(this.o.sid, this.o.token, cfg);
      if (this.n !== n || !this.el.isConnected) return;
      this.song = song;
      this.duration = song.bars * 4 * 60 / cfg.bpm;
      this.seek.max = String(this.duration);
      this.offset = 0;
      if (!StreamPlayer.supported) await this.renderWhole(song, n);
    } catch (e) {
      this.error = `The song could not be loaded: ${e.message}`;
    }
    this.update();
  }

  /** Without the streaming player (the page is not cross-origin isolated): render the song first, then play it. */
  async renderWhole(song, n) {
    this.status.textContent = 'Rendering the song… 0%';
    const wav = await renderSong(song.cfg, 0, song.merged, (f) => { this.status.textContent = `Rendering the song… ${Math.round(f * 100)}%`; });
    if (this.n !== n) return;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    this.audio.src = this.audioUrl;
  }

  /** Fill the dialog in for what there is now: the song once loaded, the downloads once the game is over. */
  update() {
    const st = this.o.state();
    const ended = st.phase === 'ended';
    this.title.textContent = ended ? 'Game over' : `Round ${this.n} done`;
    const ready = !!this.song && (StreamPlayer.supported || !!this.audioUrl);
    this.status.textContent = this.error || (!this.song ? 'Loading the song so far…' : ended
      ? 'The whole song, every round back to back:' : `The song so far, round${this.n > 1 ? `s 1–${this.n}` : ' 1'}:`);
    this.controls.hidden = !this.song || !StreamPlayer.supported;
    this.audio.hidden = !ready || StreamPlayer.supported;
    this.playBtn.textContent = this.player?.playing ? '■ Stop' : '▶ Play';
    this.showTime(this.player?.playing ? this.player.position() ?? this.offset : this.offset);
    clear(this.downloads);
    if (ended && this.song) {
      const wav = h('button', { type: 'button', disabled: !st.song_ready, title: st.song_ready ? '' : 'The server is still rendering it',
        onclick: async () => {
          wav.disabled = true;
          try {
            const r = await fetch(api.songUrl(this.o.sid, this.o.token, true));
            if (!r.ok) throw new Error(r.statusText);
            downloadBlob(`band-game-song-${this.o.stamp()}.wav`, await r.blob());
          } catch (e) { alert(`The song could not be downloaded: ${e.message}`); }
          wav.disabled = false;
        } }, icon('download'), st.song_ready ? ' Song (.wav)' : ' Song (.wav): rendering…');
      const scene = h('button', { type: 'button', title: 'Every player\'s tracks over the whole game, to open in the freeform editor',
        onclick: () => saveScene(this.song, this.o.stamp()) }, icon('download'), ' Scene file (.json)');
      this.downloads.append(wav, scene);
    }
  }

  showTime(pos) {
    if (!this.song) return;
    const p = Math.min(Math.max(pos, 0), this.duration);
    if (document.activeElement !== this.seek) this.seek.value = String(p);
    this.time.textContent = `${clock(p)} / ${clock(this.duration)}`;
  }

  toggle() {
    if (this.player?.playing) {
      this.offset = Math.min(this.player.position() ?? this.offset, this.duration);
      this.stop();
    } else {
      this.playFrom(this.offset >= this.duration - 0.05 ? 0 : this.offset);
    }
    this.update();
  }

  async playFrom(offset) {
    if (!this.song) return;
    this.o.onListen();
    this.player?.stop();
    const song = this.song;
    this.player ??= new StreamPlayer({ config: () => this.song.cfg, parts: () => this.song.parts });
    this.offset = offset;
    this.last = offset;
    await this.player.play(undefined, { offset, loopStart: 0, loopEnd: this.duration });
    if (this.song !== song) this.player.stop();
    this.update();
  }

  stop() {
    this.player?.stop();
  }

  /** While playing: move the slider, and stop at the end (the player itself would loop). */
  tick() {
    if (!this.player?.playing) return;
    const pos = this.player.position();
    if (pos == null) return;
    if (pos < this.last - 0.5) { // wrapped around: the song is over
      this.stop();
      this.offset = 0;
      this.update();
      return;
    }
    this.last = pos;
    this.showTime(pos);
  }

  close() {
    cancelAnimationFrame(this.raf);
    this.player?.destroy();
    this.player = null;
    this.audio.pause();
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    if (this.el.open) this.el.close();
    this.el.remove();
    this.o.onClose();
  }
}
