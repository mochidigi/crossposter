const ICONS = Object.freeze({
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.93 4.93l2.12 2.12m9.9 9.9 2.12 2.12M2 12h3m14 0h3M4.93 19.07l2.12-2.12m9.9-9.9 2.12-2.12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  import: '<path d="M12 3v12m-4-4 4 4 4-4M5 19h14"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 19h14"/>',
  link: '<path d="m10.5 13.5 3-3m-6.3 6.3-1 .9a3.5 3.5 0 1 1-4.9-4.9l3.5-3.5a3.5 3.5 0 0 1 4.9 0m7.1-2.1 1-.9a3.5 3.5 0 1 1 4.9 4.9l-3.5 3.5a3.5 3.5 0 0 1-4.9 0"/>',
  "arrow-right": '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  "arrow-up-right": '<path d="M7 17 17 7M8 7h9v9"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  play: '<path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none"/>',
  scissors: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="m8.7 8.3 10.3 5.2M8.7 15.7 19 10.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7M10 11v6M14 11v6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  "mark-start": '<path d="M6 4v16M18 7l-5 5 5 5"/>',
  "mark-end": '<path d="M18 4v16M6 7l5 5-5 5"/>'
});

export function icon(name, className = "ui-icon") {
  if (!ICONS[name]) throw new Error(`Unknown icon: ${name}`);
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
