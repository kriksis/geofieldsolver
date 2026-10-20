import * as db from './store.js';
import { computeEnv, evalCoords, evalTarget, evaluate, formatLatLon, splitLatLon } from './formula.js';
import { distance, bearing, fmtDist, cardinal, mapLinks } from './geo.js';
import { escapeHtml as esc, sanitizeHtml, checkerLinks } from './text.js';
import { serialize, parseDsl } from './dsl.js';
import { readFiles, importGpx, importJson, exportBackup, gpxCodes, markDone } from './importer.js';
import { TAGS } from './detect.js';

const state = { caches: new Map(), user: new Map(), seenCount: 0, pos: null, gps: 'waiting', filter: 'field', q: '' };
const main = document.getElementById('main');
let viewCleanup = null;
let onPosition = null; // throttled redraw on GPS updates
let onPositionNow = null; // immediate redraw for the first fix or a GPS error
const compass = { wanted: true, granted: false }; // remembered between navigate views

// ---------- data ----------

async function load() {
  const [caches, user, seen] = await Promise.all([db.getAll('caches'), db.getAll('user'), db.getAll('seen')]);
  state.caches = new Map(caches.map((c) => [c.code, c]));
  state.user = new Map(user.map((u) => [u.code, u]));
  state.seenCount = seen.length;
}

const userOf = (code) => state.user.get(code) || { code, values: {} };

let saveTimer;
function saveUser(u) {
  u.updated = Date.now();
  state.user.set(u.code, u);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.put('user', u), 250);
}

async function saveCache(c) {
  state.caches.set(c.code, c);
  await db.put('caches', c);
}

function solve(c, values) {
  const { env, derived, names } = computeEnv(c.variables || [], c.derived || [], values);
  const stages = (c.stages || []).map((s) => (s.latTpl ? evalCoords(s.latTpl, s.lonTpl, env, names) : null));
  const final = evalTarget(c.final, env, names);
  const checks = (c.checks || []).map((k) => ({ ...k, r: evaluate(k.expr, env, names) }));
  const inputs = (c.variables || []).length;
  const filled = (c.variables || []).filter((v) => String(values[v.name] ?? '').trim() !== '').length;
  return { env, derived, stages, final, checks, inputs, filled };
}

// ---------- geolocation ----------

