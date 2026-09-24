'use strict';

// ---------------------------------------------------------------------------
// Tila ja apufunktiot
// ---------------------------------------------------------------------------
const S = {
  tg: 'Household',
  view: 'top',
  mt: 'General',
  src: 'all', // all | api | site
  fixedTerms: new Set([12, 24]),
  otherType: 'all',
  sort: { fixed: { col: 'name', dir: 1 }, spot: { col: 'v', dir: 1 }, other: { col: 'name', dir: 1 } },
  open: new Set(),
  hist: {},
};
let D = null; // ladattu data
let forecast = null;
const charts = {};

const TERMS = [0, 6, 12, 24, 36];
const TERM_LABEL = (t) => (t === 0 ? 'Toistaiseksi' : `${t} kk`);
const COMP_LABEL = {
  General: 'Energia', DayTime: 'Päivä', NightTime: 'Yö', SeasonalWinterDay: 'Talvipäivä',
  SeasonalOther: 'Muu aika', Spot: 'Pörssi +',
};
const MT_LABEL = { General: 'Yleissähkö', Time: 'Aikasähkö', Season: 'Kausisähkö' };
const MAX_CHART = 8;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('fi-FI', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (v) => (v == null || !Number.isFinite(v) ? '' : nf.format(v));
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const short = (c) => c.replace(/\s+(Oyj|Oy Ab|Oy|Ab|Ltd)$/i, '').replace(/\s+(Myynti|Markets|Finland)$/i, '').trim();

function fmtSnap(s) {
  const [d, t] = s.t.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  return `${dd}.${m}.${y} ${t}`;
}

function helsinkiNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour), m: Number(p.minute) };
}
const helsinkiDate = (ms) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki' }).format(new Date(ms));

// ---------------------------------------------------------------------------
// Datan purku
// ---------------------------------------------------------------------------
function expand(history) {
  const snaps = history.snapshots;
  const N = snaps.length;
  const metas = {};
  const vals = {};
  for (const [id, p] of Object.entries(history.products)) {
    metas[id] = p.m;
    const arr = new Array(N).fill(null);
    let k = 0;
    let cur = null;
    for (let i = 0; i < N; i++) {
      while (k < p.h.length && p.h[k][0] <= i) cur = p.h[k++][1];
      arr[i] = cur;
    }
    vals[id] = arr;
  }
  let latest = N - 1;
  for (let i = N - 1; i >= 0; i--) if (snaps[i].src === 'api') { latest = i; break; }
  return { snaps, metas, vals, ids: Object.keys(metas), latest };
}

const isPackage = (comps) => !comps.length || comps.every((c) => c[1] === 0) || comps.some((c) => c[2] && c[2].includes('kWh'));

function category(m, comps) {
  if (m.pm === 'Spot') return 'spot';
  if (m.pm === 'FixedPrice' && !isPackage(comps)) return 'fixed';
  return 'other';
}
const otherKind = (m, comps) => (m.pm === 'Hybrid' ? 'hybrid' : isPackage(comps) ? 'package' : 'misc');
const OTHER_LABEL = { hybrid: 'Kulutusvaikutteinen / hybridi', package: 'Kuukausipaketti', misc: 'Erikoishinnoittelu' };

const srcOf = (m) => (m.src === 'site' || m.seed ? 'site' : 'api');
const srcOk = (m) => S.src === 'all' || srcOf(m) === S.src;
const tgOk = (m) => (S.tg === 'Household' ? m.tg !== 'Company' : m.tg !== 'Household');

function price(comps, type, allowZero) {
  const c = comps.find((x) => x[0] === type && (allowZero || x[1] > 0));
  return c ? c[1] : null;
}

// Energiahinta: { v: vertailuarvo, txt }
function energyPrice(m, comps, allowZero = false) {
  if (m.mt === 'Time') {
    const d = price(comps, 'DayTime', allowZero); const n = price(comps, 'NightTime', allowZero);
    if (d == null || n == null) return null;
    return { v: (d + n) / 2, txt: `${fmt(d)} / ${fmt(n)}` };
  }
  if (m.mt === 'Season') {
    const w = price(comps, 'SeasonalWinterDay', allowZero); const o = price(comps, 'SeasonalOther', allowZero);
    if (w == null || o == null) return null;
    return { v: (w + o) / 2, txt: `${fmt(w)} / ${fmt(o)}` };
  }
  let g = price(comps, 'General', allowZero);
  if (g == null) g = price(comps, 'Spot', allowZero);
  return g == null ? null : { v: g, txt: fmt(g) };
}

const bucketOf = (term) => (TERMS.includes(term) ? term : 'other');

// Tuotteet tietyllä hetkellä: [{id, m, comps}]
function productsAt(i, pred) {
  const out = [];
  for (const id of D.ids) {
    const comps = D.vals[id][i];
    if (!comps) continue;
    const m = D.metas[id];
    if (!tgOk(m)) continue;
    if (pred(m, comps)) out.push({ id, m, comps });
  }
  return out;
}

// Kiinteät: company -> bucket -> {v, txt, term}
const fixedCache = new Map();
function fixedAgg(i) {
  const key = `${i}|${S.tg}|${S.mt}|${S.src}`;
  if (fixedCache.has(key)) return fixedCache.get(key);
  const agg = new Map();
  for (const p of productsAt(i, (m, c) => category(m, c) === 'fixed' && m.mt === S.mt && srcOk(m))) {
    const pr = energyPrice(p.m, p.comps);
    if (!pr) continue;
    const b = bucketOf(p.m.term);
    if (!agg.has(p.m.c)) agg.set(p.m.c, {});
    const row = agg.get(p.m.c);
    if (!row[b] || pr.v < row[b].v) row[b] = { ...pr, term: p.m.term };
  }
  fixedCache.set(key, agg);
  return agg;
}

