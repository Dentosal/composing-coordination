// Entry point: hash routing, lobby (create / join), and hand-off to the Game screen.
import * as api from './api.js';
import { unlock } from './audio.js';
import { h, clear } from './dom.js';
import { Game } from './game.js';
import { readSceneFile } from './scene.js';
import { loadNick, saveNick, tidyNick, MAX_NICK } from './nick.js';
const root = document.getElementById('app');
let game = null;

// ---- token storage: localStorage per session, mirrored into the URL hash
const keyOf = (sid) => `band:${sid}`;
function loadTokens(sid) {
  try {
    return JSON.parse(localStorage.getItem(keyOf(sid))) || {};
  } catch {
    return {};
  }
}
function saveTokens(sid, t) {
  try {
    localStorage.setItem(keyOf(sid), JSON.stringify(t));
  } catch {}
}

function parseHash() {
  const [path, query = ''] = location.hash.slice(1).split('?');
  const m = /^\/s\/([\w-]+)$/.exec(path);
  const q = new URLSearchParams(query);
  return { sid: m?.[1] ?? null, seat: q.get('seat'), host: q.get('host') };
}

function setHash(sid, t) {
  const q = new URLSearchParams();
  if (t.seat) q.set('seat', t.seat);
  if (t.host) q.set('host', t.host);
  history.replaceState(null, '', `#/s/${sid}?${q}`);
}

async function route() {
  game?.destroy();
  game = null;
  const { sid, seat, host } = parseHash();
  if (!sid) return showHome();
  const saved = loadTokens(sid);
  const tokens = { seat: seat || saved.seat || null, host: host || saved.host || null };
  if (tokens.seat) {
    saveTokens(sid, tokens);
    setHash(sid, tokens);
    return enter(sid, tokens);
  }
  return showJoin(sid, tokens);
}

function enter(sid, tokens) {
  game = new Game(root, {
    sid, seat: tokens.seat, host: tokens.host,
    onKicked: () => { // the seat token is dead: the link (and a reload) leads to the join screen again
      const t = { host: tokens.host };
      saveTokens(sid, t);
      setHash(sid, t);
    },
    onLeave: () => { history.replaceState(null, '', location.pathname); route(); },
  });
  game.start();
}

// ---- screens

// The seed (noise and reverb) is not asked for: the server picks a random one. A scene file brings its own.
const FIELDS = [
  ['bpm', 'BPM', 112, 'number'],
  ['bars', 'Bars per loop', 4, 'number'],
  ['max_tracks', 'Tracks per player', 4, 'number'], // a track = one instrument + its pattern lane
  ['max_sounds', 'Sounds per player (blank = 2 × tracks)', '', 'number'], // different instruments over the whole game
  ['rounds', 'Rounds (blank = until host ends)', '', 'number'],
  ['round_timer_secs', 'Round timer, seconds (blank = none)', '', 'number'],
];

/**
 * Open a new freeform session (one person, no game) and go to the editor: empty with the server's defaults (tempo and
 * length can be changed there), or with a parsed scene's settings and tracks. Throws an Error with a readable message.
 */
async function openFreeform(scene = null) {
  await unlock();
  const cfg = { freeform: true };
  if (scene) {
    cfg.bpm = scene.config.bpm;
    cfg.bars = scene.config.bars;
    if (scene.config.seed != null) cfg.seed = scene.config.seed;
  }
  const { session_id, host_token } = await api.createSession(cfg);
  const { seat_token } = await api.join(session_id, loadNick() || undefined);
  await api.start(session_id, host_token); // no lobby: straight to the work
  if (scene) {
    const r = await api.putOrders(session_id, seat_token, scene.orders);
    if (!r.ok) {
      const e = r.errors[0];
      throw new Error(`The scene cannot be opened: ${e.path ? `${e.path}: ` : ''}${e.message}`);
    }
  }
  const t = { seat: seat_token, host: host_token };
  saveTokens(session_id, t);
  setHash(session_id, t);
  route();
}

const clock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

