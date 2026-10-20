// Formula engine: arithmetic expressions, coordinate templates and derived values.
//
// Conventions (match how geocache listings write formulas):
//   - Variables are letters of any script (A, Ģ, Л), optionally followed by digits when
//     such a name is declared (X1). Lowercase x between operands means multiply.
//   - Adjacent operands concatenate digits: AB with A=1, B=2 is 12; 5A is 5 then A.
//   - In a coordinate template every (...) / [...] group is evaluated and its integer
//     result written in place; bare letters are replaced by their values.
//   - Functions: ds(x) digit sum, dr(x) digital root, sd(x) digits sorted descending.

import { project } from './geo.js';

const OPS = { '×': '*', '·': '*', '∙': '*', '÷': '/', ':': '/', '–': '-', '—': '-', '−': '-' };

export class FormulaError extends Error {}

function isLetter(ch) { return /\p{L}/u.test(ch); }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }

// Longest declared name starting at s[i], else a single letter.
function readName(s, i, names) {
  for (const n of names) if (s.startsWith(n, i)) return n;
  return s[i];
}

function sortNames(names) {
  return [...new Set(names)].sort((a, b) => b.length - a.length);
}

export function tokenize(src, names = []) {
  const s = src.replace(/[×·∙÷:–—−]/g, (c) => OPS[c]);
  const sorted = sortNames(names);
  const out = [];
  let i = 0;
  const prevIsOperand = () => out.length && (out[out.length - 1].t === 'num' || out[out.length - 1].t === 'var' || out[out.length - 1].v === ')');
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (isDigit(ch)) {
      let j = i; while (j < s.length && isDigit(s[j])) j++;
      if (s[j] === '.' && isDigit(s[j + 1] || '')) { j++; while (j < s.length && isDigit(s[j])) j++; }
      out.push({ t: 'num', v: s.slice(i, j) }); i = j; continue;
    }
    if (ch === 'x' && !sorted.includes('x') && prevIsOperand()) { out.push({ t: 'op', v: '*' }); i++; continue; }
    if (/^(ds|dr|sd)\(/.test(s.slice(i))) { out.push({ t: 'fn', v: s.slice(i, i + 2) }); i += 2; continue; }
    if (isLetter(ch)) { const n = readName(s, i, sorted); out.push({ t: 'var', v: n }); i += n.length; continue; }
    if ('+-*/%^()[]{}'.includes(ch)) {
      const v = '([{'.includes(ch) ? '(' : ')]}'.includes(ch) ? ')' : ch;
      out.push({ t: 'op', v }); i++; continue;
    }
    if (ch === '.' || ch === ',') { i++; continue; } // stray separators (e.g. "+……+") are ignored
    throw new FormulaError(`Unexpected "${ch}"`);
  }
  return out;
}

export function parse(src, names = []) {
  const toks = tokenize(src, names);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v) => { if (peek() && peek().v === v) { p++; return true; } return false; };
  const startsOperand = (t) => t && (t.t === 'num' || t.t === 'var' || t.t === 'fn' || t.v === '(');

  function expr() {
    let n = term();
    while (peek() && (peek().v === '+' || peek().v === '-')) { const op = toks[p++].v; n = { op, a: n, b: term() }; }
    return n;
  }
  function term() {
    let n = power();
    while (peek() && '*/%'.includes(peek().v) && peek().t === 'op') { const op = toks[p++].v; n = { op, a: n, b: power() }; }
    return n;
  }
  function power() {
    const n = unary();
    if (eat('^')) return { op: '^', a: n, b: power() };
    return n;
  }
  function unary() {
    if (eat('-')) return { op: 'neg', a: unary() };
    if (eat('+')) return unary();
    return concat();
  }
  function concat() {
    let n = primary();
    while (startsOperand(peek())) n = { op: 'cat', a: n, b: primary() };
    return n;
  }
  function primary() {
    const t = toks[p++];
    if (!t) throw new FormulaError('Formula ends too early');
    if (t.t === 'num') return { num: Number(t.v) };
    if (t.t === 'var') return { v: t.v };
    if (t.t === 'fn') {
      if (!eat('(')) throw new FormulaError(`${t.v} needs (`);
      const a = expr();
      if (!eat(')')) throw new FormulaError('Missing )');
      return { op: t.v, a };
    }
    if (t.v === '(') {
      const n = expr();
      if (!eat(')')) throw new FormulaError('Missing )');
      return n;
    }
    throw new FormulaError(`Unexpected "${t.v}"`);
  }

  const tree = expr();
  if (p < toks.length) throw new FormulaError(`Unexpected "${toks[p].v}"`);
  return tree;
}

