// Thin client for the server API. Tokens are passed explicitly.

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`/api/sessions${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!r.ok) {
    const e = new Error(data?.error || r.statusText);
    e.status = r.status;
    e.data = data;
    throw e;
  }
  return data;
}

export const createSession = (config) => req('POST', '', { body: config });
export const info = (sid) => req('GET', `/${sid}/info`);
/** Take a seat; `name` is the nickname (the server makes one up without it). */
export const join = (sid, name) => req('POST', `/${sid}/join`, name ? { body: { name } } : {});
/** Change this seat's nickname. Resolves to {ok, name} with the name as stored. */
export const setName = (sid, token, name) => req('PUT', `/${sid}/name`, { token, body: { name } });
export const start = (sid, token) => req('POST', `/${sid}/start`, { token });
export const end = (sid, token) => req('POST', `/${sid}/end`, { token });
export const getState = (sid, token) => req('GET', `/${sid}/state`, { token });
/** Freeform sessions: change the number of bars. */
export const setBars = (sid, token, bars) => req('PUT', `/${sid}/bars`, { token, body: { bars } });
/** Freeform sessions: change the tempo. */
export const setBpm = (sid, token, bpm) => req('PUT', `/${sid}/bpm`, { token, body: { bpm } });
/** Host: remove the player with join-order index `seat` from the session. */
export const kick = (sid, host, seat) => req('POST', `/${sid}/players/${seat}/kick`, { token: host });
/** Host: let the player with join-order index `seat`, waiting for the next round, play in the open round. */
export const admit = (sid, host, seat) => req('POST', `/${sid}/players/${seat}/admit`, { token: host });
export const setReady = (sid, token, ready) => req('POST', `/${sid}/ready`, { token, body: { ready } });

/** @returns {Promise<{ok:true}|{ok:false,errors:{path:string,message:string}[]}>} */
export async function putOrders(sid, token, orders) {
  try {
    return await req('PUT', `/${sid}/orders`, { token, body: orders });
  } catch (e) {
    if (e.status === 422 && e.data?.errors) return { ok: false, errors: e.data.errors };
    throw e;
  }
}

/** The parts played in resolved round `n`: [{seat, orders}], what its band mix was rendered from. */
export async function fetchRoundParts(sid, token, n) {
  const r = await fetch(`/api/sessions/${sid}/rounds/${n}/parts`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`parts of round ${n}: ${r.status}`);
  return r.json();
}

export async function fetchMix(sid, token, n) {
  const r = await fetch(`/api/sessions/${sid}/rounds/${n}/mix.wav?token=${token}`);
  if (!r.ok) throw new Error(`mix ${n}: ${r.status}`);
  return r.arrayBuffer();
}

/** WAV bytes from a response, or a thrown Error with the server's message (and `status`, `errors` from a 422). */
async function wavOf(r) {
  if (r.ok) return r.arrayBuffer();
  let data = null;
  try { data = await r.json(); } catch {}
  const e = new Error(data?.errors?.[0]?.message || data?.error || r.statusText);
  e.status = r.status;
  e.errors = data?.errors;
  throw e;
}

/** Render `orders` alone on the server as a song file (played once, ringing out at the end). Resolves to WAV bytes. */
export async function fetchRender(sid, token, orders) {
  return wavOf(await fetch(`/api/sessions/${sid}/render`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(orders),
  }));
}

/** Every round played so far, back to back, as a song file. Resolves to WAV bytes. */
export async function fetchSongSoFar(sid, token) {
  return wavOf(await fetch(`/api/sessions/${sid}/song-so-far.wav`, { headers: { Authorization: `Bearer ${token}` } }));
}

export const songUrl = (sid, token, download = false) =>
  `/api/sessions/${sid}/song.wav?token=${token}${download ? '&download=1' : ''}`;

export const eventsUrl = (sid, token) => `/api/sessions/${sid}/events?token=${token}`;

/**
 * Which code is this: `{server:{label,commit,dirty,fingerprint}, client:{...}}` from GET /api/version, or null when it
 * cannot be had (an old server, or no answer within a couple of seconds). Never throws.
 */
export async function version() {
  try {
    const r = await fetch('/api/version', { signal: AbortSignal.timeout(2500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