/** The front page's demo section: the scenes listed in demos/index.json, each opened with one click. Absent when there are none. */
function demoCard() {
  const card = h('div.card.demos', { hidden: true }, h('h2', 'Demo songs'));
  const msg = h('p.error');
  const open = async (d, button) => {
    msg.textContent = '';
    button.disabled = true;
    try {
      const res = await fetch(`demos/${encodeURIComponent(d.file)}.json`);
      if (!res.ok) throw new Error(`Could not load the demo (${res.status}).`);
      await openFreeform(readSceneFile(await res.text()));
    } catch (err) {
      msg.textContent = err.message;
      button.disabled = false;
    }
  };
  fetch('demos/index.json').then((r) => (r.ok ? r.json() : [])).catch(() => []).then((list) => {
    if (!Array.isArray(list) || !list.length) return;
    for (const d of list) {
      const button = h('button.primary', { type: 'button', onclick: () => open(d, button),
        title: 'Open it in a new freeform session, where you can play it and change anything' }, 'Open in editor');
      card.append(h('div.demo',
        h('div.demo-text', h('h3', d.artist ? `${d.title} - ${d.artist}` : d.title),
          h('p.muted', `${clock(d.seconds)} · ${d.tracks} tracks · ${d.bpm} BPM`)),
        button));
    }
    card.append(msg);
    card.hidden = false;
  });
  return card;
}

function showHome() {
  clear(root);
  const inputs = {};
  const form = h('form.config', { onsubmit: onCreate });
  // The nickname the others see: the host plays too.
  inputs.nick = nickInput();
  form.append(h('label.nick-row', h('span', 'Your nickname'), inputs.nick));
  for (const [name, label, def, type] of FIELDS) {
    inputs[name] = h('input', { name, type, value: String(def), step: 'any' });
    if (name !== 'max_tracks') { form.append(h('label', h('span', label), inputs[name])); continue; }
    // "Unlimited tracks" sits beside "Tracks per player" and replaces it: players start with the default number and
    // add or delete tracks themselves, so the field is switched off.
    inputs.unlimited_tracks = h('input', { name: 'unlimited_tracks', type: 'checkbox',
      onchange: (e) => { inputs.max_tracks.disabled = e.target.checked; } });
    inputs.max_tracks.id = 'max-tracks';
    const pair = h('div.config-pair', h('label.name', { for: 'max-tracks' }, h('span', label)),
      h('label.check', { title: 'Players add and delete tracks themselves (up to 64) instead of having a fixed number. Everyone starts with 4.' },
        inputs.unlimited_tracks, h('span', 'Unlimited')),
      inputs.max_tracks); // the field stays in the right-hand column with the others
    form.append(pair);
  }
  inputs.timeout_policy = h('select', { name: 'timeout_policy' },
    h('option', { value: 'Wait' }, 'Wait for everyone'),
    h('option', { value: 'RepeatLast' }, 'Repeat last orders on timeout'));
  form.append(h('label.wide-select', h('span', 'When the timer runs out'), inputs.timeout_policy));

  const msg = h('p.error');
  const submit = h('button.primary', { type: 'submit' }, 'Create session');
  form.append(submit, msg);

  // The freeform editor: one person, no game. Empty, or with an exported scene file (the download menu in the header).
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true,
    onchange: (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) open(importBtn, () => file(f)); } });
  const file = async (f) => readSceneFile(await f.text());
  const freeMsg = h('p.error');
  const open = async (button, scene) => {
    freeMsg.textContent = '';
    button.disabled = true;
    try {
      await openFreeform(scene ? await scene() : null);
    } catch (err) {
      freeMsg.textContent = err.message;
      button.disabled = false;
    }
  };
  const openBtn = h('button.primary', { type: 'button', onclick: () => open(openBtn) }, 'Open editor');
  const importBtn = h('button', { type: 'button', onclick: () => fileIn.click(),
    title: 'Open a scene file saved from the download menu in the header' }, 'Import a scene file…');
  const freeCard = h('div.card.freeform-card', h('h2', 'Freeform editor'),
    h('div.freeform-actions', openBtn, importBtn), fileIn, freeMsg);

  async function onCreate(e) {
    e.preventDefault();
    const cfg = {};
    for (const [name] of FIELDS) {
      if (inputs[name].disabled) continue; // "Tracks per player" while unlimited tracks is on
      const v = inputs[name].value.trim();
      if (v === '') continue;
      cfg[name] = Number(v);
    }
    if (cfg.max_tracks != null) cfg.max_lanes = cfg.max_instruments = cfg.max_tracks;
    delete cfg.max_tracks;
    cfg.timeout_policy = inputs.timeout_policy.value;
    if (inputs.unlimited_tracks.checked) cfg.unlimited_tracks = true;
    const nick = tidyNick(inputs.nick.value);
    if (!nick) {
      msg.textContent = 'Choose a nickname: the other players see it.';
      return;
    }
    saveNick(nick);
    try {
      await unlock();
      const { session_id, host_token } = await api.createSession(cfg);
      // The host takes a seat like everyone else; the two tokens are unrelated on the server.
      const { seat_token } = await api.join(session_id, nick);
      const t = { seat: seat_token, host: host_token };
      saveTokens(session_id, t);
      setHash(session_id, t);
      route();
    } catch (err) {
      msg.textContent = err.message;
    }
  }

  const code = h('input', { placeholder: 'Session link or code' });
  root.append(
    h('div.hero', h('h1', 'Band Game'),
      h('p', 'Write one part of a shared loop. Nobody talks. Everyone hears only the band.')),
    h('div.cols',
      h('div.card', h('h2', 'Create a session'), form),
      h('div', // the right-hand column: joining, the freeform editor, and below them the demo songs
        h('div.card', h('h2', 'Join a session'),
          h('form', { onsubmit: (e) => {
            e.preventDefault();
            const m = /([0-9a-f]{10})\s*$/i.exec(code.value.replace(/\?.*$/, ''));
            if (m) location.hash = `#/s/${m[1].toLowerCase()}`;
          } }, code, h('button', { type: 'submit' }, 'Open'))),
        freeCard,
        demoCard())));
}