const spotCache = new Map();
function spotAgg(i) {
  const key = `${i}|${S.tg}`;
  if (spotCache.has(key)) return spotCache.get(key);
  const agg = new Map();
  for (const p of productsAt(i, (m) => m.pm === 'Spot')) {
    const pr = energyPrice(p.m, p.comps, true);
    if (!pr) continue;
    const cur = agg.get(p.m.c);
    if (!cur || pr.v < cur.v) agg.set(p.m.c, pr);
  }
  spotCache.set(key, agg);
  return agg;
}

function deltaHtml(cur, prev) {
  if (cur == null || prev == null) return '';
  const d = cur - prev;
  if (Math.abs(d) < 0.005) return '';
  const cls = d > 0 ? 'up' : 'down';
  return `<span class="delta ${cls}" title="Edellinen ${fmt(prev)}">${d > 0 ? '▲' : '▼'}${fmt(Math.abs(d))}</span>`;
}

function badges(m, comps) {
  const b = [];
  if (m.src === 'site') b.push('Yhtiön sivu');
  if (m.seed) b.push('Tuotu taulukosta');
  if (m.newOnly) b.push('Vain uusille');
  if (m.dr) b.push('Toimitusvelvollinen');
  if (!m.nat) b.push('Alueellinen');
  if (m.custom) b.push('Erikoishinnoittelu');
  for (const c of comps || []) if (c[2]) b.push(c[2]);
  return b.map((x) => `<span class="badge">${esc(x)}</span>`).join('');
}
const linkHtml = (m) => (m.link ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">Sivulle →</a>` : '');

function sortRows(rows, sort, getters) {
  const g = getters[sort.col] || getters.name;
  return rows.sort((a, b) => {
    const x = g(a); const y = g(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y, 'fi') : x - y) * sort.dir;
  });
}
function sortHeader(view, col, label, cls = '') {
  const s = S.sort[view];
  const arrow = s.col === col ? (s.dir > 0 ? ' ↑' : ' ↓') : '';
  return `<th class="sortable ${cls}" data-sort="${view}:${col}">${label}${arrow}</th>`;
}

// ---------------------------------------------------------------------------
// Kiinteähintaiset
// ---------------------------------------------------------------------------
function renderFixed() {
  const i = D.latest;
  const agg = fixedAgg(i);
  const prev = i > 0 ? fixedAgg(i - 1) : new Map();
  const q = $('#fixedSearch').value.trim().toLowerCase();
  const cols = [...TERMS, 'other'];
  let rows = [...agg.entries()].filter(([c]) => !q || c.toLowerCase().includes(q));
  const best = {};
  for (const b of cols) {
    const vs = rows.map(([, r]) => r[b]?.v).filter((v) => v != null);
    best[b] = vs.length ? Math.min(...vs) : null;
  }
  const getters = { name: (r) => short(r[0]) };
  for (const b of cols) getters[b] = (r) => r[1][b]?.v;
  rows = sortRows(rows, S.sort.fixed, getters);

  const list = productsAt(i, (m, c) => category(m, c) === 'fixed' && m.mt === S.mt && srcOk(m));
  let html = `<thead><tr>${sortHeader('fixed', 'name', 'Yhtiö', 'sticky-col')}${cols.map((b) => sortHeader('fixed', b, b === 'other' ? 'Muu kesto' : TERM_LABEL(b), 'num')).join('')}</tr></thead><tbody>`;
  for (const [c, r] of rows) {
    const open = S.open.has(`fixed|${c}`);
    html += `<tr class="company-row${open ? ' open' : ''}" data-open="fixed|${esc(c)}"><td class="sticky-col"><strong>${esc(short(c))}</strong></td>`;
    for (const b of cols) {
      const cell = r[b];
      if (!cell) { html += '<td class="num muted">–</td>'; continue; }
      const isBest = best[b] != null && Math.abs(cell.v - best[b]) < 1e-9;
      const extra = b === 'other' ? ` <span class="muted">(${cell.term ?? '?'} kk)</span>` : '';
      html += `<td class="num${isBest ? ' best' : ''}">${cell.txt}${extra}${deltaHtml(cell.v, prev.get(c)?.[b]?.v)}</td>`;
    }
    html += '</tr>';
    if (open) {
      const prods = list.filter((p) => p.m.c === c).sort((a, b) => (a.m.term ?? 99) - (b.m.term ?? 99));
      html += `<tr class="detail-row"><td colspan="${cols.length + 1}"><table class="prod-list">${prods.map((p) => {
        const pr = energyPrice(p.m, p.comps);
        const pv = D.vals[p.id][i - 1];
        const pp = pv ? energyPrice(p.m, pv) : null;
        return `<tr><td>${esc(p.m.n)}${badges(p.m, p.comps)}</td><td>${p.m.term === 0 ? 'Toistaiseksi' : `${p.m.term ?? '?'} kk`}</td><td class="num"><strong>${pr?.txt ?? ''}</strong>${deltaHtml(pr?.v, pp?.v)} c/kWh</td><td>${linkHtml(p.m)}</td></tr>`;
      }).join('')}</table></td></tr>`;
    }
  }
  if (!rows.length) html += `<tr><td colspan="${cols.length + 1}" class="muted">Ei sopimuksia valituilla ehdoilla.</td></tr>`;
  $('#fixedTable').innerHTML = html + '</tbody>';

  $('#fixedTerms').innerHTML = TERMS.map((t) => `<label class="chk" style="margin-right:12px"><input type="checkbox" data-term="${t}" ${S.fixedTerms.has(t) ? 'checked' : ''}> ${TERM_LABEL(t)}</label>`).join('');

  // Historia
  const companies = new Set();
  for (let k = 0; k < D.snaps.length; k++) for (const c of fixedAgg(k).keys()) companies.add(c);
  const series = [];
  for (const c of [...companies].sort((a, b) => short(a).localeCompare(short(b), 'fi'))) {
    for (const t of TERMS) {
      if (!S.fixedTerms.has(t)) continue;
      series.push({ key: `${c}|${t}`, group: short(c), label: TERM_LABEL(t), get: (k) => fixedAgg(k).get(c)?.[t] || null });
    }
  }
  const prefer = ['Helen', 'Oomi', 'Hehku Energia', 'Cheap Energy', 'Väre', 'Vaasan Sähkö', 'Aalto energia', 'Pohjois-Karjalan Sähkö'];
  const firstTerm = [...S.fixedTerms].sort((a, b) => a - b).find((t) => t === 12) ?? [...S.fixedTerms][0];
  renderHistory('fixedHistory', {
    series,
    defaultChart: (visible) => {
      const byName = visible.filter((s) => s.label === TERM_LABEL(firstTerm));
      const pref = byName.filter((s) => prefer.includes(s.group));
      return (pref.length ? pref : cheapest(byName)).slice(0, MAX_CHART).map((s) => s.key);
    },
    resetKey: `${S.tg}|${S.mt}|${S.src}|${[...S.fixedTerms].join(',')}`,
  });
  renderSources();
}

