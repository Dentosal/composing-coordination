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
export const join = (sid) => req('POST', `/${sid}/join`);
export const start = (sid, token) => req('POST', `/${sid}/start`, { token });
export const end = (sid, token) => req('POST', `/${sid}/end`, { token });
export const getState = (sid, token) => req('GET', `/${sid}/state`, { token });
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

export async function fetchMix(sid, token, n) {
  const r = await fetch(`/api/sessions/${sid}/rounds/${n}/mix.wav?token=${token}`);
  if (!r.ok) throw new Error(`mix ${n}: ${r.status}`);
  return r.arrayBuffer();
}

export const songUrl = (sid, token, download = false) =>
  `/api/sessions/${sid}/song.wav?token=${token}${download ? '&download=1' : ''}`;

export const eventsUrl = (sid, token) => `/api/sessions/${sid}/events?token=${token}`;
