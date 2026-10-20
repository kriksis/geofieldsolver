// HTML <-> text helpers for cache descriptions.

const BLOCK = /<\s*\/?\s*(br|p|div|li|tr|h[1-6]|table|ul|ol|blockquote)\b[^>]*>/gi;

export function htmlToText(html) {
  if (!html) return '';
  let s = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(BLOCK, '\n').replace(/<[^>]+>/g, '');
  const ta = document.createElement('textarea');
  ta.innerHTML = s;
  s = ta.value;
  return s
    .replace(/[ \t ​]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function plainToHtml(s) {
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

// Solution checkers linked from a listing (geocheck, certitude, ...), one per distinct URL.
const CHECKERS = /(?:^|\.)(geocheck\.(?:org|xyz)|geotjek\.dk|certitudes\.org|geochecker\.com|gc-apps\.com|puzzle-checker\.com|gccheck\.com|geocheckers?\.\w+|evince\.locusprime\.net)$/i;

export function checkerLinks(html) {
  const out = new Map();
  const s = String(html || '');
  for (const m of s.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    if (/src\s*=\s*["']?$/i.test(s.slice(Math.max(0, m.index - 8), m.index))) continue; // checker badge images
    const url = m[0].replace(/&amp;/g, '&').replace(/[).,;]+$/, '');
    let host;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (CHECKERS.test(host) && !out.has(url)) out.set(url, { url, host });
  }
  return [...out.values()];
}

const DROP ='script,style,iframe,object,embed,form,input,button,select,textarea,link,meta,base,frame,frameset,svg';

// Owner HTML is untrusted: keep structure, links and images, drop anything active.
export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  doc.querySelectorAll(DROP).forEach((e) => e.remove());
  for (const el of doc.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      const keep = ['href', 'src', 'alt', 'title', 'colspan', 'rowspan'].includes(n);
      if (!keep || /^\s*(javascript|vbscript):/i.test(a.value)) el.removeAttribute(a.name);
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    if (el.tagName === 'IMG') el.setAttribute('loading', 'lazy');
  }
  return doc.body.innerHTML;
}