function startGps() {
  if (!navigator.geolocation) { state.gps = 'unsupported'; return; }
  navigator.geolocation.watchPosition(
    (p) => { const first = !state.pos; state.pos = p.coords; state.gps = 'ok'; first ? onPositionNow?.() : onPosition?.(); },
    (e) => { if (!state.pos) { state.gps = e.code === 1 ? 'denied' : 'error'; onPositionNow?.(); } },
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

const distTo = (lat, lon) => (state.pos ? distance(state.pos.latitude, state.pos.longitude, lat, lon) : null);

// ---------- routing ----------

function route() {
  viewCleanup?.();
  viewCleanup = null;
  onPosition = null;
  onPositionNow = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  window.scrollTo(0, 0);
  if (parts[0] === 'c' && parts[2] === 'edit') return renderEdit(parts[1]);
  if (parts[0] === 'c') return renderCache(parts[1]);
  if (parts[0] === 'nav') return renderNav(parts[1], parts[2], parts[3]);
  if (parts[0] === 'import') return renderImport();
  return renderList();
}

const topbar = (title, back = '#/', extra = '') => `
  <header class="topbar">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="Back">‹</a>` : '<span class="logo">◎</span>'}
    <h1>${title}</h1>${extra}
  </header>`;

// ---------- list ----------

function renderList() {
  const all = [...state.caches.values()];
  if (!all.length) {
    main.innerHTML = `${topbar('Field Solver', '', '<a class="icon-btn" href="#/import" aria-label="Import">＋</a>')}
      <section class="empty">
        <p>No caches yet.</p>
        <p class="muted">Import a Pocket Query (.zip or .gpx), or the <b>field-caches.json</b> file Claude prepared.</p>
        <a class="btn primary" href="#/import">Import caches</a>
      </section>`;
    return;
  }
  main.innerHTML = `${topbar('Field Solver', '', '<a class="icon-btn" href="#/import" aria-label="Import and settings">＋</a>')}
    <div class="toolbar">
      <input id="q" type="search" placeholder="Search name or GC code" value="${esc(state.q)}">
      <div class="chips">
        ${['field', 'progress', 'solved', 'done', 'home', 'gone', 'all'].map((f) => `<button class="chip ${state.filter === f ? 'on' : ''}" data-filter="${f}">${{ field: 'Field', progress: 'Started', solved: 'Solved', done: 'Done', home: 'Home/PC', gone: 'Gone?', all: 'All' }[f]}</button>`).join('')}
      </div>
    </div>
    <div id="gps-status" class="gps-status"></div>
    <ul id="list" class="list"></ul>`;
  const draw = () => {
    const byTime = state.filter === 'progress';
    document.getElementById('gps-status').innerHTML = byTime ? 'Most recently worked on first'
      : { ok: `Closest first · GPS ±${Math.round(state.pos?.accuracy ?? 0)} m`,
        waiting: 'Finding your location…',
        denied: 'Location is blocked — allow it for this site to sort by distance',
        error: 'No location yet — sorted by name',
        unsupported: 'No location on this device — sorted by name' }[state.gps];
    const q = state.q.toLowerCase();
    let rows = all.map((c) => ({ c, s: solve(c, userOf(c.code).values) }));
    rows = rows.filter(({ c, s }) => {
      if (q && !c.name.toLowerCase().includes(q) && !c.code.toLowerCase().includes(q)) return false;
      const done = !!userOf(c.code).done;
      if (state.filter === 'done') return done;
      if (done && state.filter !== 'all') return false;
      // Archived, disabled or no longer in your Pocket Query: only under Gone?, Started and All.
      if (state.filter === 'gone') return !!goneOf(c);
      if (goneOf(c) && ['field', 'solved', 'home'].includes(state.filter)) return false;
      if (state.filter === 'field') return c.field;
      if (state.filter === 'progress') return s.filled > 0 && !s.final?.ok;
      if (state.filter === 'solved') return !!s.final?.ok;
      if (state.filter === 'home') return tagsOf(c).some((t) => ['home', 'film', 'jigidi', 'online'].includes(t));
      return true;
    });
    // Solved caches: distance to the final, otherwise to the posted coordinates.
    rows.forEach((r) => {
      const t = r.s.final?.ok ? r.s.final : r.c;
      r.d = distTo(t.lat, t.lon);
      r.dir = r.d != null ? cardinal(bearing(state.pos.latitude, state.pos.longitude, t.lat, t.lon)) : '';
      r.toFinal = !!r.s.final?.ok;
    });
    if (byTime) rows.sort((a, b) => (userOf(b.c.code).updated || 0) - (userOf(a.c.code).updated || 0));
    else rows.sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || a.c.name.localeCompare(b.c.name, 'lv'));
    document.getElementById('list').innerHTML = rows.length ? rows.map(({ c, s, d, dir, toFinal }) => `
      <li><a href="#/c/${c.code}" class="row">
        <span class="type t-${typeClass(c.type)}" title="${esc(c.type)}">${typeIcon(c.type)}</span>
        <span class="row-main">
          <span class="row-title">${esc(c.name)}</span>
          <span class="row-sub">${c.code} · D${c.difficulty ?? '?'}/T${c.terrain ?? '?'}${c.source === 'curated' ? ' · <span class="ai">AI</span>' : ''}${goneOf(c) ? ` · <span class="badge warn">${goneOf(c)}</span>` : ''}</span>
          <span class="tags">${tagChips(c)}</span>
        </span>
        <span class="row-side">
          ${userOf(c.code).done ? '<span class="badge ok">done</span>' : s.final?.ok ? '<span class="badge ok">✓</span>' : s.inputs ? `<span class="badge">${s.filled}/${s.inputs}</span>` : ''}
          <span class="dist" title="${toFinal ? 'to the final' : 'to the posted coordinates'}">${d != null ? `${toFinal ? '⚑ ' : ''}${fmtDist(d)} ${dir}` : ''}</span>
        </span>
      </a></li>`).join('') : '<li class="empty muted">Nothing here.</li>';
  };
  draw();
  onPosition = throttle(draw, 5000);
  onPositionNow = draw;
  document.getElementById('q').addEventListener('input', (e) => { state.q = e.target.value; draw(); });
  main.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.filter; renderList(); }));
}

const tagsOf = (c) => c.tags || [c.field ? 'field' : 'home'];
// Your PQ lists only active caches you haven't found, so one that drops out of it was
// archived or found by you.
const goneOf = (c) => (c.archived ? 'archived' : c.available === false ? 'disabled' : c.missingSince ? 'not in PQ' : '');
const goneNote = (c) => (c.archived ? 'This cache is archived.'
  : c.available === false ? 'This cache is temporarily disabled.'
  : c.missingSince ? `Not in your Pocket Query imported ${new Date(c.missingSince).toLocaleDateString('lv-LV')} — it has been archived or you have already found it. Check on geocaching.com.` : '');
const tagChips = (c) => tagsOf(c).map((t) => `<span class="tag tag-${esc(t)}">${esc(TAGS[t] || t)}</span>`).join('');

const typeClass = (t) => (/Multi/.test(t) ? 'multi' : /Unknown/.test(t) ? 'mystery' : /Letterbox/.test(t) ? 'letterbox' : /Wherigo/.test(t) ? 'wherigo' : 'other');
const typeIcon = (t) => ({ multi: 'M', mystery: '?', letterbox: 'L', wherigo: 'W', other: '•' }[typeClass(t)]);

// ---------- cache / solver ----------

function coordLine(r) {
  if (!r) return '';
  if (r.ok) return `<span class="coord">${formatLatLon(r.lat, r.lon)}</span>`;
  const shown = `<span class="coord partial">${esc(r.latText)} ${esc(r.lonText)}</span>`;
  if (r.missing.length) return `${shown}<span class="need">needs ${r.missing.map(esc).join(', ')}</span>`;
  return `${shown}<span class="err">${esc(r.errors.join('; '))}</span>`;
}

function renderCache(code) {
  const c = state.caches.get(code);
  if (!c) { main.innerHTML = `${topbar('Not found')}<p class="empty">Cache ${esc(code)} isn't in the database.</p>`; return; }
  const u = userOf(code);
  const vars = c.variables || [];
  const stages = c.stages || [];
  const varRow = (v) => `
    <div class="var">
      <label class="var-name" for="v-${esc(v.name)}">${esc(v.name)}</label>
      <div class="var-q">${v.question ? esc(v.question) : '<span class="muted">No question found — see the description.</span>'}</div>
      <input id="v-${esc(v.name)}" class="var-in" data-var="${esc(v.name)}" inputmode="decimal" autocomplete="off" value="${esc(u.values[v.name] ?? '')}" placeholder="?">
    </div>`;
  const loose = vars.filter((v) => v.stage == null || !stages[v.stage]);
  const checkers = checkerLinks(c.descHtml);
  const checkerBtn = checkers.length ? `<a class="icon-btn" href="${esc(checkers[0].url)}" target="_blank" rel="noopener noreferrer" aria-label="Open checker" title="Checker: ${esc(checkers[0].host)}">✓</a>` : '';

  main.innerHTML = `${topbar(esc(c.name), '#/', `${checkerBtn}<a class="icon-btn" href="#/c/${code}/edit" aria-label="Edit puzzle">✎</a>`)}
    <section class="info">
      <div><a href="https://coord.info/${c.code}" target="_blank" rel="noopener">${c.code}</a> · ${esc(c.type)} · D${c.difficulty ?? '?'}/T${c.terrain ?? '?'} · ${esc(c.container || '')}</div>
      ${checkers.length ? `<div class="checkers">${checkers.map((k) => `<a class="mini" href="${esc(k.url)}" target="_blank" rel="noopener noreferrer">✓ Checker · ${esc(k.host)}</a>`).join('')}</div>` : ''}
      <div class="tags">${tagChips(c)}</div>
      <div class="posted">Posted: ${formatLatLon(c.lat, c.lon)} <span class="dist" data-dist="posted"></span>
        <a class="mini" href="#/nav/${code}/posted">Go</a></div>
      ${c.source === 'curated' ? '<div class="src ai">Checked by AI</div>' : c.field ? '<div class="src">Auto-detected — check against the description</div>' : ''}
      ${goneOf(c) ? `<div class="banner warn">${esc(goneNote(c))}</div>` : ''}
      ${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}
      ${!c.field ? `<div class="banner">Not detected as a field puzzle. <button class="btn small" id="mark-field">Mark as field puzzle</button></div>` : ''}
    </section>

    ${loose.length ? `<section class="card"><h2>Values</h2>${loose.map(varRow).join('')}</section>` : ''}

    ${stages.map((s, i) => `
      <section class="card stage">
        <h2><span class="stage-no" data-stage-no="${i}">${i + 1}</span> ${esc(s.label)}</h2>
        ${s.latTpl ? `<div class="stage-loc"><div data-stage="${i}"></div><a class="mini" data-stage-go="${i}" href="#/nav/${code}/stage/${i}">Go</a></div>` : ''}
        ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
        ${vars.filter((v) => v.stage === i).map(varRow).join('')}
      </section>`).join('')}

    ${(c.derived || []).length ? `<section class="card"><h2>Calculated</h2>
      ${c.derived.map((d, i) => `<div class="derived"><code>${esc(d.target)} = ${esc(d.expr)}</code><span data-derived="${i}"></span></div>`).join('')}
    </section>` : ''}

    <section class="card final">
      <h2>Final</h2>
      ${c.final?.latTpl ? `<div class="tpl"><code>${esc(c.final.latTpl)} ${esc(c.final.lonTpl)}</code>${c.final.bearing ? `<br>then project <code>${esc(c.final.bearing)}°</code>, <code>${esc(c.final.distance)} m</code>` : ''}</div><div id="final"></div>` : `
        <p class="muted small">${c.final?.bearing
          ? `Projection ${esc(c.final.bearing)}°, ${esc(c.final.distance)} m — type the start coordinates here:`
          : 'No formula. Found the final coordinates on site? Type them here (or tap ✎ to add a formula).'}</p>
        <div class="enter-final"><input id="final-in" placeholder="N 57° 01.234 E 025° 43.210" autocomplete="off"><button class="btn primary" id="final-save">Set</button></div>
        <div id="final-err" class="err"></div>`}
      <div id="checks"></div>
      <div class="actions" id="final-actions"></div>
    </section>

    ${c.hint ? `<details class="card"><summary>Hint</summary><p>${esc(c.hint)}</p></details>` : ''}
    <details class="card desc"><summary>Description</summary><div class="desc-body"></div></details>
    <section class="foot">
      <button class="btn small ${u.done ? 'primary' : 'ghost'}" id="toggle-done">${u.done ? 'Done ✓ (undo)' : 'Mark as done'}</button>
      ${c.field ? '<button class="btn small ghost" id="unmark-field">Not a field puzzle</button>' : ''}
      <button class="btn small ghost" id="clear-values">Clear my values</button>
    </section>`;

  const descEl = main.querySelector('.desc');
  descEl.addEventListener('toggle', () => {
    const body = descEl.querySelector('.desc-body');
    if (descEl.open && !body.innerHTML) body.innerHTML = sanitizeHtml(c.descHtml) || '<p class="muted">No description stored.</p>';
  }, { once: false });

  const update = () => {
    const s = solve(c, u.values);
    s.stages.forEach((r, i) => {
      const el = main.querySelector(`[data-stage="${i}"]`);
      if (el) el.innerHTML = coordLine(r);
      const go = main.querySelector(`[data-stage-go="${i}"]`);
      if (go) go.hidden = !r?.ok;
    });
    stages.forEach((_, i) => {
      const own = vars.filter((v) => v.stage === i);
      const done = own.length > 0 && own.every((v) => String(u.values[v.name] ?? '').trim() !== '');
      const el = main.querySelector(`[data-stage-no="${i}"]`);
      el.textContent = done ? '✓' : i + 1;
      el.closest('.stage').classList.toggle('done', done);
    });
    s.derived.forEach((r, i) => {
      const el = main.querySelector(`[data-derived="${i}"]`);
      if (el) el.innerHTML = r.error ? `<span class="err">${esc(r.error)}</span>` : r.missing ? `<span class="need">needs ${r.missing.map(esc).join(', ')}</span>` : `= <b>${r.value}</b>`;
    });
    const f = document.getElementById('final');
    const proj = s.final?.ok && s.final.projected ? `<span class="muted small">from ${formatLatLon(...s.final.projected.from)}, ${s.final.projected.bearing}° · ${s.final.projected.distance} m</span>` : '';
    if (f) f.innerHTML = coordLine(s.final) + proj + (s.final?.warnings?.length ? `<span class="warn">${esc(s.final.warnings.join('; '))}</span>` : '');
    document.getElementById('checks').innerHTML = s.checks.map((k) => {
      const ok = k.r.value !== undefined && Math.abs(k.r.value - k.value) < 1e-9;
      const state = k.r.value === undefined ? '<span class="muted">…</span>' : ok ? '<b class="ok">✓</b>' : `<b class="bad">✗ ${k.r.value}</b>`;
      return `<div class="check-row">Checksum <code>${esc(k.expr)} = ${k.value}</code> ${state}</div>`;
    }).join('');
    const acts = document.getElementById('final-actions');
    if (s.final?.ok) {
      const m = mapLinks(s.final.lat, s.final.lon, c.name);
      const away = distance(c.lat, c.lon, s.final.lat, s.final.lon);
      acts.innerHTML = `
        <a class="btn primary" href="#/nav/${code}/final">Navigate</a>
        <a class="btn" href="${m.google}" target="_blank" rel="noopener">Google Maps</a>
        <a class="btn" href="${m.geo}">Maps app</a>
        <button class="btn" id="copy">Copy</button>
        <div class="muted small">${fmtDist(away)} from posted coordinates</div>`;
      document.getElementById('copy').onclick = () => navigator.clipboard?.writeText(formatLatLon(s.final.lat, s.final.lon)).then(() => toast('Copied'));
    } else {
      acts.innerHTML = s.inputs ? `<div class="muted small">${s.filled} of ${s.inputs} values entered</div>` : '';
    }
    const dp = main.querySelector('[data-dist="posted"]');
    const d = distTo(c.lat, c.lon);
    if (dp) dp.textContent = d != null ? `· ${fmtDist(d)}` : '';
  };
  update();
  onPosition = throttle(update, 3000);

  main.querySelectorAll('.var-in').forEach((inp) => inp.addEventListener('input', () => {
    u.values = { ...u.values, [inp.dataset.var]: inp.value };
    saveUser(u);
    update();
  }));
  main.querySelector('#final-save')?.addEventListener('click', async () => {
    const [latTpl, lonTpl] = splitLatLon(document.getElementById('final-in').value);
    const r = evalCoords(latTpl, lonTpl, {}, []);
    if (!r.ok) { document.getElementById('final-err').textContent = r.errors.join('; ') || 'Write it like N 57° 01.234 E 025° 43.210'; return; }
    await saveCache({ ...c, final: { ...c.final, latTpl, lonTpl }, edited: true });
    renderCache(code);
  });
  main.querySelector('#mark-field')?.addEventListener('click', async () => { await saveCache({ ...c, field: true, edited: true }); renderCache(code); });
  main.querySelector('#unmark-field')?.addEventListener('click', async () => { await saveCache({ ...c, field: false, edited: true }); history.back(); });
  main.querySelector('#toggle-done').addEventListener('click', () => {
    u.done = !u.done;
    saveUser(u);
    renderCache(code);
  });
  main.querySelector('#clear-values').addEventListener('click', () => {
    if (!confirm('Clear all values you entered for this cache?')) return;
    u.values = {};
    saveUser(u);
    renderCache(code);
  });
}