// Yhtiöiden sivut vs. Energiavirasto
function renderSources() {
  const i = D.latest;
  const rows = [];
  for (const id of D.ids) {
    const m = D.metas[id];
    const c = D.vals[id][i];
    if (m.src !== 'site' || !c) continue;
    let api = null;
    for (const oid of D.ids) {
      const om = D.metas[oid];
      const oc = D.vals[oid][i];
      if (!oc || om.c !== m.c || om.term !== m.term || om.src || om.seed || om.tg === 'Company') continue;
      if (category(om, oc) !== 'fixed' || om.mt !== 'General' || om.ct !== 'FixedTerm') continue;
      const p = energyPrice(om, oc);
      if (p && (!api || p.v < api.v)) api = { ...p, n: om.n };
    }
    rows.push({ m, v: c[0][1], api });
  }
  rows.sort((a, b) => short(a.m.c).localeCompare(short(b.m.c), 'fi') || a.m.term - b.m.term);
  let html = '<thead><tr><th class="sticky-col">Yhtiö</th><th>Sopimus</th><th class="num">Kesto</th><th class="num">Yhtiön sivu</th><th class="num">Energiavirasto</th><th class="num">Ero</th><th></th></tr></thead><tbody>';
  for (const r of rows) {
    const diff = r.api ? r.v - r.api.v : null;
    const cls = diff == null ? ' muted' : Math.abs(diff) < 0.005 ? '' : diff > 0 ? ' up' : ' down';
    const diffTxt = diff == null ? 'ei vertailukohtaa' : Math.abs(diff) < 0.005 ? '✓ sama' : `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))}`;
    html += `<tr><td class="sticky-col"><strong>${esc(short(r.m.c))}</strong></td><td class="name-cell">${esc(r.m.n.replace(' (yhtiön sivu)', ''))}</td><td class="num">${r.m.term} kk</td><td class="num"><strong>${fmt(r.v)}</strong></td><td class="num" title="${esc(r.api?.n || '')}">${r.api ? r.api.txt : '–'}</td><td class="num${cls}">${diffTxt}</td><td>${linkHtml(r.m)}</td></tr>`;
  }
  if (!rows.length) html += '<tr><td colspan="7" class="muted">Yhtiöiden sivuilta ei ole vielä luettu hintoja. Ne luetaan seuraavalla keruukerralla.</td></tr>';
  $('#sourceTable').innerHTML = html + '</tbody>';
  const st = D.snaps[i].sites;
  $('#sourceStatus').textContent = st ? `Viimeisin luku (${fmtSnap(D.snaps[i])}): ${Object.entries(st).map(([k, v]) => `${k} ${v.startsWith('ok') ? '✓' : `✗ (${v})`}`).join(' · ')}` : '';
}

function cheapest(series) {
  const i = D.latest;
  return series.slice().sort((a, b) => (a.get(i)?.v ?? 1e9) - (b.get(i)?.v ?? 1e9));
}

// ---------------------------------------------------------------------------
// Pörssisähkö
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Top 5
// ---------------------------------------------------------------------------
const TOP_N = 5;

// Halvin sopimus per yhtiö, TOP_N halvinta. Yhtiön sivun ja Energiaviraston
// samanhintaiset rivit yhdistetään (näytetään Energiaviraston tuotenimi).
function topList(pred, allowZero) {
  const i = D.latest;
  const byCompany = new Map();
  const nationalOnly = $('#topNational').checked;
  for (const p of productsAt(i, pred)) {
    if (p.m.seed) continue;
    if (nationalOnly && (!p.m.nat || p.m.dr)) continue;
    const pr = energyPrice(p.m, p.comps, allowZero);
    if (!pr) continue;
    const cur = byCompany.get(p.m.c);
    const better = !cur || pr.v < cur.pr.v - 1e-9;
    const tie = cur && Math.abs(pr.v - cur.pr.v) < 1e-9;
    if (better) byCompany.set(p.m.c, { ...p, pr, alsoSite: false });
    else if (tie) {
      if (p.m.src === 'site') cur.alsoSite = true;
      else if (cur.m.src === 'site') byCompany.set(p.m.c, { ...p, pr, alsoSite: true });
    }
  }
  return [...byCompany.values()].sort((a, b) => a.pr.v - b.pr.v).slice(0, TOP_N).map((r) => {
    const pv = D.vals[r.id][i - 1];
    return { ...r, prev: pv ? energyPrice(r.m, pv, allowZero)?.v : null };
  });
}