export function varsIn(tree, acc = new Set()) {
  if (tree.v) acc.add(tree.v);
  if (tree.a) varsIn(tree.a, acc);
  if (tree.b) varsIn(tree.b, acc);
  return acc;
}

const digitSum = (n) => String(Math.abs(Math.trunc(n))).split('').reduce((s, d) => s + Number(d), 0);

function evalTree(n, env) {
  if ('num' in n) return n.num;
  if (n.v) return env[n.v];
  const a = evalTree(n.a, env);
  switch (n.op) {
    case 'neg': return -a;
    case 'ds': return digitSum(a);
    case 'dr': { let x = Math.abs(Math.trunc(a)); while (x > 9) x = digitSum(x); return x; }
    case 'sd': return Number(String(Math.abs(Math.trunc(a))).split('').sort((x, y) => y - x).join(''));
  }
  const b = evalTree(n.b, env);
  switch (n.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': if (b === 0) throw new FormulaError('Division by zero'); return a / b;
    case '%': return a % b;
    case '^': return a ** b;
    case 'cat':
      if (!isWhole(a) || !isWhole(b) || a < 0 || b < 0) throw new FormulaError('Can only join whole positive numbers');
      return Number(String(a) + String(b));
  }
  throw new FormulaError('Bad formula');
}

const isWhole = (x) => Math.abs(x - Math.round(x)) < 1e-9;
const clean = (x) => (isWhole(x) ? Math.round(x) : Math.round(x * 1e9) / 1e9);

// -> { value } | { missing: [...] } | { error }
export function evaluate(src, env, names = []) {
  try {
    const tree = parse(src, names);
    const missing = [...varsIn(tree)].filter((v) => env[v] === undefined);
    if (missing.length) return { missing };
    return { value: clean(evalTree(tree, env)) };
  } catch (e) {
    return { error: e.message };
  }
}

export function namesOf(variables = [], derived = []) {
  const names = variables.map((v) => v.name);
  for (const d of derived) names.push(...targetNames(d.target));
  return sortNames(names);
}

// "STVXYZ" -> one digit each; "X62X63X64" -> X62, X63, X64; "X1" or "Q" -> a single value.
export function targetNames(target) {
  const t = target.trim();
  if (/^\p{L}\d*$/u.test(t)) return [t];
  if (/^(\p{L}\d*)+$/u.test(t)) return t.match(/\p{L}\d*/gu);
  return [...t].filter(isLetter);
}

function parseValue(s) {
  if (s === undefined || s === null) return undefined;
  const t = String(s).trim().replace(',', '.');
  if (t === '' || isNaN(Number(t))) return undefined;
  return Number(t);
}

// Fill env from user values, then resolve derived values (in any order they depend on).
export function computeEnv(variables, derived, values) {
  const names = namesOf(variables, derived);
  const env = {};
  for (const v of variables) {
    const x = parseValue(values[v.name]);
    if (x !== undefined) env[v.name] = x;
  }
  const results = derived.map(() => ({}));
  for (let pass = 0; pass <= derived.length; pass++) {
    let progress = false;
    derived.forEach((d, i) => {
      if (results[i].done) return;
      const r = evaluate(d.expr, env, names);
      results[i] = r;
      if (r.value === undefined) return;
      const targets = targetNames(d.target);
      if (targets.length === 1) {
        env[targets[0]] = r.value;
      } else {
        if (!isWhole(r.value) || r.value < 0) { results[i] = { error: `${r.value} is not a whole positive number` }; return; }
        let digits = String(r.value);
        if (digits.length > targets.length) { results[i] = { value: r.value, error: `${digits.length} digits, expected ${targets.length}` }; return; }
        digits = digits.padStart(targets.length, '0');
        targets.forEach((t, k) => { env[t] = Number(digits[k]); });
      }
      results[i].done = true;
      progress = true;
    });
    if (!progress) break;
  }
  return { env, derived: results, names };
}

