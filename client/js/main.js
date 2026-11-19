// Entry point: hash routing, lobby (create / join), and hand-off to the Game screen.
import * as api from './api.js';
import { unlock } from './audio.js';
import { h, clear } from './dom.js';
import { Game } from './game.js';
import { readSceneFile } from './scene.js';
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
    onLeave: () => { history.replaceState(null, '', location.pathname); route(); },
  });
  game.start();
}

// ---- screens

const FIELDS = [
  ['bpm', 'BPM', 112, 'number'],
  ['bars', 'Bars per loop', 4, 'number'],
  ['rows_per_bar', 'Rows per bar', 16, 'number'],
  ['max_tracks', 'Tracks per player', 4, 'number'], // a track = one instrument + its pattern lane
  ['rounds', 'Rounds (blank = until host ends)', '', 'number'],
  ['round_timer_secs', 'Round timer, seconds (blank = none)', '', 'number'],
  ['seed', 'Seed (blank = random)', '', 'text'],
];

/** Open a parsed scene as a new freeform session and go to the editor. Throws an Error with a readable message. */
async function openScene(scene) {
  await unlock();
  const cfg = { freeform: true, bpm: scene.config.bpm, bars: scene.config.bars, rows_per_bar: scene.config.rows_per_bar };
  if (scene.config.seed != null) cfg.seed = scene.config.seed;
  const { session_id, host_token } = await api.createSession(cfg);
  const { seat_token } = await api.join(session_id);
  await api.start(session_id, host_token);
  const r = await api.putOrders(session_id, seat_token, scene.orders);
  if (!r.ok) {
    const e = r.errors[0];
    throw new Error(`The scene cannot be opened: ${e.path ? `${e.path}: ` : ''}${e.message}`);
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
      await openScene(readSceneFile(await res.text()));
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
  const gameOnly = []; // settings that only make sense in a game; a freeform session hides them
  // Freeform mode: one person, no game. Only the tempo, the loop size and the seed matter.
  inputs.freeform = h('input', { name: 'freeform', type: 'checkbox', onchange: () => {
    for (const el of gameOnly) el.hidden = inputs.freeform.checked;
    submit.textContent = inputs.freeform.checked ? 'Start freeform' : 'Create session';
  } });
  form.append(h('label.check.freeform-opt', { title: 'Just you: no rounds, no other players. Write with as many tracks as you like.' },
    inputs.freeform, h('span', 'Freeform mode (just you, no game)')));
  for (const [name, label, def, type] of FIELDS) {
    inputs[name] = h('input', { name, type, value: String(def), step: 'any' });
    if (name === 'rounds' || name === 'round_timer_secs') {
      const row = h('label', h('span', label), inputs[name]);
      gameOnly.push(row);
      form.append(row);
      continue;
    }
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
    gameOnly.push(pair);
    form.append(pair);
  }
  inputs.timeout_policy = h('select', { name: 'timeout_policy' },
    h('option', { value: 'Wait' }, 'Wait for everyone'),
    h('option', { value: 'RepeatLast' }, 'Repeat last orders on timeout'));
  const timeoutRow = h('label', h('span', 'When the timer runs out'), inputs.timeout_policy);
  gameOnly.push(timeoutRow);
  form.append(timeoutRow);

  const msg = h('p.error');
  const submit = h('button.primary', { type: 'submit' }, 'Create session');
  // Open an exported scene file (the header's download button) in a fresh freeform session.
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true,
    onchange: (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); } });
  const importRow = h('div.import-row', h('span.muted', 'or'),
    h('button', { type: 'button', onclick: () => fileIn.click(),
      title: 'Open a file saved with the download button in the header, as a new freeform session' }, 'Import a scene file…'), fileIn);
  form.append(submit, importRow, msg);

  async function onImport(file) {
    msg.textContent = '';
    try {
      await openScene(readSceneFile(await file.text()));
    } catch (err) {
      msg.textContent = err.message;
    }
  }

  async function onCreate(e) {
    e.preventDefault();
    const cfg = {};
    for (const [name, , , type] of FIELDS) {
      if (inputs[name].disabled) continue; // "Tracks per player" while unlimited tracks is on
      const v = inputs[name].value.trim();
      if (v === '') continue;
      cfg[name] = name === 'seed' ? v : Number(v); // the seed goes as typed: it can be bigger than a number holds exactly
    }
    if (cfg.max_tracks != null) cfg.max_lanes = cfg.max_instruments = cfg.max_tracks;
    delete cfg.max_tracks;
    cfg.timeout_policy = inputs.timeout_policy.value;
    if (inputs.unlimited_tracks.checked) cfg.unlimited_tracks = true;
    if (cfg.seed !== undefined && !(/^\d{1,20}$/.test(cfg.seed) && BigInt(cfg.seed) <= 18446744073709551615n)) {
      msg.textContent = 'The seed must be a whole number (digits only, up to 18446744073709551615), or blank for a random one.';
      return;
    }
    const freeform = inputs.freeform.checked;
    if (freeform) { // only the loop's settings count; the game settings are not sent
      for (const k of Object.keys(cfg)) if (!['bpm', 'bars', 'rows_per_bar', 'seed'].includes(k)) delete cfg[k];
      cfg.freeform = true;
    }
    try {
      await unlock();
      const { session_id, host_token } = await api.createSession(cfg);
      // The host takes a seat like everyone else; the two tokens are unrelated on the server.
      const { seat_token } = await api.join(session_id);
      if (freeform) await api.start(session_id, host_token); // no lobby: straight to the work
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
      h('div', // the right-hand column: joining, and below it the demo songs
        h('div.card', h('h2', 'Join a session'),
          h('form', { onsubmit: (e) => {
            e.preventDefault();
            const m = /([0-9a-f]{10})\s*$/i.exec(code.value.replace(/\?.*$/, ''));
            if (m) location.hash = `#/s/${m[1].toLowerCase()}`;
          } }, code, h('button', { type: 'submit' }, 'Open'))),
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
  root.append(h('div.card',
    h('h2', 'Join session'),
    h('p', `${info.seat_count} seated · ${info.config.bpm} BPM · ${info.config.bars} bars`),
    info.phase === 'ended' ? h('p', 'This session has ended.') : null,
    tokens.host && !tokens.seat ? h('p.muted', 'You hold the host token for this session.') : null,
    h('button.primary', {
      disabled: info.phase === 'ended',
      onclick: async () => {
        try {
          await unlock();
          const { seat_token } = await api.join(sid);
          const t = { ...tokens, seat: seat_token };
          saveTokens(sid, t);
          setHash(sid, t);
          route();
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    }, 'Take a seat'),
    msg));
}

window.addEventListener('hashchange', route);
route();