function renderTop() {
  const general = (m) => m.mt === 'General';
  const cards = [
    ...[12, 24, 6, 36, 0].map((t) => ({
      title: t === 0 ? 'Kiinteä, toistaiseksi voimassa' : `Kiinteä ${t} kk`,
      unit: 'c/kWh',
      rows: topList((m, c) => category(m, c) === 'fixed' && general(m) && m.term === t),
      view: 'fixed',
    })),
    {
      title: 'Pörssisähkö – marginaali',
      unit: 'c/kWh + pörssihinta',
      rows: topList((m) => m.pm === 'Spot' && general(m), true),
      view: 'spot',
    },
  ];
  const html = cards.map((c) => {
    const best = c.rows[0]?.pr.v;
    const items = c.rows.map((r, k) => {
      const diff = k === 0 ? '<span class="top-best">Halvin</span>' : `<span class="muted">+${fmt(r.pr.v - best)}</span>`;
      const tags = [r.alsoSite ? 'myös yhtiön sivu' : '', r.m.src === 'site' ? 'yhtiön sivu' : '', r.m.newOnly ? 'vain uusille' : '', !r.m.nat ? 'alueellinen' : '', r.m.dr ? 'toimitusvelvollinen' : '']
        .filter(Boolean).map((x) => `<span class="badge">${x}</span>`).join('');
      const name = r.m.link ? `<a href="${esc(r.m.link)}" target="_blank" rel="noopener">${esc(r.m.n.replace(' (yhtiön sivu)', ''))}</a>` : esc(r.m.n);
      return `<li class="${k === 0 ? 'first' : ''}"><span class="rank">${k + 1}</span>
        <div class="who"><strong>${esc(short(r.m.c))}</strong><div class="prod">${name}${tags}</div></div>
        <div class="val"><strong>${r.pr.txt}</strong>${deltaHtml(r.pr.v, r.prev)}<div>${diff}</div></div></li>`;
    }).join('');
    return `<div class="top-card"><div class="top-head"><h3>${c.title}</h3><span class="muted">${c.unit}</span></div>
      ${c.rows.length ? `<ol class="top-list">${items}</ol>` : '<p class="muted">Ei sopimuksia.</p>'}
      <button class="icon-btn top-more" data-goto="${c.view}">Kaikki sopimukset →</button></div>`;
  }).join('');
  $('#topGrid').innerHTML = html;
  $('#topSub').innerHTML = `Tilanne <strong>${fmtSnap(D.snaps[D.latest])}</strong> · ${S.tg === 'Household' ? 'kotitaloudet, hinnat sis. alv 25,5 %' : 'yritykset, hinnat yleensä alv 0 %'}. Viisi halvinta kussakin sopimustyypissä (yleissähkö, c/kWh); kultakin yhtiöltä sen halvin sopimus. Kuukausimaksuja ei huomioida.`;
}

function renderSpot() {
  const i = D.latest;
  const q = $('#spotSearch').value.trim().toLowerCase();
  let rows = productsAt(i, (m) => m.pm === 'Spot')
    .map((p) => ({ ...p, pr: energyPrice(p.m, p.comps, true), prev: D.vals[p.id][i - 1] }))
    .filter((p) => p.pr && (!q || `${p.m.c} ${p.m.n}`.toLowerCase().includes(q)));
  const best = rows.length ? Math.min(...rows.map((r) => r.pr.v)) : null;
  rows = sortRows(rows, S.sort.spot, {
    name: (r) => short(r.m.c), prod: (r) => r.m.n, v: (r) => r.pr.v, term: (r) => r.m.term,
  });
  let html = `<thead><tr>${sortHeader('spot', 'name', 'Yhtiö', 'sticky-col')}${sortHeader('spot', 'prod', 'Sopimus')}${sortHeader('spot', 'v', 'Marginaali c/kWh', 'num')}${sortHeader('spot', 'term', 'Kesto')}<th>Mittaus</th><th>Lisätiedot</th><th></th></tr></thead><tbody>`;
  for (const r of rows) {
    const pp = r.prev ? energyPrice(r.m, r.prev, true) : null;
    const isBest = Math.abs(r.pr.v - best) < 1e-9;
    html += `<tr><td class="sticky-col"><strong>${esc(short(r.m.c))}</strong></td><td class="name-cell">${esc(r.m.n)}</td><td class="num${isBest ? ' best' : ''}">${r.pr.txt}${deltaHtml(r.pr.v, pp?.v)}</td><td>${r.m.term === 0 ? 'Toistaiseksi' : `${r.m.term ?? '?'} kk`}</td><td>${MT_LABEL[r.m.mt] || ''}</td><td class="wrap-cell">${badges(r.m, r.comps)}</td><td>${linkHtml(r.m)}</td></tr>`;
  }
  if (!rows.length) html += '<tr><td colspan="7" class="muted">Ei sopimuksia.</td></tr>';
  $('#spotTable').innerHTML = html + '</tbody>';

  const companies = new Set();
  for (let k = 0; k < D.snaps.length; k++) for (const c of spotAgg(k).keys()) companies.add(c);
  const series = [...companies].sort((a, b) => short(a).localeCompare(short(b), 'fi'))
    .map((c) => ({ key: c, group: short(c), label: null, get: (k) => spotAgg(k).get(c) || null }));
  renderHistory('spotHistory', {
    series,
    flat: true,
    defaultChart: (visible) => cheapest(visible).slice(0, MAX_CHART).map((s) => s.key),
    resetKey: S.tg,
  });
  renderForecast();
}

