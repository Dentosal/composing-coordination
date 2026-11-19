// Save data as a file download.
import { h } from './dom.js';

/** Download `text` as a file called `filename`. */
export function downloadText(filename, text, type = 'application/json') {
  downloadBlob(filename, new Blob([text], { type }));
}

/** Download a Blob as a file called `filename`. */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