// ---- coordinate templates ----

const HEMI = /^\s*([NSZEWA])\s*:?\s*/;

// Replace (expr) groups and letters in a template with values.
export function fillTemplate(tpl, env, names = []) {
  const sorted = sortNames(names);
  const missing = new Set();
  const errors = [];
  const m = tpl.match(HEMI);
  let out = m ? m[1] + ' ' : '';
  let i = m ? m[0].length : 0;
  const s = tpl;
  while (i < s.length) {
    const ch = s[i];
    if ('([{'.includes(ch)) {
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        if ('([{'.includes(s[j])) depth++;
        else if (')]}'.includes(s[j]) && --depth === 0) break;
      }
      const inner = s.slice(i + 1, j);
      const r = evaluate(inner, env, sorted);
      if (r.missing) { r.missing.forEach((v) => missing.add(v)); out += '?'; }
      else if (r.error) { errors.push(`(${inner}): ${r.error}`); out += '?'; }
      else if (!isWhole(r.value) || r.value < 0) { errors.push(`(${inner}) = ${r.value}, not a whole positive number`); out += '?'; }
      else out += String(r.value);
      i = j + 1;
      continue;
    }
    if (isLetter(ch)) {
      const n = readName(s, i, sorted);
      const v = env[n];
      if (v === undefined) { missing.add(n); out += '?'; }
      else if (!isWhole(v) || v < 0) { errors.push(`${n} = ${v}, not a whole positive number`); out += '?'; }
      else out += String(v);
      i += n.length;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out.trim(), missing: [...missing], errors };
}

export function templateVars(tpl, names = []) {
  return fillTemplate(tpl, {}, names).missing;
}

