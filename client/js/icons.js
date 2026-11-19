// Inline icons (static markup, stroke-only so they follow the text colour). Usage: button.append(icon('download')).
const SVG = (inner) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  speaker: SVG('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  muted: SVG('<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M16 9l6 6M22 9l-6 6"/>'),
  headphones: SVG('<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>'),
  pads: SVG('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  expand: SVG('<path d="M8 3H3v5"/><path d="M3 3l6 6"/><path d="M16 3h5v5"/><path d="M21 3l-6 6"/><path d="M8 21H3v-5"/><path d="M3 21l6-6"/><path d="M16 21h5v-5"/><path d="M21 21l-6-6"/>'),
  collapse: SVG('<path d="M9 3v6H3"/><path d="M3 9l6-6"/><path d="M15 3v6h6"/><path d="M21 9l-6-6"/><path d="M9 21v-6H3"/><path d="M3 15l6 6"/><path d="M15 21v-6h6"/><path d="M21 15l-6 6"/>'),
  plus: SVG('<path d="M12 5v14M5 12h14"/>'),
  trash: SVG('<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><path d="M10 11v6M14 11v6"/>'),
  download: SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'),
  user: SVG('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  upload: SVG('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>'),
};

export function icon(name) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = ICON[name];
  return s;
}
