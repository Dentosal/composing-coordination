// Question-mark help buttons: a small round button that opens a modal dialog with a short explanation.
import { h } from './dom.js';

/**
 * @param {{title:string, body:(string|Node)[], label?:string}} o  `body` items become paragraphs (strings) or are
 *   appended as they are (nodes, e.g. a list).
 * @returns {HTMLElement} a wrapper holding the button and its dialog
 */
export function helpButton({ title, body, label = 'Help' }) {
  const dlg = h('dialog.help-dialog', { 'aria-label': title, tabindex: '-1', autofocus: '' }, // the dialog itself takes focus, so a long one opens at its top
    h('h2', title),
    body.map((b) => (typeof b === 'string' ? h('p', b) : b)),
    h('div.help-actions', h('button.primary', { type: 'button', onclick: () => dlg.close() }, 'Got it')));
  // A click on the backdrop (the dialog element itself, outside its content box) closes it.
  dlg.addEventListener('click', (e) => {
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
  const btn = h('button.help-btn', { type: 'button', title: label, 'aria-label': label, 'aria-haspopup': 'dialog',
    onclick: () => { dlg.showModal(); dlg.scrollTop = 0; } }, '?'); // not scrolled down to the focused button
  // The dialog sits beside the button, not inside it: otherwise it inherits the button's text style and its clicks
  // would bubble to the button and reopen it.
  return h('span.help', btn, dlg);
}