async function loadLiveRealized() {
  try {
    const start = new Date(Date.now() - 2 * 86400000).toISOString();
    const end = new Date(Date.now() + 3 * 86400000).toISOString();
    const res = await fetch(`https://sahkotin.fi/prices.csv?fix=true&vat=true&start=${start}&end=${end}`);
    if (!res.ok) return;
    const rows = (await res.text()).split('\n').slice(1).map((l) => {
      const [t, v] = l.split(',');
      return [Date.parse(t), Number(v)];
    }).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
    if (rows.length) forecast.realized = rows;
  } catch { /* käytetään tallennettua dataa */ }
}

function renderForecast() {
  const el = $('#forecastChart');
  if (!forecast || !window.echarts) {
    el.innerHTML = '<p class="muted">Ennustetta ei saatu ladattua.</p>';
    return;
  }
  const today = helsinkiNow().date;
  const startMs = Date.parse(`${today}T00:00:00`) - 86400000 * 1; // eilisestä alkaen (paikallinen aika)
  const realized = forecast.realized.filter(([t]) => t >= startMs);
  const lastReal = realized.length ? Math.max(...realized.map(([t]) => t)) : Date.now();
  const pred = forecast.prediction.filter(([t, v]) => t > lastReal && v != null);
  const merged = new Map();
  for (const [t, v] of pred) merged.set(t, v);
  for (const [t, v] of realized) merged.set(t, v);
  const byDay = new Map();
  for (const [t, v] of merged) {
    const d = helsinkiDate(t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push([t, v]);
  }
  const daily = [];
  for (const pts of byDay.values()) {
    pts.sort((a, b) => a[0] - b[0]);
    const avg = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    daily.push([pts[0][0], avg], [pts[pts.length - 1][0] + 3599000, avg], [pts[pts.length - 1][0] + 3600000, null]);
  }
  const chart = getChart(el);
  const text = css('--text-2');
  chart.setOption({
    animation: false,
    grid: { left: 48, right: 16, top: 40, bottom: 56 },
    legend: { top: 0, textStyle: { color: text }, data: ['Toteutunut', 'Ennuste', 'Päivän keskihinta'] },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => (v == null ? '–' : `${fmt(v)} c/kWh`),
      axisPointer: { type: 'line' },
    },
    xAxis: {
      type: 'time',
      axisLabel: { color: text, hideOverlap: true, formatter: { day: '{d}.{M}.', month: '{d}.{M}.', year: '{yyyy}', hour: '{HH}:{mm}' } },
      axisLine: { lineStyle: { color: css('--border') } },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', name: 'c/kWh', nameTextStyle: { color: text },
      axisLabel: { color: text, formatter: (v) => fmt(v).replace(',00', '') },
      splitLine: { lineStyle: { color: css('--grid') } },
    },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8, borderColor: css('--border'), textStyle: { color: text } }],
    series: [
      { name: 'Toteutunut', type: 'bar', data: realized, barWidth: '70%', itemStyle: { color: css('--s1'), borderRadius: [2, 2, 0, 0] } },
      { name: 'Ennuste', type: 'line', data: pred, showSymbol: false, lineStyle: { width: 2, color: css('--s2') }, itemStyle: { color: css('--s2') }, areaStyle: { color: css('--s2'), opacity: 0.08 } },
      { name: 'Päivän keskihinta', type: 'line', data: daily, showSymbol: false, connectNulls: false, lineStyle: { width: 1.5, type: 'dashed', color: css('--text-3') }, itemStyle: { color: css('--text-3') } },
    ],
  }, true);
  chart.dispatchAction({ type: 'hideTip' });
  const upd = new Date(forecast.fetchedAt);
  $('#forecastMeta').textContent = `Ennuste haettu ${upd.toLocaleString('fi-FI', { timeZone: 'Europe/Helsinki' })}. Vedä tai zoomaa kuvaajaa.`;
}

// ---------------------------------------------------------------------------
// Muut
// ---------------------------------------------------------------------------
function compsText(m, comps) {
  if (isPackage(comps) && comps.every((c) => c[1] === 0)) return '<span class="muted">Hinta kuukausimaksussa</span>';
  return comps.map((c) => `${COMP_LABEL[c[0]] || c[0]} <strong>${fmt(c[1])}</strong>`).join(' · ');
}

