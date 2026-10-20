// Geocaching.com Pocket Query GPX parser (main file + "-wpts" file, or both merged).

import { plainToHtml } from './text.js';

const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0];
const txt = (el, name) => { const k = kid(el, name); return k ? k.textContent.trim() : ''; };

function descHtml(el) {
  if (!el) return '';
  const body = el.textContent;
  return el.getAttribute('html') === 'True' ? body : plainToHtml(body.trim());
}

export function parseGpx(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Not a valid GPX file');
  const caches = [];
  const waypoints = [];
  for (const w of doc.getElementsByTagNameNS('*', 'wpt')) {
    const lat = Number(w.getAttribute('lat'));
    const lon = Number(w.getAttribute('lon'));
    const code = txt(w, 'name');
    const gc = kid(w, 'cache');
    if (gc) {
      caches.push({
        code,
        name: txt(gc, 'name') || txt(w, 'urlname'),
        type: txt(gc, 'type'),
        difficulty: Number(txt(gc, 'difficulty')) || null,
        terrain: Number(txt(gc, 'terrain')) || null,
        container: txt(gc, 'container'),
        owner: txt(gc, 'placed_by'),
        hint: txt(gc, 'encoded_hints'),
        archived: gc.getAttribute('archived') === 'True',
        available: gc.getAttribute('available') !== 'False',
        lat, lon,
        url: txt(w, 'url') || `https://coord.info/${code}`,
        descHtml: [descHtml(kid(gc, 'short_description')), descHtml(kid(gc, 'long_description'))].filter(Boolean).join('<hr>'),
        waypoints: [],
      });
    } else {
      waypoints.push({
        code,
        parent: 'GC' + code.slice(2),
        name: txt(w, 'desc') || txt(w, 'urlname'),
        type: txt(w, 'type').replace(/^Waypoint\|/, ''),
        lat: lat || null,
        lon: lon || null,
        cmt: txt(w, 'cmt'),
      });
    }
  }
  return { caches, waypoints };
}

// Parse several GPX texts and attach child waypoints to their caches.
export function parseGpxFiles(texts) {
  const caches = [];
  const waypoints = [];
  for (const t of texts) {
    const r = parseGpx(t);
    caches.push(...r.caches);
    waypoints.push(...r.waypoints);
  }
  const byCode = new Map(caches.map((c) => [c.code, c]));
  for (const w of waypoints) byCode.get(w.parent)?.waypoints.push(w);
  return caches;
}
