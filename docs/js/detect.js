// Offline detector: decides whether a cache needs on-site values and pulls out
// the stages, questions, derived values and final coordinate formula.
// Tuned for Latvian listings (with English/German/Russian fallbacks).

import { htmlToText } from './text.js';
import { splitLatLon, templateVars, findPlainCoords, formatCoord, parse, varsIn, targetNames } from './formula.js';

export const CANDIDATE_TYPES = ['Multi-cache', 'Unknown Cache', 'Letterbox Hybrid', 'Wherigo Cache'];

const FIELD_WORDS = [
  /saskait/i, /(^|\s)cik(\s|$)/i, /izmēr/i, /dabā/i, /uz vietas/i, /jāatrod|atrodi/i, /plāksn/i, /uzrakst/i,
  /gadaskait/i, /cipar/i, /stab/i, /ceļa zīm|zīmes/i, /log(u|i)\b/i, /pakāpien/i, /how many/i, /\bcount\b/i,
  /plaque|inscription|\bsign\b/i, /measure/i, /wie viele|zähl/i, /сколько/i,
];
const HOME_WORDS = [/mīkl/i, /sudoku|nonogram|nanogram|krustvārd/i, /šifr|cipher|kodē/i, /internet|google|wiki/i, /puzzle|rebus/i, /bild(e|ē)|attēl/i];
const FINAL_LABEL = /gal(a|ā)|fin[aā]l|slēpn|slepn|konteiner|cache|atrod|location|ziel|tīkl/i;

const DEG = '[°º˚*\'.]';
const LAT_RE = new RegExp(`(?<![\\p{L}\\d])([NSZ])\\s*:?\\s*(\\d{1,2})(?=\\s*${DEG}|\\s+[\\d\\p{Lu}(\\[])`, 'gu');
const LON_START = /^\s*([EW])\s*:?\s*\d/;
const HEAD = new RegExp(`^[NSZEWA]\\s*:?\\s*\\d{1,3}\\s*${DEG}?\\s*`, 'u');