// ---------- edit ----------

function renderEdit(code) {
  const c = state.caches.get(code);
  if (!c) return renderList();
  const puzzle = { stages: c.stages || [], variables: c.variables || [], derived: c.derived || [], final: c.final || { latTpl: '', lonTpl: '' }, checks: c.checks || [] };
  main.innerHTML = `${topbar('Edit puzzle', `#/c/${code}`)}
    <section class="card">
      <textarea id="dsl" spellcheck="false">${esc(serialize(puzzle))}</textarea>
      <div id="dsl-err" class="err"></div>
      <div class="actions"><button class="btn primary" id="save">Save</button><a class="btn" href="#/c/${code}">Cancel</a></div>
    </section>
    <details class="card" open><summary>Format</summary><pre class="help">== Stage name @ N 56° 57.056 E 024° 07.632
> note for this stage
A: question you answer on site
B: another question

== Stage 2 @ N 56° 57.(A+1)B E 024° 08.1(B-A)2
C: ...

S = J-H              calculated value
STVXYZ = (A+B)*463   result digits go to S,T,V,X,Y,Z

FINAL: N 56° 57.(Y-Z)(X+S)(V-Y) E 024° 08.(T-Z+S)YZ</pre>
      <p class="muted small">In formulas: + - * / ^, x or × also mean multiply, AB joins digits (A=1, B=2 → 12), (…) is calculated and written in place. ds(…) digit sum, sd(…) digits sorted high→low, % remainder.</p>
    </details>`;
  document.getElementById('save').onclick = async () => {
    const { puzzle: p, errors } = parseDsl(document.getElementById('dsl').value);
    if (errors.length) { document.getElementById('dsl-err').textContent = errors.join('\n'); return; }
    await saveCache({ ...c, ...p, edited: true, field: true });
    location.hash = `#/c/${code}`;
  };
}

