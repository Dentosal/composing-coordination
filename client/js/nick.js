// The player's nickname, remembered in this browser for every session they create or join.

const KEY = 'band:nickname';
/** The longest nickname the server takes, in characters. */
export const MAX_NICK = 24;

/** The saved nickname, or '' (nothing saved, or no storage). */
export function loadNick() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function saveNick(name) {
  try {
    localStorage.setItem(KEY, name);
  } catch {}
}

/** A nickname as the server stores it: trimmed, inner whitespace made single spaces. */
export const tidyNick = (s) => s.trim().split(/\s+/).filter(Boolean).join(' ');