const fixMarks = (s) => s.replace(/(?<=[\d\s])[̀-ͯ]+/g, '°');
const TPL_CHAR = /[\d\p{L}()\[\]{}+\-*/×x·:.,\s'°º˚′–]/u;
// Cut a template where it stops looking like a formula: an unbalanced ")" or a word
// with lowercase letters (prose), except "ExBxD"-style multiplication and "xxx" placeholders.
function cutProse(s) {
  let depth = 0;
  let end = 0;
  for (; end < s.length; end++) {
    const ch = s[end];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
    else if (!TPL_CHAR.test(ch) || (ch === ' ' && s[end + 1] === ' ')) break;
  }
  let t = s.slice(0, end);
  for (const m of t.matchAll(/\p{L}+/gu)) {
    const w = m[0];
    if (m.index < 2) continue; // hemisphere letter
    if (/\p{Ll}/u.test(w) && !/^\p{Lu}(x\p{Lu})+$/u.test(w) && !/^[xy]+$/.test(w)) { t = t.slice(0, m.index); break; }
  }
  return t.replace(/[\s,.:;–-]+$/, '').trim();
}
const hasVars = (part) => /[\p{L}(\[]/u.test(part.replace(HEAD, ''));

function findTemplates(lines) {
  const found = [];
  const seen = new Set();
  lines.forEach((line, i) => {
    const L = fixMarks(line);
    for (const m of L.matchAll(LAT_RE)) {
      const rest = L.slice(m.index);
      let [lat, lon] = splitLatLon(rest);
      if (!lon && LON_START.test(lines[i + 1] || '')) lon = fixMarks(lines[i + 1]);
      lat = cutProse(lat);
      lon = cutProse(lon);
      if (!lon || !(hasVars(lat) || hasVars(lon))) continue;
      if (!/[.,]/.test(lat.replace(HEAD, '') + lon.replace(HEAD, ''))) continue;
      if ((lat + lon).length > 90) continue;
      lat = lat.replace(/^Z/, 'N');
      const key = (lat + '|' + lon).replace(/\s/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      let label = L.slice(0, m.index).trim().replace(/[:\-–\s]+$/, '');
      if (!label && i > 0 && lines[i - 1].length < 60 && !EXPR_LINE.test(lines[i - 1])) label = lines[i - 1].replace(/[:\-–\s]+$/, '');
      found.push({ label: label.slice(0, 50), latTpl: lat, lonTpl: lon, line: i });
    }
  });
  return found;
}

const EXPR_CHARS = /^[\p{Lu}\d\s+\-–*/×x·:()\[\]^%.,…]+$/u;
const EXPR_LINE = /^\s*\p{Lu}[\p{Lu}\d]*\s*=\s*[\p{Lu}\d\s+\-–*/×x·:()]+$/u;
const OPERATORISH = /[\p{Lu}+\-–*/×x·:^]/u;
const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// "Q+A+B+C+D+……+R" -> fill the gap with the Latin letters D..R not already listed.
function expandEllipsis(expr) {
  return expr.replace(/(\p{Lu})\s*\+\s*…\s*\+\s*(\p{Lu})/gu, (all, a, b) => {
    const i = LATIN.indexOf(a), j = LATIN.indexOf(b);
    if (i < 0 || j <= i) return all;
    const listed = new Set(expr.match(/\p{Lu}/gu));
    const mid = [...LATIN.slice(i + 1, j)].filter((l) => !listed.has(l));
    return [a, ...mid, b].join('+');
  });
}

function findDerived(lines, allowed) {
  const out = [];
  for (const raw of lines) {
    const L = expandEllipsis(raw.replace(/…+|\.{3,}/g, '…').replace(/\+\s*[….]+\s*\+/g, '+…+'));
    let m = L.match(/^\s*(\p{Lu}[\p{Lu}\d]*)\s*=\s*(.+?)\s*$/u);
    if (m && EXPR_CHARS.test(m[2]) && !m[2].includes('…')) {
      const pureNumber = /^\d+$/.test(m[2].trim());
      if ((!pureNumber && OPERATORISH.test(m[2])) || (pureNumber && allowed.has(m[1]))) {
        if (!pureNumber || targetNames(m[1]).every((t) => allowed.has(t))) out.push({ target: m[1], expr: m[2].trim() });
        continue;
      }
    }
    m = L.match(/^\s*(.+?)\s*=\s*(\p{Lu}{2,})\s*\.?$/u);
    if (m && EXPR_CHARS.test(m[1]) && /\p{Lu}/u.test(m[1]) && !m[1].includes('…')) out.push({ target: m[2], expr: m[1].trim() });
  }
  // Validate: must parse.
  return out.filter((d) => { try { parse(d.expr); return true; } catch { return false; } });
}

const VALUE_WORD = /(?:[Vv]ērtīb\p{Ll}*|[Vv]alue|[Ww]ert|[Bb]urts|[Ll]etter|[Mm]ainīg\p{Ll}*)\s+(\p{Lu}\d?)(?![\p{L}])/u;

// Return [{name, text, strong}] for question patterns on one line.
// strong = explicit "A = question" / "Vērtība A" forms, trusted even without a formula.
function questionsOnLine(line) {
  const out = [];
  let m = line.match(/^\s*(?:\d+[.)]\s*)?(\p{Lu}\d?)\s*(?:[=:)–—-]|\.\s)\s*(.{4,})$/u);
  if (m && /\p{Ll}{2,}/u.test(m[2]) && !EXPR_CHARS.test(m[2])) out.push({ name: m[1], text: m[2].trim(), strong: true });
  m = line.match(VALUE_WORD);
  if (m) out.push({ name: m[1], text: line.trim(), header: line.length < 45, strong: true });
  m = line.match(/[(\[]\s*(\p{Lu}\d?)\s*[)\]]\s*[.?!]?\s*$/u) || line.match(/[?.]\s*[-–=]?\s*(\p{Lu}\d?)\s*[.=]?\s*$/u);
  if (m && /\p{Ll}{3,}/u.test(line)) out.push({ name: m[1], text: line.trim() });
  return out;
}

// How the cache is solved. field = values on site, home = at home / on a PC.
export const TAGS = {
  field: 'on site', home: 'home / PC', film: 'film', jigidi: 'jigidi', online: 'internet',
  ticket: 'ticket', boat: 'boat', passport: 'passport', night: 'night',
};

function guessTags(cache, text, field) {
  const tags = [field ? 'field' : 'home'];
  const html = cache.descHtml || '';
  if (/jigidi\.com/i.test(html)) tags.push('jigidi');
  if (/\b(filmu|filmā|filmas|noskaties|noskatoties|movie|film)\b/i.test(text)) tags.push('film');
  if (/internet|google|wiki|tīmekl/i.test(text)) tags.push('online');
  if (/biļet|darba laik|ticket|opening hours/i.test(text)) tags.push('ticket');
  if (/laiv|airē|kanoe|boat|kayak/i.test(text)) tags.push('boat');
  if (/pierobež|pase|border zone|passport/i.test(text)) tags.push('passport');
  if (/tumš\p{L}* diennakts|diennakts tumš|night cache|nakts slēpn/iu.test(text)) tags.push('night');
  return tags;
}

function coordsToTpl(lat, lon) {
  return { latTpl: formatCoord(lat, 'lat'), lonTpl: formatCoord(lon, 'lon') };
}

export function analyze(cache) {
  const text = htmlToText(cache.descHtml);
  const lines = text.split('\n');
  const reasons = [];

  // 1. Coordinate formulas: final + intermediate stages.
  const templates = findTemplates(lines);
  let finalIdx = -1;
  templates.forEach((t, i) => { if (FINAL_LABEL.test(t.label)) finalIdx = i; });
  if (finalIdx < 0) finalIdx = templates.length - 1;
  const final = templates[finalIdx] || null;
  const stageTemplates = templates.filter((_, i) => i !== finalIdx).slice(0, 8);

  const tplVars = new Set();
  for (const t of templates) for (const v of [...templateVars(t.latTpl), ...templateVars(t.lonTpl)]) tplVars.add(v);

  // 2. Derived values (S = J-H, (A+B)*3 = XYZ).
  const derived = findDerived(lines, tplVars);
  const derivedTargets = new Set(derived.flatMap((d) => targetNames(d.target)));
  const allowed = new Set(tplVars);
  for (const d of derived) for (const v of varsIn(parse(d.expr))) allowed.add(v);
  for (const t of derivedTargets) allowed.delete(t);
  const strict = allowed.size > 0;

  // 3. Stages: child waypoints first, then questions found in text.
  const stages = [];
  const variables = [];
  const byName = new Map();
  const addVar = (name, question, stage, strong = false) => {
    if (byName.has(name) || derivedTargets.has(name)) return;
    if (strict && !allowed.has(name) && !strong) return;
    const v = { name, question: question.slice(0, 400), stage };
    byName.set(name, v);
    variables.push(v);
  };

  for (const w of cache.waypoints || []) {
    if (!/Stage|Question|Reference/i.test(w.type) && !/\p{Lu}\s*[=:]/u.test(w.cmt)) continue;
    const cmtLines = (w.cmt || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const qs = cmtLines.flatMap(questionsOnLine);
    if (!qs.length && !/Stage/i.test(w.type)) continue;
    const idx = stages.length;
    stages.push({ label: w.name || w.code, ...(w.lat ? coordsToTpl(w.lat, w.lon) : { latTpl: '', lonTpl: '' }), note: qs.length ? '' : (w.cmt || '').slice(0, 400), wpt: w.code });
    for (const q of qs) addVar(q.name, q.header && qs.length === 1 ? cmtLines.join(' ') : q.text, idx, q.strong);
  }
  for (const t of stageTemplates) stages.push({ label: t.label || `Stage ${stages.length + 1}`, latTpl: t.latTpl, lonTpl: t.lonTpl, note: '' });

  const candidates = [];
  lines.forEach((line, i) => {
    for (const q of questionsOnLine(line)) {
      let textQ = q.text;
      if (q.header) { // "Pagaidu pozīcijas. Vērtība A." — the question follows on the next lines.
        const more = [];
        for (let k = i + 1; k < lines.length && more.join(' ').length < 350; k++) {
          if (questionsOnLine(lines[k]).length) break;
          more.push(lines[k]);
        }
        textQ = [q.text, ...more].join(' ');
      }
      candidates.push({ ...q, text: textQ, line: i });
    }
  });
  const strongCount = new Set(candidates.filter((c) => c.strong).map((c) => c.name)).size;
  if (strict || new Set(candidates.map((c) => c.name)).size >= 2) {
    for (const q of candidates) {
      if (byName.has(q.name)) continue;
      const at = findPlainCoords(q.text) || findPlainCoords(lines[q.line - 1] || '');
      let stage = null;
      if (at) {
        stage = stages.findIndex((s) => s.latTpl === formatCoord(at.lat, 'lat') && s.lonTpl === formatCoord(at.lon, 'lon'));
        if (stage < 0) { stage = stages.length; stages.push({ label: `Stage ${stages.length + 1}`, ...coordsToTpl(at.lat, at.lon), note: '' }); }
      }
      addVar(q.name, q.text, stage, q.strong && strongCount >= 2);
    }
  }
  // Letters used in formulas without a found question still need an input.
  for (const v of [...allowed].sort((a, b) => a.localeCompare(b, 'lv'))) addVar(v, '', null);

  // 4. Score.
  let score = 0;
  if (/Multi|Letterbox|Wherigo/.test(cache.type)) { score += 2; reasons.push(cache.type); }
  if (final) { score += 3; reasons.push('coordinate formula'); }
  const asked = variables.filter((v) => v.question).length;
  if (asked >= 2) { score += 2; reasons.push(`${asked} questions`); }
  const stageWpts = (cache.waypoints || []).filter((w) => /Stage/.test(w.type)).length;
  if (stageWpts) { score += Math.min(2, stageWpts); reasons.push(`${stageWpts} stage waypoints`); }
  const fw = FIELD_WORDS.filter((r) => r.test(text)).length;
  if (fw) { score += Math.min(3, fw); reasons.push(`${fw} on-site words`); }
  const hw = HOME_WORDS.filter((r) => r.test(text)).length;
  if (hw) { score -= Math.min(2, hw); reasons.push(`${hw} home-puzzle words`); }
  const field = score >= 5 || (!!final && asked >= 2);

  return {
    field,
    tags: guessTags(cache, text, field),
    score,
    reasons,
    stages,
    variables,
    derived: derived.map(({ target, expr }) => ({ target, expr })),
    final: final ? { latTpl: final.latTpl, lonTpl: final.lonTpl } : { latTpl: '', lonTpl: '' },
    source: 'regex',
  };
}
