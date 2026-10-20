// Plain-text puzzle editor format.
//
//   == Stage label @ N 56° 57.056 E 024° 07.632     a stage (fixed or formula coords)
//   > note shown on the stage card
//   A: question text                               a value you enter on site
//   S = J-H                                        a derived value
//   STVXYZ = (A+B)*463                             digits of the result go to S,T,V,...
//   FINAL: N 56° 57.(Y-Z)(X+S) E 024° 08.(T-Z)YZ   final coordinates
//   PROJECT: Y-124 ; Y+319                         optional: from FINAL, bearing° ; metres
//   CHECK: A+B+C+D+E = 51                          checksum given in the listing

import { splitLatLon } from './formula.js';

export function serialize(p) {
  const out = [];
  const varLine = (v) => `${v.name}: ${v.question || ''}`.trimEnd();
  p.variables.filter((v) => v.stage == null).forEach((v) => out.push(varLine(v)));
  p.stages.forEach((s, i) => {
    out.push('');
    out.push(`== ${s.label}${s.latTpl ? ` @ ${s.latTpl} ${s.lonTpl}` : ''}`);
    if (s.note) out.push(`> ${s.note.replace(/\n/g, ' ')}`);
    p.variables.filter((v) => v.stage === i).forEach((v) => out.push(varLine(v)));
  });
  if (p.derived.length) out.push('');
  p.derived.forEach((d) => out.push(`${d.target} = ${d.expr}`));
  out.push('');
  out.push(`FINAL: ${p.final.latTpl} ${p.final.lonTpl}`.trimEnd());
  if (p.final.bearing) out.push(`PROJECT: ${p.final.bearing} ; ${p.final.distance}`);
  (p.checks || []).forEach((k) => out.push(`CHECK: ${k.expr} = ${k.value}`));
  return out.join('\n').replace(/^\n+/, '');
}

export function parseDsl(text) {
  const p = { stages: [], variables: [], derived: [], final: { latTpl: '', lonTpl: '' }, checks: [] };
  const errors = [];
  let stage = null;
  let last = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) { last = null; return; }
    let m;
    if ((m = line.match(/^==\s*(.*?)\s*(?:@\s*(.+))?$/))) {
      const [latTpl, lonTpl] = m[2] ? splitLatLon(m[2]) : ['', ''];
      stage = p.stages.length;
      p.stages.push({ label: m[1] || `Stage ${stage + 1}`, latTpl, lonTpl, note: '' });
      last = null;
    } else if (line.startsWith('>') && stage != null) {
      p.stages[stage].note = (p.stages[stage].note + ' ' + line.slice(1).trim()).trim();
    } else if ((m = line.match(/^FINAL\s*:\s*(.*)$/i))) {
      const [latTpl, lonTpl] = splitLatLon(m[1]);
      p.final = { ...p.final, latTpl, lonTpl };
    } else if ((m = line.match(/^CHECK\s*:\s*(.+?)\s*=\s*(-?[\d.]+)\s*$/i))) {
      p.checks.push({ expr: m[1], value: Number(m[2]) });
    } else if ((m = line.match(/^PROJECT\s*:\s*(.+?)\s*;\s*(.+)$/i))) {
      p.final = { ...p.final, bearing: m[1].replace(/°/g, '').trim(), distance: m[2].replace(/\s*m$/i, '').trim() };
    } else if ((m = line.match(/^(\p{L}[\p{L}\d]*)\s*=\s*(.+)$/u))) {
      p.derived.push({ target: m[1], expr: m[2].trim() });
      last = null;
    } else if ((m = line.match(/^(\p{L}\d*)\s*:\s*(.*)$/u))) {
      if (p.variables.some((v) => v.name === m[1])) errors.push(`Line ${i + 1}: ${m[1]} defined twice`);
      last = { name: m[1], question: m[2], stage };
      p.variables.push(last);
    } else if (last) {
      last.question = `${last.question} ${line}`.trim();
    } else {
      errors.push(`Line ${i + 1}: not understood — "${line.slice(0, 40)}"`);
    }
  });
  return { puzzle: p, errors };
}
