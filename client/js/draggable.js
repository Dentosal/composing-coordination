// Lets a fixed-position element (a floating, non-modal dialog) be moved by dragging a handle inside it.

/**
 * @param {HTMLElement} el the floating element (position: fixed)
 * @param {HTMLElement} handle the part that is dragged, e.g. its header; buttons inside it still just click
 */
export function dragByHandle(el, handle) {
  let moved = false; // once dragged, it keeps its own position (and is kept inside the window)
  const place = (left, top) => {
    const l = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - el.offsetWidth));
    const t = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - el.offsetHeight));
    Object.assign(el.style, { left: `${l}px`, top: `${t}px`, right: 'auto', bottom: 'auto' });
  };
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select, textarea, a')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const move = (ev) => { moved = true; place(ev.clientX - dx, ev.clientY - dy); };
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  // A smaller window must not leave a moved dialog out of reach.
  window.addEventListener('resize', () => {
    if (!moved) return;
    const r = el.getBoundingClientRect();
    place(r.left, r.top);
  });
}