function renderOther() {
  const i = D.latest;
  const q = $('#otherSearch').value.trim().toLowerCase();
  const pred = (m, c) => category(m, c) === 'other' && (S.otherType === 'all' || otherKind(m, c) === S.otherType);
  let rows = productsAt(i, pred).filter((p) => !q || `${p.m.c} ${p.m.n}`.toLowerCase().includes(q));
  rows = sortRows(rows, S.sort.other, {
    name: (r) => short(r.m.c), prod: (r) => r.m.n, kind: (r) => OTHER_LABEL[otherKind(r.m, r.comps)],
    term: (r) => r.m.term, v: (r) => energyPrice(r.m, r.comps)?.v,
  });
  let html = `<thead><tr>${sortHeader('other', 'name', 'Yhtiö', 'sticky-col')}${sortHeader('other', 'prod', 'Sopimus')}${sortHeader('other', 'kind', 'Tyyppi')}${sortHeader('other', 'term', 'Kesto')}${sortHeader('other', 'v', 'Hinnat c/kWh')}<th>Lisätiedot</th><th></th></tr></thead><tbody>`;
  for (const r of rows) {
    const kind = otherKind(r.m, r.comps);
    const pv = D.vals[r.id][i - 1];
    const changed = pv && JSON.stringify(pv) !== JSON.stringify(r.comps) ? '<span class="badge">muuttunut</span>' : '';
    html += `<tr><td class="sticky-col"><strong>${esc(short(r.m.c))}</strong></td><td class="name-cell">${esc(r.m.n)}</td><td>${OTHER_LABEL[kind]}${r.m.mt !== 'General' ? ` <span class="muted">(${MT_LABEL[r.m.mt]})</span>` : ''}</td><td>${r.m.term === 0 ? 'Toistaiseksi' : `${r.m.term ?? '?'} kk`}</td><td>${compsText(r.m, r.comps)}${changed}</td><td class="wrap-cell">${badges(r.m, r.comps)}${r.m.info ? `<details class="info"><summary>Kuvaus</summary><p>${esc(r.m.info)}</p></details>` : ''}</td><td>${linkHtml(r.m)}</td></tr>`;
  }
  if (!rows.length) html += '<tr><td colspan="7" class="muted">Ei sopimuksia.</td></tr>';
  $('#otherTable').innerHTML = html + '</tbody>';

  const ids = new Set();
  for (let k = 0; k < D.snaps.length; k++) for (const p of productsAt(k, pred)) ids.add(p.id);
  const series = [...ids].map((id) => {
    const m = D.metas[id];
    return {
      key: id, group: short(m.c), label: m.n,
      get: (k) => {
        const c = D.vals[id][k];
        if (!c) return null;
        const vals = c.filter((x) => x[1] > 0).map((x) => x[1]);
        if (!vals.length) return null;
        return { v: vals[0], txt: vals.map(fmt).join(' / ') };
      },
    };
  }).sort((a, b) => a.group.localeCompare(b.group, 'fi') || a.label.localeCompare(b.label, 'fi'));
  renderHistory('otherHistory', {
    series,
    defaultChart: (visible) => cheapest(visible).slice(0, MAX_CHART).map((s) => s.key),
    resetKey: `${S.tg}|${S.otherType}`,
  });
}

