// Entry point: hash routing, lobby (create / join), and hand-off to the Game screen.
import * as api from './api.js';
import { unlock } from './audio.js';
import { h, clear } from './dom.js';
import { Game } from './game.js';

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
  ['seats', 'Seats', 5, 'number'],
  ['bpm', 'BPM', 112, 'number'],
  ['bars', 'Bars per loop', 4, 'number'],
  ['rows_per_bar', 'Rows per bar', 16, 'number'],
  ['max_lanes', 'Lanes per player', 4, 'number'],
  ['max_instruments', 'Instruments per player', 4, 'number'],
  ['rounds', 'Rounds (blank = until host ends)', '', 'number'],
  ['round_timer_secs', 'Round timer, seconds (blank = none)', '', 'number'],
  ['seed', 'Seed (blank = random)', '', 'text'],
];

function showHome() {
  clear(root);
  const inputs = {};
  const form = h('form.config', { onsubmit: onCreate });
  for (const [name, label, def, type] of FIELDS) {
    inputs[name] = h('input', { name, type, value: String(def), step: 'any' });
    form.append(h('label', h('span', label), inputs[name]));
  }
  inputs.timeout_policy = h('select', { name: 'timeout_policy' },
    h('option', { value: 'Wait' }, 'Wait for everyone'),
    h('option', { value: 'RepeatLast' }, 'Repeat last orders on timeout'));
  form.append(h('label', h('span', 'When the timer runs out'), inputs.timeout_policy));
  const msg = h('p.error');
  form.append(h('button.primary', { type: 'submit' }, 'Create session'), msg);

  async function onCreate(e) {
    e.preventDefault();
    const cfg = {};
    for (const [name, , , type] of FIELDS) {
      const v = inputs[name].value.trim();
      if (v === '') continue;
      cfg[name] = Number(v);
    }
    cfg.timeout_policy = inputs.timeout_policy.value;
    try {
      await unlock();
      const { session_id, host_token } = await api.createSession(cfg);
      // The host takes a seat like everyone else; the two tokens are unrelated on the server.
      const { seat_token } = await api.join(session_id);
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
      h('div.card', h('h2', 'Join a session'),
        h('form', { onsubmit: (e) => {
          e.preventDefault();
          const m = /([0-9a-f]{10})\s*$/i.exec(code.value.replace(/\?.*$/, ''));
          if (m) location.hash = `#/s/${m[1].toLowerCase()}`;
        } }, code, h('button', { type: 'submit' }, 'Open')))));
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
  const full = info.seat_count >= info.config.seats;
  const msg = h('p.error');
  root.append(h('div.card',
    h('h2', 'Join session'),
    h('p', `${info.seat_count} / ${info.config.seats} seats taken · ${info.config.bpm} BPM · ${info.config.bars} bars`),
    info.phase === 'ended' ? h('p', 'This session has ended.') : null,
    tokens.host && !tokens.seat ? h('p.muted', 'You hold the host token for this session.') : null,
    h('button.primary', {
      disabled: full || info.phase === 'ended',
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
    }, full ? 'Session is full' : 'Take a seat'),
    msg));
}

window.addEventListener('hashchange', route);
route();
