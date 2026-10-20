// Import GPX / zip / JSON into the database. Codes already in `seen` are skipped
// unless a re-check is asked for; your answers (user store) are never touched.

import { unzip } from './zip.js';
import { parseGpxFiles } from './gpx.js';
import { analyze, CANDIDATE_TYPES } from './detect.js';
import * as db from './store.js';

const BASIC = ['name', 'type', 'difficulty', 'terrain', 'container', 'owner', 'hint', 'archived', 'available', 'lat', 'lon', 'url', 'descHtml', 'waypoints'];

export async function readFiles(files) {
  const gpx = [];
  const json = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    if (name.endsWith('.zip')) {
      for (const e of await unzip(await f.arrayBuffer())) if (e.name.toLowerCase().endsWith('.gpx')) gpx.push(await e.text());
    } else if (name.endsWith('.json')) {
      json.push(JSON.parse(await f.text()));
    } else {
      gpx.push(await f.text());
    }
  }
  return { gpx, json };
}

export const gpxCodes = (texts) => parseGpxFiles(texts).map((c) => c.code);

// Mark caches you've already solved elsewhere (e.g. a geocaching.com list) as done.
// The flag lives in the user store, so later imports never clear it.
export async function markDone(codes) {
  const user = new Map((await db.getAll('user')).map((u) => [u.code, u]));
  const known = new Set((await db.getAll('caches')).map((c) => c.code));
  const list = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter((c) => /^GC[0-9A-Z]+$/.test(c)))];
  await db.putMany('user', list.map((code) => ({ values: {}, ...user.get(code), code, done: true })));
  return { marked: list.length, inDatabase: list.filter((c) => known.has(c)).length };
}

export async function importGpx(texts, { recheck = false } = {}) {
  const caches = parseGpxFiles(texts);
  const seen = new Map((await db.getAll('seen')).map((s) => [s.code, s]));
  const existing = new Map((await db.getAll('caches')).map((c) => [c.code, c]));
  const stats = { total: caches.length, added: 0, known: 0, rechecked: 0, candidates: 0, field: 0 };
  const putCaches = [];
  const putSeen = [];
  const now = new Date().toISOString();
  for (const c of caches) {
    const known = seen.get(c.code);
    if (known && !recheck) { stats.known++; continue; }
    known ? stats.rechecked++ : stats.added++;
    let rec = null;
    if (CANDIDATE_TYPES.includes(c.type)) {
      stats.candidates++;
      const old = existing.get(c.code);
      if (old && (old.source === 'curated' || old.edited)) {
        rec = { ...old };
        for (const k of BASIC) rec[k] = c[k];
      } else {
        rec = { ...c, ...analyze(c) };
      }
      if (rec.field) stats.field++;
      putCaches.push(rec);
    }
    putSeen.push({ code: c.code, name: c.name, type: c.type, field: !!rec?.field, firstSeen: known?.firstSeen || now });
  }
  await db.putMany('caches', putCaches);
  await db.putMany('seen', putSeen);
  return stats;
}

// JSON from Claude's AI pass (kind "curated") or an app backup (kind "backup").
export async function importJson(obj) {
  if (obj?.format !== 'geofieldsolver') throw new Error('Not a GeoFieldSolver file');
  const backup = obj.kind === 'backup';
  const existing = new Map((await db.getAll('caches')).map((c) => [c.code, c]));
  const seen = new Map((await db.getAll('seen')).map((s) => [s.code, s]));
  const stats = { added: 0, updated: 0, keptEdited: 0, field: 0, seen: 0 };
  const putCaches = [];
  for (const rec of obj.caches || []) {
    const old = existing.get(rec.code);
    if (old?.edited && !backup) { stats.keptEdited++; continue; }
    old ? stats.updated++ : stats.added++;
    if (rec.field) stats.field++;
    putCaches.push(rec);
  }
  const now = new Date().toISOString();
  const putSeen = (obj.seen || []).map((s) => (typeof s === 'string' ? { code: s } : s))
    .filter((s) => backup || !seen.has(s.code))
    .map((s) => ({ firstSeen: now, ...s }));
  stats.seen = putSeen.length;
  await db.putMany('caches', putCaches);
  await db.putMany('seen', putSeen);
  if (backup && obj.user) await db.putMany('user', obj.user);
  return stats;
}

export async function exportBackup() {
  return {
    format: 'geofieldsolver', version: 1, kind: 'backup', exported: new Date().toISOString(),
    caches: await db.getAll('caches'), user: await db.getAll('user'), seen: await db.getAll('seen'),
  };
}