// ---------------------------------------------------------------------------
// Yleinen historiataulukko + kaavio
// ---------------------------------------------------------------------------
function renderHistory(elId, cfg) {
  const el = document.getElementById(elId);
  let h = S.hist[elId];
  if (!h) h = S.hist[elId] = { period: 'all', daily: false, desc: true, groups: null, chart: null, resetKey: null, slots: {} };
  if (h.resetKey !== cfg.resetKey) { h.chart = null; h.slots = {}; h.resetKey = cfg.resetKey; }

  // Rivit
  const N = D.snaps.length;
  let idx = [...Array(N).keys()];
  if (h.period !== 'all') {
    const days = Number(h.period);
    const last = Date.parse(D.snaps[N - 1].t);
    idx = idx.filter((i) => last - Date.parse(D.snaps[i].t) <= days * 86400000);
  }
  if (h.daily) {
    const lastOfDay = new Map();
    for (const i of idx) lastOfDay.set(D.snaps[i].t.slice(0, 10), i);
    idx = [...lastOfDay.values()];
  }

  const allGroups = [...new Set(cfg.series.map((s) => s.group))];
  const groupOn = (g) => !h.groups || h.groups.has(g);
  const visible = cfg.series.filter((s) => groupOn(s.group) && idx.some((i) => s.get(i)));
  if (!h.chart) h.chart = cfg.defaultChart(visible);
  const chartKeys = h.chart.filter((k) => visible.some((s) => s.key === k));
  for (const k of chartKeys) {
    if (h.slots[k] == null) {
      const used = new Set(Object.values(h.slots));
      let s = 0; while (used.has(s)) s++;
      h.slots[k] = s;
    }
  }

  const seg = (name, opts, cur) => `<span class="seg" role="group">${opts.map(([v, l]) => `<button data-h="${elId}" data-${name}="${v}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join('')}</span>`;
  let html = `<div class="controls">
    <span><span class="ctl-label">Aikaväli</span>${seg('period', [['30', '30 pv'], ['90', '90 pv'], ['all', 'Kaikki']], h.period)}</span>
    <span>${seg('order', [['desc', 'Uusin ensin'], ['asc', 'Vanhin ensin']], h.desc ? 'desc' : 'asc')}</span>
    <label class="chk"><input type="checkbox" data-h="${elId}" data-daily ${h.daily ? 'checked' : ''}> Vain päivän viimeisin</label>
    <details class="groups"><summary class="icon-btn">Yhtiöt (${allGroups.filter(groupOn).length}/${allGroups.length})</summary>
      <div class="note" style="margin-top:6px;max-width:640px">
        <button class="icon-btn" data-h="${elId}" data-groups="all">Kaikki</button>
        <button class="icon-btn" data-h="${elId}" data-groups="none">Ei mitään</button>
        <div style="columns:3 160px;margin-top:8px">${allGroups.map((g) => `<label class="chk" style="display:flex"><input type="checkbox" data-h="${elId}" data-group="${esc(g)}" ${groupOn(g) ? 'checked' : ''}> ${esc(g)}</label>`).join('')}</div>
      </div>
    </details>
  </div>`;

  // Kaavio
  const chip = (s) => {
    const on = chartKeys.includes(s.key);
    const col = on ? `var(--s${h.slots[s.key] + 1})` : 'var(--border)';
    return `<button class="chip" data-h="${elId}" data-chip="${esc(s.key)}" aria-pressed="${on}" title="${on ? 'Poista kaaviosta' : 'Lisää kaavioon'}"><span class="dot" style="background:${col}"></span>${esc(cfg.flat ? s.group : `${s.group} ${s.label}`)}${on ? ' ×' : ''}</button>`;
  };
  const openChips = el.querySelector('details.more-chips')?.open;
  html += `<div class="chart small" id="${elId}-chart"></div>
    <div class="chips">${visible.filter((s) => chartKeys.includes(s.key)).map(chip).join('')}</div>
    <details class="more-chips"${openChips ? ' open' : ''}><summary class="hint" style="cursor:pointer">+ Lisää sarjoja kaavioon (enintään ${MAX_CHART})</summary>
      <div class="chips">${visible.filter((s) => !chartKeys.includes(s.key)).map(chip).join('')}</div>
    </details><div class="sep"></div>`;

  // Taulukko
  const order = h.desc ? idx.slice().reverse() : idx;
  const prevOf = new Map(idx.map((i, k) => [i, k > 0 ? idx[k - 1] : null]));
  let head;
  if (cfg.flat) {
    head = `<tr><th class="sticky-col">Keruuhetki</th>${visible.map((s) => `<th class="num">${esc(s.group)}</th>`).join('')}</tr>`;
  } else {
    const groups = [];
    for (const s of visible) {
      const g = groups[groups.length - 1];
      if (g && g.name === s.group) g.n++; else groups.push({ name: s.group, n: 1 });
    }
    head = `<tr><th class="sticky-col" rowspan="2">Keruuhetki</th>${groups.map((g) => `<th class="group" colspan="${g.n}">${esc(g.name)}</th>`).join('')}</tr>
      <tr class="h2">${visible.map((s, k) => `<th class="num${k === 0 || visible[k - 1].group !== s.group ? ' gstart' : ''}" title="${esc(s.label)}">${esc(s.label.length > 28 ? `${s.label.slice(0, 26)}…` : s.label)}</th>`).join('')}</tr>`;
  }
  let body = '';
  for (const i of order) {
    const p = prevOf.get(i);
    body += `<tr><td class="sticky-col">${fmtSnap(D.snaps[i])}${D.snaps[i].src === 'seed' ? ' <span class="muted" title="Tuotu aiemmasta taulukosta">*</span>' : ''}</td>`;
    visible.forEach((s, k) => {
      const v = s.get(i);
      const pv = p != null ? s.get(p) : null;
      const gs = !cfg.flat && (k === 0 || visible[k - 1].group !== s.group) ? ' gstart' : '';
      let cls = '';
      let arrow = '';
      if (v && pv && Math.abs(v.v - pv.v) >= 0.005) {
        cls = v.v > pv.v ? ' up' : ' down';
        arrow = v.v > pv.v ? ' ▲' : ' ▼';
      }
      body += `<td class="num${gs}${cls}"${cls ? ` title="Edellinen ${esc(pv.txt)}"` : ''}>${v ? v.txt + arrow : ''}</td>`;
    });
    body += '</tr>';
  }
  html += `<div class="table-scroll"><table>${visible.length ? `<thead>${head}</thead><tbody>${body}</tbody>` : '<tbody><tr><td class="muted">Ei historiatietoja valinnoilla.</td></tr></tbody>'}</table></div>
    <p class="hint">▲ hinta nousi / ▼ laski edellisestä rivistä. * = tuotu aiemmin käsin kerätystä taulukosta.</p>`;

  const oldChart = charts[`${elId}-chart`];
  if (oldChart) { oldChart.dispose(); delete charts[`${elId}-chart`]; }
  const openDetails = el.querySelector('details.groups')?.open;
  el.innerHTML = html;
  if (openDetails) el.querySelector('details.groups').open = true;

  // Kaavion piirto
  if (!window.echarts) return;
  const chart = getChart(document.getElementById(`${elId}-chart`));
  const text = css('--text-2');
  const chron = idx;
  const chartSeries = chartKeys.map((k) => {
    const s = visible.find((x) => x.key === k);
    const color = css(`--s${h.slots[k] + 1}`);
    return {
      name: cfg.flat ? s.group : `${s.group} ${s.label}`,
      type: 'line', step: 'end', showSymbol: chron.length < 40, symbolSize: 6,
      data: chron.map((i) => [Date.parse(D.snaps[i].t), s.get(i)?.v ?? null]),
      lineStyle: { width: 2, color }, itemStyle: { color }, connectNulls: false,
    };
  });
  chart.setOption({
    animation: false,
    grid: { left: 48, right: 16, top: chartSeries.length > 1 ? 56 : 24, bottom: 32 },
    legend: chartSeries.length > 1 ? { type: 'scroll', top: 0, textStyle: { color: text } } : { show: false },
    tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '–' : `${fmt(v)} c/kWh`) },
    xAxis: { type: 'time', axisLabel: { color: text, hideOverlap: true, formatter: { day: '{d}.{M}.', month: '{d}.{M}.', year: '{yyyy}', hour: '{HH}:{mm}' } }, axisLine: { lineStyle: { color: css('--border') } } },
    yAxis: { type: 'value', scale: true, name: 'c/kWh', nameTextStyle: { color: text }, axisLabel: { color: text, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: css('--grid') } } },
    series: chartSeries,
  }, true);
  if (!chartSeries.length) {
    chart.setOption({ title: { text: 'Valitse sarjoja kaavioon', left: 'center', top: 'middle', textStyle: { color: css('--text-3'), fontSize: 14, fontWeight: 'normal' } } });
  }
}

