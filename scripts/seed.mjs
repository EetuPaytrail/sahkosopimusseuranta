// Tuo aiemmin käsin kerätyn taulukon (seed/taulukko.tsv) historiaan.
// Sarakkeet muotoa "<yhtiö> <n>kk", rivit "p.k.vvvv [hh:mm]", desimaalipilkku.
// Voi ajaa uudelleen: aiemmat tuodut rivit korvataan, eikä päiviä, joille on
// jo rajapinnasta kerättyä dataa, tuoda.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, save, expand, compress } from './history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY = path.join(ROOT, 'site', 'data', 'history.json');
const TSV = path.join(ROOT, process.argv[2] || 'seed/taulukko.tsv');

// Taulukon lyhyet nimet -> Energiaviraston yhtiönimet
const COMPANIES = {
  Helen: 'Helen Oy',
  Oomi: 'Oomi Oy',
  Hehku: 'Hehku Energia Oy',
  Cheap: 'Cheap Energy Finland Oy',
  'Väre': 'Väre Oy',
  'Vaasan Sähkö': 'Vaasan Sähkö Myynti Oy',
  Aalto: 'Aalto energia Oyj',
  PKS: 'Pohjois-Karjalan Sähkö Oy',
};

const lines = fs.readFileSync(TSV, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const header = lines[0].split('\t');
const cols = header.slice(1).map((h) => {
  const m = h.trim().match(/^(.*?)\s*(\d+)\s*kk$/i);
  if (!m) throw new Error(`Tuntematon sarake: ${h}`);
  const company = COMPANIES[m[1]] || m[1];
  const term = Number(m[2]);
  return { id: `seed:${company}:${term}`, company, term, label: m[1] };
});

const ex = expand(load(HISTORY));
// Poista aiemmin tuodut rivit
const keep = ex.snapshots.map((s, i) => (s.src === 'seed' ? -1 : i)).filter((i) => i >= 0);
let snapshots = keep.map((i) => ex.snapshots[i]);
let states = keep.map((i) => ex.states[i]);
const apiDates = new Set(snapshots.map((s) => s.t.slice(0, 10)));

for (const c of cols) {
  ex.metas[c.id] = {
    c: c.company, n: `${c.label} ${c.term} kk (tuotu taulukosta)`, pm: 'FixedPrice', ct: 'FixedTerm',
    term: c.term, mt: 'General', tg: 'Household', nat: true, dr: false, newOnly: false, custom: false,
    link: '', info: 'Tuotu aiemmin käsin kerätystä taulukosta.', seed: true,
  };
}

let added = 0;
for (const line of lines.slice(1)) {
  const cells = line.split('\t');
  const m = cells[0].trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) continue;
  const date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (apiDates.has(date)) continue;
  const t = `${date}T${(m[4] || '09').padStart(2, '0')}:${m[5] || '00'}`;
  const state = {};
  cols.forEach((c, i) => {
    const v = (cells[i + 1] || '').trim().replace(',', '.');
    if (v && Number.isFinite(Number(v))) state[c.id] = [['General', Number(v)]];
  });
  snapshots.push({ t, at: null, src: 'seed' });
  states.push(state);
  added++;
}

const order = snapshots.map((s, i) => i).sort((a, b) => snapshots[a].t.localeCompare(snapshots[b].t));
save(HISTORY, compress({
  snapshots: order.map((i) => snapshots[i]),
  metas: ex.metas,
  states: order.map((i) => states[i]),
}));
console.log(`Tuotu ${added} riviä taulukosta`);