async function showJoin(sid, tokens) {
  clear(root);
  let info;
  try {
    info = await api.info(sid);
  } catch (e) {
    root.append(h('div.card', h('h2', 'Session not found'), h('p', e.message),
      h('button', { onclick: () => { location.hash = ''; } }, 'Back')));
    return;
  }
  const msg = h('p.error');
  const ended = info.phase === 'ended';
  const nick = nickInput();
  nick.required = true;
  nick.disabled = ended;
  const take = h('button.primary', { type: 'submit', disabled: ended }, 'Take a seat');
  root.append(h('div.card.join',
    h('h2', 'Join session'),
    h('p', `${info.seat_count} seated · ${info.config.bpm} BPM · ${info.config.bars} bars`),
    ended ? h('p', 'This session has ended.') : null,
    tokens.host && !tokens.seat ? h('p.muted', 'You hold the host token for this session.') : null,
    h('form.join-form', { onsubmit: async (e) => {
      e.preventDefault();
      const name = tidyNick(nick.value);
      if (!name) { msg.textContent = 'Choose a nickname: the other players see it.'; return; }
      take.disabled = true;
      try {
        await unlock();
        const { seat_token } = await api.join(sid, name);
        saveNick(name);
        const t = { ...tokens, seat: seat_token };
        saveTokens(sid, t);
        setHash(sid, t);
        route();
      } catch (err) {
        msg.textContent = err.message;
        take.disabled = false;
      }
    } }, h('label', h('span', 'Your nickname'), nick), take),
    msg));
  if (!ended) nick.focus();
}

/** The nickname field, filled in with the saved one. */
function nickInput() {
  return h('input', { name: 'nick', type: 'text', value: loadNick(), maxlength: MAX_NICK, required: true,
    autocomplete: 'nickname', placeholder: 'What the others call you' });
}

window.addEventListener('hashchange', route);
route();