// ---------- navigate ----------

function navTarget(c, kind, idx) {
  if (kind === 'posted') return { lat: c.lat, lon: c.lon, label: 'Posted coordinates' };
  const s = solve(c, userOf(c.code).values);
  if (kind === 'final' && s.final?.ok) return { lat: s.final.lat, lon: s.final.lon, label: 'Final' };
  if (kind === 'stage' && s.stages[idx]?.ok) return { lat: s.stages[idx].lat, lon: s.stages[idx].lon, label: `Stage ${Number(idx) + 1}: ${c.stages[idx].label}` };
  return null;
}

function renderNav(code, kind, idx) {
  const c = state.caches.get(code);
  const t = c && navTarget(c, kind, idx);
  if (!t) { main.innerHTML = `${topbar('Navigate', `#/c/${code}`)}<p class="empty">No coordinates yet.</p>`; return; }
  const m = mapLinks(t.lat, t.lon, c.name);
  main.innerHTML = `${topbar(esc(c.name), `#/c/${code}`)}
    <section class="nav">
      <div class="nav-label">${esc(t.label)}</div>
      <div class="coord big">${formatLatLon(t.lat, t.lon)}</div>
      <div class="compass"><div class="ring"><span class="n">N</span></div><div class="arrow" id="arrow">▲</div></div>
      <div class="nav-dist" id="nav-dist">Waiting for GPS…</div>
      <div class="muted" id="nav-sub"></div>
      <button class="btn" id="compass-perm">Enable compass</button>
      <div class="muted small" id="compass-msg"></div>
      <div class="actions">
        <a class="btn primary" href="${m.google}" target="_blank" rel="noopener">Google Maps</a>
        <a class="btn" href="${m.geo}">Maps app</a>
        <a class="btn" href="${m.apple}" target="_blank" rel="noopener">Apple Maps</a>
      </div>
    </section>`;
  let heading = null;
  const draw = () => {
    const p = state.pos;
    if (!p) return;
    const d = distance(p.latitude, p.longitude, t.lat, t.lon);
    const b = bearing(p.latitude, p.longitude, t.lat, t.lon);
    const h = heading ?? (p.speed > 1 && p.heading != null ? p.heading : null);
    document.getElementById('nav-dist').textContent = fmtDist(d);
    document.getElementById('nav-sub').textContent = `${Math.round(b)}° ${cardinal(b)} · GPS ±${Math.round(p.accuracy)} m${h == null ? ' · no compass, arrow points from north' : ''}`;
    document.getElementById('arrow').style.transform = `rotate(${b - (h ?? 0)}deg)`;
    main.querySelector('.ring').style.transform = `rotate(${-(h ?? 0)}deg)`;
  };
  const onOrient = (e) => {
    if (e.webkitCompassHeading != null) heading = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) heading = (360 - e.alpha) % 360;
    else return;
    const sa = screen.orientation?.angle || 0;
    heading = (heading + sa) % 360;
    clearTimeout(noData);
    msg.textContent = '';
    draw();
  };
  const evt = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  const btn = document.getElementById('compass-perm');
  const msg = document.getElementById('compass-msg');
  const needsPermission = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
  let on = false;
  let noData = null;
  const setOn = (v, refused = false) => {
    on = v;
    btn.textContent = v ? 'Disable compass' : 'Enable compass';
    clearTimeout(noData);
    if (v) {
      window.addEventListener(evt, onOrient);
      noData = setTimeout(() => {
        if (heading == null) msg.textContent = refused
          ? 'Compass permission was refused — allow motion & orientation access for this site in the browser settings. Until then the arrow points from north.'
          : 'No compass data from this device — the arrow points from north.';
      }, 3000);
    } else {
      window.removeEventListener(evt, onOrient);
      heading = null;
      msg.textContent = '';
      draw();
    }
  };
  btn.onclick = async () => {
    if (on) { compass.wanted = false; setOn(false); return; }
    compass.wanted = true;
    let refused = false;
    if (needsPermission && !compass.granted) {
      // Some browsers answer "denied" yet still send orientation events, so listen either way.
      let r = 'denied';
      try { r = await DeviceOrientationEvent.requestPermission(); } catch {}
      compass.granted = r === 'granted';
      refused = !compass.granted;
    }
    msg.textContent = '';
    setOn(true, refused);
  };
  // iOS only lets a tap ask for the permission, so start off there until it has been granted once.
  if (compass.wanted && (!needsPermission || compass.granted)) setOn(true);
  let lock = null;
  navigator.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => {});
  onPosition = draw;
  draw();
  viewCleanup = () => { clearTimeout(noData); window.removeEventListener(evt, onOrient); lock?.release(); };
}

// ---------- import / settings ----------

function renderImport() {
  const field = [...state.caches.values()].filter((c) => c.field).length;
  main.innerHTML = `${topbar('Import & data')}
    <section class="card">
      <h2>Import</h2>
      <p class="muted small">Pocket Query .zip or .gpx (include the -wpts file), or the field-caches.json Claude prepared. GC codes already in the database are skipped, so only new caches are added. Your answers are never overwritten.</p>
      <input type="file" id="files" multiple accept=".gpx,.zip,.json,application/gpx+xml,application/zip,application/json">
      <label class="check"><input type="checkbox" id="recheck"> Re-check caches already in the database</label>
      <label class="check"><input type="checkbox" id="as-done"> These caches are already solved — mark them as done (e.g. your geocaching.com list as GPX)</label>
      <div id="log" class="log"></div>
    </section>
    <section class="card">
      <h2>Already solved</h2>
      <p class="muted small">Paste GC codes you've solved elsewhere. They're hidden from the lists (see the Done filter).</p>
      <textarea id="done-codes" rows="3" placeholder="GC5P7JV GC6G5YG …"></textarea>
      <div class="actions"><button class="btn" id="done-save">Mark as done</button><span id="done-log" class="muted small"></span></div>
    </section>
    <section class="card">
      <h2>Database</h2>
      <p>${state.seenCount} GC codes recorded · ${state.caches.size} puzzle candidates · ${field} field puzzles</p>
      <div class="actions">
        <button class="btn" id="export">Export backup</button>
        <button class="btn ghost" id="wipe">Delete everything</button>
      </div>
    </section>`;
  const log = (html) => { document.getElementById('log').insertAdjacentHTML('beforeend', `<div>${html}</div>`); };
  document.getElementById('files').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    try {
      log(`Reading ${files.length} file(s)…`);
      const { gpx, json } = await readFiles(files);
      for (const j of json) {
        const s = await importJson(j);
        log(`JSON: ${s.added} new, ${s.updated} updated, ${s.keptEdited} kept (you edited them), ${s.field} field puzzles, ${s.seen} codes recorded.`);
      }
      if (gpx.length && document.getElementById('as-done').checked) {
        const s = await markDone(gpxCodes(gpx));
        log(`Marked <b>${s.marked}</b> caches as done (${s.inDatabase} of them are in your database). Nothing new was added.`);
      } else if (gpx.length) {
        const s = await importGpx(gpx, { recheck: document.getElementById('recheck').checked });
        log(`GPX: ${s.total} caches — <b>${s.added} new</b>, ${s.known} already known (skipped)${s.rechecked ? `, ${s.rechecked} re-checked` : ''}. ${s.candidates} puzzle candidates, <b>${s.field} field puzzles</b>.`);
        if (s.missing || s.back) log(`<b>${s.missing}</b> stored caches in this PQ's area are no longer in it (archived or found by you) — see the <a href="#/">Gone?</a> filter.${s.back ? ` ${s.back} are back in the PQ.` : ''}`);
      }
      await load();
      log('<a href="#/">Open the list ›</a>');
    } catch (err) {
      log(`<span class="err">${esc(err.message)}</span>`);
    }
    e.target.value = '';
  });
  document.getElementById('done-save').onclick = async () => {
    const codes = document.getElementById('done-codes').value.split(/[\s,;]+/).filter(Boolean);
    const s = await markDone(codes);
    await load();
    document.getElementById('done-log').textContent = `${s.marked} marked as done (${s.inDatabase} in your database).`;
  };
  document.getElementById('export').onclick = async () => {
    const blob = new Blob([JSON.stringify(await exportBackup())], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `geofieldsolver-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  document.getElementById('wipe').onclick = async () => {
    if (!confirm('Delete all caches, answers and recorded GC codes from this device?')) return;
    await Promise.all(['caches', 'user', 'seen'].map(db.clear));
    await load();
    renderImport();
  };
}

// ---------- helpers ----------

function throttle(fn, ms) {
  let last = 0;
  return () => { const now = Date.now(); if (now - last > ms) { last = now; fn(); } };
}

function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
}

// ---------- start ----------

window.addEventListener('hashchange', route);
navigator.storage?.persist?.(); // ask the browser not to evict saved answers
window.addEventListener('pagehide', () => { clearTimeout(saveTimer); for (const u of state.user.values()) if (u.updated > Date.now() - 2000) db.put('user', u); });
await load();
startGps();
route();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
