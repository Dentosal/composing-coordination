// A button that opens a small non-modal menu of actions below it (closed by Escape, a click outside, or the button).
import { h } from './dom.js';

/**
 * @typedef {{label:string, detail?:string, disabled?:boolean|string,
 *   run:(progress:(text:string)=>void)=>(void|Promise<void>)}} MenuItem
 * `disabled` may be a string: the reason, shown in place of the detail. `run` may be async: while it runs the item
 * shows "Working…" (or what it passes to `progress`) and the other items wait; when it finishes the menu closes, and
 * if it throws, the error is shown under the item. Closing the menu meanwhile does not stop it.
 */

/**
 * @param {HTMLButtonElement} btn the button that opens the menu (it gets aria-haspopup)
 * @param {() => (MenuItem|'sep')[]} items read each time the menu opens, so labels and states are current
 * @param {string} label the menu's accessible name
 */
export function menuButton(btn, items, label) {
  const dlg = h('dialog.menu-dialog', { 'aria-label': label });
  btn.setAttribute('aria-haspopup', 'menu');
  const wrap = h('div.menu-wrap', btn, dlg);
  let busy = false;

  const onDown = (e) => { if (!wrap.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    dlg.close();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function build() {
    const buttons = []; // [button, item]
    const rows = items().map((it) => {
      if (it === 'sep') return h('hr.menu-sep');
      const status = h('span.menu-detail', typeof it.disabled === 'string' ? it.disabled : it.detail ?? '');
      const b = h('button.menu-item', { type: 'button', role: 'menuitem', disabled: !!it.disabled }, h('span.menu-label', it.label), status);
      buttons.push([b, it]);
      b.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        for (const [x] of buttons) x.disabled = true;
        b.classList.add('busy');
        status.classList.remove('err');
        status.textContent = 'Working…';
        try {
          await it.run((text) => { status.textContent = text; });
          close();
          build(); // fresh labels and states next time
        } catch (e) {
          status.textContent = e?.message || String(e);
          status.classList.add('err');
          for (const [x, xit] of buttons) x.disabled = !!xit.disabled;
        } finally {
          busy = false;
          b.classList.remove('busy');
        }
      });
      return b;
    });
    dlg.replaceChildren(h('div.menu-list', { role: 'menu' }, rows));
  }
  function open() {
    if (!busy) build(); // while an item runs, keep showing its progress
    dlg.show(); // show(), not showModal(): the rest of the page stays interactive
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }
  btn.addEventListener('click', () => (dlg.open ? close() : open()));
  return wrap;
}