// "N 56° 57.123" -> { value, hemi, deg, min } or { error }
export function parseDM(text, axis) {
  const t = text.replace(/[̀-ͯ]/g, '°').trim();
  const dec = t.match(/^([NSZEWA])?\s*:?\s*(\d{1,3}[.,]\d{3,})\s*°?$/);
  if (dec) {
    let hemi = dec[1] || (axis === 'lat' ? 'N' : 'E');
    hemi = { Z: 'N', A: 'E' }[hemi] || hemi;
    const v = Number(dec[2].replace(',', '.'));
    if (axis === 'lat' ? v > 90 || !'NS'.includes(hemi) : v > 180 || !'EW'.includes(hemi)) return { error: `Bad coordinate "${text}"` };
    return { value: hemi === 'S' || hemi === 'W' ? -v : v };
  }
  const m = t.match(/^([NSZEWA])?\s*:?\s*(\d{1,3})(?:\s*[°º˚*'.]\s*|\s+)(\d{1,2})\s*[.,]\s*(\d+)\s*['′]?$/);
  if (!m) return { error: `Can't read "${text}"` };
  let hemi = m[1] || (axis === 'lat' ? 'N' : 'E');
  if (hemi === 'Z') hemi = 'N';
  if (hemi === 'A') hemi = 'E';
  const deg = Number(m[2]);
  const min = Number(m[3] + '.' + m[4]);
  if (min >= 60) return { error: `Minutes ${min} ≥ 60` };
  if (axis === 'lat' && (deg > 90 || !'NS'.includes(hemi))) return { error: `Bad latitude "${text}"` };
  if (axis === 'lon' && (deg > 180 || !'EW'.includes(hemi))) return { error: `Bad longitude "${text}"` };
  const sign = hemi === 'S' || hemi === 'W' ? -1 : 1;
  const warn = m[4].length !== 3 ? `${m[4].length} decimal digits` : null;
  return { value: sign * (deg + min / 60), warn };
}

// Evaluate a pair of templates into coordinates.
export function evalCoords(latTpl, lonTpl, env, names) {
  const a = fillTemplate(latTpl || '', env, names);
  const b = fillTemplate(lonTpl || '', env, names);
  const missing = [...new Set([...a.missing, ...b.missing])];
  const errors = [...a.errors, ...b.errors];
  const res = { latText: a.text, lonText: b.text, missing, errors, warnings: [] };
  if (missing.length || errors.length) return res;
  const la = parseDM(a.text, 'lat');
  const lo = parseDM(b.text, 'lon');
  if (la.error) errors.push(la.error);
  if (lo.error) errors.push(lo.error);
  if (errors.length) return res;
  if (la.warn) res.warnings.push(`Latitude has ${la.warn}`);
  if (lo.warn) res.warnings.push(`Longitude has ${lo.warn}`);
  res.ok = true;
  res.lat = la.value;
  res.lon = lo.value;
  return res;
}

// Coordinates plus an optional projection { bearing, distance } (expressions, degrees / metres).
export function evalTarget(t, env, names) {
  if (!t?.latTpl) return null;
  const r = evalCoords(t.latTpl, t.lonTpl, env, names);
  if (!t.bearing || !r.ok) return r;
  const b = evaluate(t.bearing, env, names);
  const d = evaluate(t.distance || '0', env, names);
  const missing = [...(b.missing || []), ...(d.missing || [])];
  if (missing.length || b.error || d.error) {
    return { ...r, ok: false, missing, errors: [b.error, d.error].filter(Boolean), latText: `${r.latText} → ${t.bearing}°`, lonText: `${t.distance} m` };
  }
  const p = project(r.lat, r.lon, b.value, d.value);
  return { ...r, lat: p.lat, lon: p.lon, projected: { from: [r.lat, r.lon], bearing: b.value, distance: d.value } };
}

// Split "N 56 5A.(B) E 24 0C.DEF" into its latitude and longitude halves.
export function splitLatLon(text) {
  const s = text.trim();
  const m = /\s([EWA])\s*:?\s*\d/.exec(s.slice(1));
  if (!m) return [s, ''];
  const k = m.index + 1;
  return [s.slice(0, k + 1).trim(), s.slice(k + 1).trim()];
}

export function formatCoord(value, axis) {
  const hemi = axis === 'lat' ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  const v = Math.abs(value);
  let deg = Math.floor(v);
  let min = Math.round((v - deg) * 60000) / 1000;
  if (min >= 60) { deg += 1; min -= 60; }
  const d = axis === 'lon' ? String(deg).padStart(3, '0') : String(deg).padStart(2, '0');
  return `${hemi} ${d}° ${min.toFixed(3).padStart(6, '0')}`;
}

export function formatLatLon(lat, lon) {
  return `${formatCoord(lat, 'lat')} ${formatCoord(lon, 'lon')}`;
}

// Find a plain coordinate like "N 57° 01.700 E 025° 43.383" in text.
const PLAIN = /([NSZ])\s*(\d{1,2})\s*[°º˚*]?\s*(\d{1,2}[.,]\d{1,3})\s*['′]?\s*[,;/]?\s*([EWA])\s*(\d{1,3})\s*[°º˚*]?\s*(\d{1,2}[.,]\d{1,3})/;
export function findPlainCoords(text) {
  const m = PLAIN.exec(text.replace(/[̀-ͯ]/g, '°'));
  if (!m) return null;
  const lat = parseDM(`${m[1]} ${m[2]} ${m[3]}`, 'lat');
  const lon = parseDM(`${m[4]} ${m[5]} ${m[6]}`, 'lon');
  if (lat.error || lon.error) return null;
  return { lat: lat.value, lon: lon.value, index: m.index, length: m[0].length };
}