function getChart(el) {
  let c = echarts.getInstanceByDom(el);
  if (!c) { c = echarts.init(el, null, { renderer: 'canvas' }); charts[el.id] = c; }
  return c;
}

// ---------------------------------------------------------------------------
// Tapahtumat
// ---------------------------------------------------------------------------
function render() {
  if (!D) return;
  if (S.view === 'top') renderTop();
  if (S.view === 'fixed') renderFixed();
  if (S.view === 'spot') renderSpot();
  if (S.view === 'other') renderOther();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, th[data-sort], tr[data-open]');
  if (!t) return;
  const ds = t.dataset;
  if (ds.goto) {
    document.querySelector(`nav.tabs button[data-view="${ds.goto}"]`).click();
    window.scrollTo(0, 0);
  } else if (ds.view) {
    S.view = ds.view;
    document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === t)));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${S.view}`));
    try { history.replaceState(null, '', `#${S.view}`); } catch { /* ignore */ }
    render();
  } else if (ds.tg) {
    S.tg = ds.tg;
    t.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    render();
  } else if (ds.mt) {
    S.mt = ds.mt;
    t.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    render();
  } else if (ds.src) {
    S.src = ds.src;
    t.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    render();
  } else if (ds.ot) {
    S.otherType = ds.ot;
    t.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    render();
  } else if (ds.sort) {
    const [view, col] = ds.sort.split(':');
    const s = S.sort[view];
    if (s.col === col) s.dir *= -1; else { s.col = col; s.dir = 1; }
    render();
  } else if (ds.open) {
    S.open.has(ds.open) ? S.open.delete(ds.open) : S.open.add(ds.open);
    render();
  } else if (ds.h) {
    const h = S.hist[ds.h];
    if (ds.period) h.period = ds.period;
    else if (ds.order) h.desc = ds.order === 'desc';
    else if (ds.groups === 'all') h.groups = null;
    else if (ds.groups === 'none') h.groups = new Set();
    else if (ds.chip) {
      const k = ds.chip;
      if (h.chart.includes(k)) { h.chart = h.chart.filter((x) => x !== k); delete h.slots[k]; }
      else if (h.chart.length < MAX_CHART) h.chart.push(k);
      else { alert(`Kaavioon mahtuu enintään ${MAX_CHART} sarjaa. Poista ensin jokin valinta.`); return; }
    } else return;
    render();
  } else if (t.id === 'themeBtn') {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
    if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
    try { localStorage.setItem('theme', next); } catch { /* ignore */ }
    render();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  const ds = t.dataset;
  if (ds.term != null) {
    const v = Number(ds.term);
    t.checked ? S.fixedTerms.add(v) : S.fixedTerms.delete(v);
    render();
  } else if (ds.h) {
    const h = S.hist[ds.h];
    if ('daily' in ds) h.daily = t.checked;
    else if (ds.group != null) {
      if (!h.groups) h.groups = new Set(t.closest('.groups').querySelectorAll('input[data-group]').length ? [...t.closest('.groups').querySelectorAll('input[data-group]')].map((x) => x.dataset.group) : []);
      t.checked ? h.groups.add(ds.group) : h.groups.delete(ds.group);
    }
    render();
  }
});

document.getElementById('topNational').addEventListener('change', render);
['fixedSearch', 'spotSearch', 'otherSearch'].forEach((id) => document.getElementById(id).addEventListener('input', render));
window.addEventListener('resize', () => Object.values(charts).forEach((c) => !c.isDisposed() && c.resize()));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

// ---------------------------------------------------------------------------
// Käynnistys
// ---------------------------------------------------------------------------
function statusText() {
  const s = D.snaps[D.latest];
  const now = helsinkiNow();
  const mins = now.h * 60 + now.m;
  const next = mins < 9 * 60 ? 'tänään klo 9.00' : mins < 17 * 60 ? 'tänään klo 17.00' : 'huomenna klo 9.00';
  const n = D.ids.filter((id) => D.vals[id][D.latest]).length;
  return `Päivitetty <strong>${fmtSnap(s)}</strong> · ${n} sopimusta<br>Seuraava päivitys ${next}`;
}

(async function init() {
  try { const th = localStorage.getItem('theme'); if (th) document.documentElement.dataset.theme = th; } catch { /* ignore */ }
  const hash = location.hash.slice(1);
  if (['top', 'fixed', 'spot', 'other'].includes(hash)) document.querySelector(`nav.tabs button[data-view="${hash}"]`).click();
  try {
    const [hist, fc] = await Promise.all([
      fetch('data/history.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`history.json: HTTP ${r.status}`); return r.json(); }),
      fetch('data/forecast.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    D = expand(hist);
    forecast = fc;
    $('#status').innerHTML = statusText();
    render();
    if (forecast) { await loadLiveRealized(); if (S.view === 'spot') renderForecast(); }
  } catch (err) {
    const box = $('#loadError');
    box.classList.remove('hidden');
    box.textContent = `Datan lataus epäonnistui: ${err.message}. Aja ensin "npm run collect:now".`;
    $('#status').textContent = '';
  }
}());
