'use strict';

// ---------------------------------------------------------------------------
// Tila ja apufunktiot
// ---------------------------------------------------------------------------
function loadPref(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function savePref(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ei tallennusta */ }
}

const S = {
  tg: loadPref('tg', 'Household'),
  national: loadPref('national', false), // piilota alueelliset ja toimitusvelvolliset (Tänään)
  topSel: 't12',
  sheet: null, // avoinna oleva paneeli: { type: 'company', company } | { type: 'settings' }
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
let campaigns = null;
const charts = {};

const TERMS = [0, 6, 12, 24, 36];
const TERM_LABEL = (t) => (t === 0 ? 'Toistaiseksi' : `${t} kk`);
const COMP_LABEL = {
  General: 'Energia', DayTime: 'Päivä', NightTime: 'Yö', SeasonalWinterDay: 'Talvipäivä',
  SeasonalOther: 'Muu aika', Spot: 'Pörssi +',
};
const MT_LABEL = { General: 'Yleissähkö', Time: 'Aikasähkö', Season: 'Kausisähkö' };
const MAX_CHART = 8;

// Suosikit: yhtiöiden täydet nimet, tallennetaan selaimeen
const FAV = new Set(loadPref('favs', []));
const isFav = (c) => FAV.has(c);
const favShort = () => new Set([...FAV].map((c) => short(c)));
function toggleFav(c) {
  if (FAV.has(c)) FAV.delete(c); else FAV.add(c);
  savePref('favs', [...FAV]);
}
const starHtml = (c) => `<span class="star${isFav(c) ? ' on' : ''}" role="button" tabindex="0" data-fav="${esc(c)}" aria-pressed="${isFav(c)}" title="${isFav(c) ? 'Poista suosikeista' : 'Lisää suosikiksi'}">${isFav(c) ? '★' : '☆'}</span>`;
const cleanName = (n) => n.replace(' (yhtiön sivu)', '');
let installPrompt = null;

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
// Energiavirasto antaa sopimukselle uuden tunnisteen aina, kun yhtiö julkaisee
// sen uudelleen. Saman sopimuksen tunnisteet yhdistetään yhdeksi sarjaksi, jotta
// hintamuutokset ja historia eivät katkea. Päällekkäisistä valitaan uusin versio.
const productKey = (m) => [m.c, m.n, m.term, m.mt, m.tg, m.pm, m.src || '', m.nat, m.dr, m.newOnly, m.seed ? 'seed' : ''].join('|');

function expand(history) {
  const snaps = history.snapshots;
  const N = snaps.length;
  const groups = new Map();
  for (const [id, p] of Object.entries(history.products)) {
    const arr = new Array(N).fill(null);
    let k = 0;
    let cur = null;
    for (let i = 0; i < N; i++) {
      while (k < p.h.length && p.h[k][0] <= i) cur = p.h[k++][1];
      arr[i] = cur;
    }
    const key = productKey(p.m);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ m: p.m, arr, first: arr.findIndex(Boolean), last: arr.findLastIndex(Boolean) });
  }
  const metas = {};
  const vals = {};
  for (const [key, members] of groups) {
    members.sort((a, b) => b.first - a.first); // uusin versio ensin
    vals[key] = Array.from({ length: N }, (_, i) => members.find((x) => x.arr[i])?.arr[i] || null);
    metas[key] = members.reduce((a, b) => (b.last > a.last ? b : a)).m;
  }
  let latest = N - 1;
  for (let i = N - 1; i >= 0; i--) if (snaps[i].src === 'api') { latest = i; break; }
  const firstApi = snaps.findIndex((x) => x.src === 'api');
  const first = {};
  for (const id of Object.keys(vals)) first[id] = vals[id].findIndex(Boolean);
  return { snaps, metas, vals, ids: Object.keys(metas), latest, first, firstApi };
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
  rows = [...rows.filter(([c]) => isFav(c)), ...rows.filter(([c]) => !isFav(c))];

  let html = `<thead><tr>${sortHeader('fixed', 'name', 'Yhtiö', 'sticky-col')}${cols.map((b) => sortHeader('fixed', b, b === 'other' ? 'Muu kesto' : TERM_LABEL(b), 'num')).join('')}</tr></thead><tbody>`;
  let cards = '';
  for (const [c, r] of rows) {
    html += `<tr class="company-row" data-company="${esc(c)}"><td class="sticky-col"><strong>${esc(short(c))}</strong> ${starHtml(c)}</td>`;
    const chips = [];
    for (const b of cols) {
      const cell = r[b];
      if (!cell) { html += '<td class="num muted">–</td>'; continue; }
      const isBest = best[b] != null && Math.abs(cell.v - best[b]) < 1e-9;
      const extra = b === 'other' ? ` <span class="muted">(${cell.term ?? '?'} kk)</span>` : '';
      const d = deltaHtml(cell.v, prev.get(c)?.[b]?.v);
      html += `<td class="num${isBest ? ' best' : ''}">${cell.txt}${extra}${d}</td>`;
      chips.push(`<div class="term-chip${isBest ? ' best' : ''}"><span>${b === 'other' ? `${cell.term ?? '?'} kk` : TERM_LABEL(b)}</span><b>${cell.txt}</b>${d}</div>`);
    }
    html += '</tr>';
    cards += `<div class="mcard" role="button" tabindex="0" data-company="${esc(c)}"><div class="co">${esc(short(c))} ${starHtml(c)}</div><div class="term-chips">${chips.join('')}</div></div>`;
  }
  if (!rows.length) html += `<tr><td colspan="${cols.length + 1}" class="muted">Ei sopimuksia valituilla ehdoilla.</td></tr>`;
  $('#fixedTable').innerHTML = html + '</tbody>';
  $('#fixedCards').innerHTML = cards || '<p class="muted">Ei sopimuksia valituilla ehdoilla.</p>';

  $('#fixedTerms').innerHTML = TERMS.map((t) => `<label><input type="checkbox" data-term="${t}" ${S.fixedTerms.has(t) ? 'checked' : ''}>${TERM_LABEL(t)}</label>`).join('');

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
      const favs = favShort();
      const pref = byName.filter((s) => favs.has(s.group)).length ? byName.filter((s) => favs.has(s.group)) : byName.filter((s) => prefer.includes(s.group));
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

// Kaavion oletussarjat: suosikit ensin, sitten halvimmat
function favFirst(visible) {
  const favs = favShort();
  const f = visible.filter((x) => favs.has(x.group));
  return [...f, ...cheapest(visible).filter((x) => !f.includes(x))].slice(0, MAX_CHART).map((x) => x.key);
}

function cheapest(series) {
  const i = D.latest;
  return series.slice().sort((a, b) => (a.get(i)?.v ?? 1e9) - (b.get(i)?.v ?? 1e9));
}

// ---------------------------------------------------------------------------
// Pörssisähkö
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Kampanjat (Black Friday ym.)
// ---------------------------------------------------------------------------
const activeCampaigns = () => (campaigns?.offers || []).filter((o) => o.lastSeen === campaigns.updatedAt);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('fi-FI', { timeZone: 'Europe/Helsinki' }) : '');

function updateCampaignCount() {
  const n = new Set(activeCampaigns().map((o) => o.company)).size;
  const el = $('#campaignCount');
  el.textContent = n;
  el.classList.toggle('hidden', !n);
  el.title = `${n} yhtiöllä kampanja käynnissä`;
}

function highlight(text) {
  let re;
  try { re = new RegExp(campaigns.keywords, 'gi'); } catch { return esc(text); }
  return esc(text).replace(re, (m) => `<mark>${m}</mark>`);
}

function offerHtml(o, { compact = false } = {}) {
  const host = (() => { try { return new URL(o.url).hostname.replace(/^www\./, '') + new URL(o.url).pathname.replace(/\/$/, ''); } catch { return o.url; } })();
  const snips = o.snippets || (o.snippet ? [o.snippet] : []);
  const first = snips.slice(0, compact ? 1 : 2).map((x) => `<p class="snip">${highlight(x)}</p>`).join('');
  const more = !compact && snips.length > 2
    ? `<details class="info"><summary>${snips.length - 2} muuta mainintaa</summary>${snips.slice(2).map((x) => `<p class="snip">${highlight(x)}</p>`).join('')}</details>` : '';
  const prices = (o.prices || []).map((p) => `<span class="badge">${esc(p)}</span>`).join('');
  return `<div class="offer">
    <div class="offer-head"><a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.source === 'api' ? o.title : host)}</a>
      ${o.source === 'api' ? '<span class="badge">Energiavirasto</span>' : ''}${o.contract ? `<span class="badge">${esc(o.contract)}</span>` : ''}${prices}</div>
    ${first}${more}</div>`;
}

function renderCampaigns() {
  if (!campaigns) {
    $('#campaignActive').innerHTML = '<p class="muted">Kampanjahakua ei ole vielä ajettu. Tiedot päivittyvät seuraavalla keruukerralla.</p>';
    $('#campaignPast').innerHTML = '';
    return;
  }
  const act = activeCampaigns();
  const byCompany = new Map();
  for (const o of act) {
    if (!byCompany.has(o.company)) byCompany.set(o.company, []);
    byCompany.get(o.company).push(o);
  }
  const cards = [...byCompany.entries()].sort((a, b) => short(a[0]).localeCompare(short(b[0]), 'fi')).map(([c, offers]) => {
    offers.sort((a, b) => (b.prices?.length || 0) - (a.prices?.length || 0));
    const kws = [...new Set(offers.map((o) => o.keyword).filter(Boolean))];
    const period = offers.map((o) => o.period).find(Boolean);
    const since = offers.map((o) => o.firstSeen).sort()[0];
    return `<div class="campaign-card">
      <div class="campaign-head"><h3>${esc(short(c))}</h3>${kws.map((k) => `<span class="kw">${esc(k)}</span>`).join('')}</div>
      <p class="campaign-meta">${period ? `Kampanja-aika <strong>${esc(period)}</strong> · ` : ''}Havaittu ensimmäisen kerran ${fmtDate(since)} · ${offers.length} sivua</p>
      ${offers.map((o, k) => offerHtml(o, { compact: k >= 3 })).join('')}
    </div>`;
  });
  $('#campaignActive').innerHTML = cards.length
    ? `<div class="campaign-grid">${cards.join('')}</div>`
    : '<p class="muted">Yhdeltäkään yhtiöltä ei löytynyt tällä hetkellä Black Friday- tai vastaavaa kampanjaa.</p>';

  const past = (campaigns.offers || []).filter((o) => o.lastSeen !== campaigns.updatedAt);
  $('#campaignPast').innerHTML = past.length
    ? `<div class="table-scroll short"><table><thead><tr><th class="sticky-col">Yhtiö</th><th>Kampanja</th><th>Näkyvissä</th><th>Ote</th></tr></thead><tbody>${past.map((o) => `<tr><td class="sticky-col"><strong>${esc(short(o.company))}</strong></td><td>${esc(o.keyword || '')}</td><td>${fmtDate(o.firstSeen)} – ${fmtDate(o.lastSeen)}</td><td class="wrap-cell"><a href="${esc(o.url)}" target="_blank" rel="noopener">${highlight((o.snippets || [o.snippet || ''])[0].slice(0, 160))}</a></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Ei vielä päättyneitä kampanjoita.</p>';

  const without = (campaigns.checkedCompanies || []).filter((c) => !byCompany.has(c)).map(short);
  $('#campaignSub').innerHTML = `Black Friday, Black Week, Black Month, Cyber Monday, Singles’ Day ym. tarjoukset sähköyhtiöiden verkkosivuilta ja Energiaviraston sopimustiedoista. Viimeisin haku <strong>${new Date(campaigns.updatedAt).toLocaleString('fi-FI', { timeZone: 'Europe/Helsinki' })}</strong>: ${campaigns.checkedPages} sivua, ${(campaigns.checkedCompanies || []).length} yhtiötä, kampanja ${byCompany.size} yhtiöllä.`;
  $('#campaignChecked').innerHTML = `Ei kampanjaa: ${without.map(esc).join(', ') || '–'}.${campaigns.failedPages?.length ? ` Sivua ei saatu luettua: ${campaigns.failedPages.map((p) => esc(short(p.company))).join(', ')}.` : ''} Verkkosivuilta haetaan yhtiöiden etusivut, seurattavat sopimussivut ja niiltä löytyvät kampanjalinkit.`;
}

// ---------------------------------------------------------------------------
// Top 5
// ---------------------------------------------------------------------------
const TOP_N = 5;

// Halvin sopimus per yhtiö, TOP_N halvinta. Yhtiön sivun ja Energiaviraston
// samanhintaiset rivit yhdistetään (näytetään Energiaviraston tuotenimi).
function topList(pred, allowZero, i = D.latest, n = TOP_N) {
  const byCompany = new Map();
  for (const p of productsAt(i, pred)) {
    if (p.m.seed) continue;
    if (S.national && (!p.m.nat || p.m.dr)) continue;
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
  const now = Date.parse(D.snaps[i].t);
  return [...byCompany.values()].sort((a, b) => a.pr.v - b.pr.v).slice(0, n).map((r) => {
    const pv = D.vals[r.id][i - 1];
    const f = D.first[r.id];
    const isNew = f > D.firstApi && now - Date.parse(D.snaps[f].t) < 3 * 86400000;
    return { ...r, prev: pv ? energyPrice(r.m, pv, allowZero)?.v : null, isNew };
  });
}

const TOP_CARDS = [
  { key: 't12', title: 'Kiinteä 12 kk', label: '12 kk', term: 12 },
  { key: 't24', title: 'Kiinteä 24 kk', label: '24 kk', term: 24 },
  { key: 't6', title: 'Kiinteä 6 kk', label: '6 kk', term: 6 },
  { key: 't36', title: 'Kiinteä 36 kk', label: '36 kk', term: 36 },
  { key: 't0', title: 'Kiinteä, toistaiseksi', label: 'Toistaiseksi', term: 0 },
  { key: 'spot', title: 'Pörssisähkö – marginaali', label: 'Pörssi', spot: true },
];
const cardPred = (c) => (c.spot
  ? (m) => m.pm === 'Spot' && m.mt === 'General'
  : (m, cs) => category(m, cs) === 'fixed' && m.mt === 'General' && m.term === c.term);

function sparkSvg(vals, color, fill) {
  if (vals.length < 2) return '';
  const w = 120; const h = 40;
  const min = Math.min(...vals); const max = Math.max(...vals); const r = max - min || 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - 3 - ((v - min) / r) * (h - 6)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${fill ? `<path d="${d}L${w},${h}L0,${h}Z" fill="${color}" opacity="0.18"/>` : ''}<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

// Halvimman hinnan kehitys viimeiset 30 päivää (yksi arvo per keruu)
function trendFor(card, days = 30) {
  const end = Date.parse(D.snaps[D.latest].t);
  const pts = [];
  for (let i = 0; i <= D.latest; i++) {
    const sn = D.snaps[i];
    if (sn.src !== 'api' || end - Date.parse(sn.t) > days * 86400000) continue;
    const r = topList(cardPred(card), !!card.spot, i, 1)[0];
    if (r) pts.push(r.pr.v);
  }
  return pts;
}

const hourOf = (ms) => Number(new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));

// Pörssihinta nyt + päivän tunnit (toteutunut, puuttuvat tunnit ennusteesta)
function spotToday() {
  if (!forecast) return null;
  const now = Date.now();
  const today = helsinkiDate(now);
  const hours = new Map();
  for (const [t, v] of forecast.prediction || []) if (v != null && helsinkiDate(t) === today) hours.set(t, { v, est: true });
  for (const [t, v] of forecast.realized || []) if (helsinkiDate(t) === today) hours.set(t, { v, est: false });
  const pts = [...hours].sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  const cur = pts.filter(([t]) => t <= now).at(-1) || pts[0];
  const avg = pts.reduce((sum, p) => sum + p[1].v, 0) / pts.length;
  const rest = pts.filter(([t]) => t >= cur[0]);
  const cheap = rest.reduce((a, b) => (b[1].v < a[1].v ? b : a), rest[0]);
  return { t: cur[0], v: cur[1].v, est: cur[1].est, avg, cheap, series: pts.map((p) => p[1].v) };
}

function topRow(r, k, best) {
  const tags = [];
  if (r.isNew) tags.push('<span class="badge new">Uusi</span>');
  if (r.prev != null && r.pr.v < r.prev - 0.005) tags.push(`<span class="badge good">▼ ${fmt(r.prev - r.pr.v)}</span>`);
  if (r.prev != null && r.pr.v > r.prev + 0.005) tags.push(`<span class="badge bad">▲ ${fmt(r.pr.v - r.prev)}</span>`);
  if (!r.m.nat) tags.push('<span class="badge">alueellinen</span>');
  if (r.m.dr) tags.push('<span class="badge">toimitusvelv.</span>');
  if (r.m.newOnly) tags.push('<span class="badge">vain uusille</span>');
  const diff = k === 0 ? '<span class="top-best">Halvin</span>' : `+${fmt(r.pr.v - best)}`;
  return `<li class="${k === 0 ? 'first' : ''}"><div class="row-btn" role="button" tabindex="0" data-company="${esc(r.m.c)}">
    <span class="rank">${k + 1}</span>
    <div class="who"><div class="co">${esc(short(r.m.c))}${starHtml(r.m.c)}${tags.join('')}</div><div class="prod">${esc(cleanName(r.m.n))}${r.alsoSite ? ' · myös yhtiön sivulla' : ''}</div></div>
    <div class="price">${r.pr.txt}<small>${diff}</small></div></div></li>`;
}

function companyBest(c, pred, allowZero) {
  let b = null;
  for (const p of productsAt(D.latest, (m, cs) => m.c === c && !m.seed && pred(m, cs))) {
    const pr = energyPrice(p.m, p.comps, allowZero);
    if (pr && (!b || pr.v < b.v)) b = pr;
  }
  return b;
}

function renderTop() {
  const cards = TOP_CARDS.map((c) => ({ ...c, rows: topList(cardPred(c), !!c.spot) }));
  const by = Object.fromEntries(cards.map((c) => [c.key, c]));

  // Tunnuslukulaatat
  const kpi = (key, label, withTrend) => {
    const c = by[key];
    const r = c.rows[0];
    if (!r) return `<div class="kpi"><div class="k">${label}</div><div class="v">–</div></div>`;
    const tr = withTrend ? trendFor(c) : [];
    const d = tr.length > 1 ? r.pr.v - tr[0] : null;
    const delta = d != null && Math.abs(d) >= 0.005 ? `<span class="pill-delta ${d > 0 ? 'up' : 'down'}" title="Muutos 30 päivässä">${d > 0 ? '▲' : '▼'}${fmt(Math.abs(d))}</span>` : '';
    return `<button class="kpi" data-topsel="${key}"><div class="k">${label}</div><div class="v">${fmt(r.pr.v)}<small>c/kWh</small></div>
      <div class="who">${esc(short(r.m.c))}${delta}</div>${sparkSvg(tr, css(d > 0 ? '--up' : '--down'))}</button>`;
  };
  const sp = spotToday();
  const hero = sp
    ? `<button class="kpi hero" data-goto="spot"><div class="k">Pörssisähkö nyt · klo ${hourOf(sp.t)}–${(hourOf(sp.t) + 1) % 24}${sp.est ? ' (ennuste)' : ''}</div>
        <div class="v">${fmt(sp.v)}<small>c/kWh</small></div>
        <div class="who">Päivän keskihinta ${fmt(sp.avg)} c · halvin klo ${hourOf(sp.cheap[0])} (${fmt(sp.cheap[1].v)} c)</div>${sparkSvg(sp.series, css('--hero-num'), true)}</button>`
    : '<div class="kpi hero"><div class="k">Pörssisähkö nyt</div><div class="v">–</div><div class="who">Hintatietoa ei saatu</div></div>';
  $('#kpis').innerHTML = hero + kpi('t12', 'Halvin 12 kk', true) + kpi('t24', 'Halvin 24 kk', true)
    + kpi('spot', 'Halvin marginaali', false) + kpi('t0', 'Halvin toistaiseksi', false);

  // Kampanjabanneri
  const act = activeCampaigns();
  const names = [...new Set(act.map((o) => short(o.company)))];
  const banner = $('#topCampaign');
  banner.className = names.length ? '' : 'hidden';
  if (names.length) {
    const kw = [...new Set(act.map((o) => o.keyword).filter(Boolean))][0] || 'Kampanja';
    const period = act.map((o) => o.period).find(Boolean);
    banner.innerHTML = `<button class="banner" data-goto="campaigns"><span class="tag">${esc(kw)}</span>
      <div><b>${names.map(esc).join(', ')}</b><span class="txt">${names.length === 1 ? 'Kampanja käynnissä' : `${names.length} yhtiöllä kampanja`}${period ? ` · ${esc(period)}` : ''}</span></div><span class="go">›</span></button>`;
  }

  // Suosikit
  const favs = [...FAV].filter((c) => D.ids.some((id) => D.metas[id].c === c));
  $('#favSection').classList.toggle('hidden', !favs.length);
  $('#favList').innerHTML = favs.sort((a, b) => short(a).localeCompare(short(b), 'fi')).map((c) => {
    const p12 = companyBest(c, cardPred(by.t12));
    const p24 = companyBest(c, cardPred(by.t24));
    const ps = companyBest(c, cardPred(by.spot), true);
    const cell = (l, p) => `<div><span>${l}</span><b>${p ? fmt(p.v) : '–'}</b></div>`;
    return `<div class="fav" role="button" tabindex="0" data-company="${esc(c)}"><div class="co">${esc(short(c))} ${starHtml(c)}</div>
      <div class="fav-prices">${cell('12 kk', p12)}${cell('24 kk', p24)}${cell('Marginaali', ps)}</div></div>`;
  }).join('');

  // Top 5 -kortit (mobiilissa yksi kerrallaan)
  $('#topSeg').innerHTML = cards.map((c) => `<button data-topsel="${c.key}" aria-pressed="${c.key === S.topSel}">${c.label}</button>`).join('');
  const segSel = $('#topSeg [aria-pressed="true"]');
  if (segSel) $('#topSeg').scrollLeft = segSel.offsetLeft - 24;
  $('#topGrid').innerHTML = cards.map((c) => {
    const best = c.rows[0]?.pr.v;
    return `<div class="top-card${c.key === S.topSel ? ' sel' : ''}" id="top-${c.key}">
      <div class="top-head"><h3>${c.title}</h3><span class="muted">${c.spot ? 'marginaali c/kWh' : 'c/kWh'}</span></div>
      ${c.rows.length ? `<ol class="top-list">${c.rows.map((r, k) => topRow(r, k, best)).join('')}</ol>` : '<p class="muted">Ei sopimuksia.</p>'}
      <button class="icon-btn top-more" data-goto="${c.spot ? 'spot' : 'fixed'}">Kaikki sopimukset →</button></div>`;
  }).join('');

  const d = new Date(Date.parse(D.snaps[D.latest].t));
  const day = d.toLocaleDateString('fi-FI', { weekday: 'long', day: 'numeric', month: 'numeric' });
  $('#topSub').textContent = `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${S.tg === 'Household' ? 'kotitaloudet · sis. alv 25,5 %' : 'yritykset · yleensä alv 0 %'}${S.national ? ' · vain koko Suomi' : ''}`;
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
    html += `<tr class="company-row" data-company="${esc(r.m.c)}"><td class="sticky-col"><strong>${esc(short(r.m.c))}</strong> ${starHtml(r.m.c)}</td><td class="name-cell">${esc(r.m.n)}</td><td class="num${isBest ? ' best' : ''}">${r.pr.txt}${deltaHtml(r.pr.v, pp?.v)}</td><td>${r.m.term === 0 ? 'Toistaiseksi' : `${r.m.term ?? '?'} kk`}</td><td>${MT_LABEL[r.m.mt] || ''}</td><td class="wrap-cell">${badges(r.m, r.comps)}</td><td>${linkHtml(r.m)}</td></tr>`;
  }
  if (!rows.length) html += '<tr><td colspan="7" class="muted">Ei sopimuksia.</td></tr>';
  $('#spotTable').innerHTML = html + '</tbody>';
  $('#spotCards').innerHTML = rows.map((r) => {
    const pp = r.prev ? energyPrice(r.m, r.prev, true) : null;
    return `<div class="mcard" role="button" tabindex="0" data-company="${esc(r.m.c)}"><div class="mcard-top"><div class="co">${esc(short(r.m.c))} ${starHtml(r.m.c)}</div>
      <div class="price">${r.pr.txt}${deltaHtml(r.pr.v, pp?.v)}</div></div><div class="prod">${esc(r.m.n)} · ${r.m.term === 0 ? 'toistaiseksi' : `${r.m.term ?? '?'} kk`}</div>
      <div class="tags-row">${badges(r.m, r.comps)}</div></div>`;
  }).join('') || '<p class="muted">Ei sopimuksia.</p>';

  const companies = new Set();
  for (let k = 0; k < D.snaps.length; k++) for (const c of spotAgg(k).keys()) companies.add(c);
  const series = [...companies].sort((a, b) => short(a).localeCompare(short(b), 'fi'))
    .map((c) => ({ key: c, group: short(c), label: null, get: (k) => spotAgg(k).get(c) || null }));
  renderHistory('spotHistory', {
    series,
    flat: true,
    defaultChart: favFirst,
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
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8, borderColor: css('--border'), fillerColor: css('--accent-soft'), textStyle: { color: text } }],
    series: [
      { name: 'Toteutunut', type: 'bar', data: realized, barWidth: '70%', itemStyle: { color: css('--accent'), borderRadius: [3, 3, 0, 0] } },
      { name: 'Ennuste', type: 'line', data: pred, showSymbol: false, lineStyle: { width: 2, color: css('--s1') }, itemStyle: { color: css('--s1') }, areaStyle: { color: css('--s1'), opacity: 0.1 } },
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
    html += `<tr class="company-row" data-company="${esc(r.m.c)}"><td class="sticky-col"><strong>${esc(short(r.m.c))}</strong> ${starHtml(r.m.c)}</td><td class="name-cell">${esc(r.m.n)}</td><td>${OTHER_LABEL[kind]}${r.m.mt !== 'General' ? ` <span class="muted">(${MT_LABEL[r.m.mt]})</span>` : ''}</td><td>${r.m.term === 0 ? 'Toistaiseksi' : `${r.m.term ?? '?'} kk`}</td><td>${compsText(r.m, r.comps)}${changed}</td><td class="wrap-cell">${badges(r.m, r.comps)}${r.m.info ? `<details class="info"><summary>Kuvaus</summary><p>${esc(r.m.info)}</p></details>` : ''}</td><td>${linkHtml(r.m)}</td></tr>`;
  }
  if (!rows.length) html += '<tr><td colspan="7" class="muted">Ei sopimuksia.</td></tr>';
  $('#otherTable').innerHTML = html + '</tbody>';
  $('#otherCards').innerHTML = rows.map((r) => `<div class="mcard" role="button" tabindex="0" data-company="${esc(r.m.c)}">
    <div class="co">${esc(short(r.m.c))} ${starHtml(r.m.c)}</div><div class="prod">${esc(r.m.n)} · ${OTHER_LABEL[otherKind(r.m, r.comps)]} · ${r.m.term === 0 ? 'toistaiseksi' : `${r.m.term ?? '?'} kk`}</div>
    <div class="prod" style="margin-top:6px">${compsText(r.m, r.comps)}</div><div class="tags-row">${badges(r.m, r.comps)}</div></div>`).join('') || '<p class="muted">Ei sopimuksia.</p>';

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
    defaultChart: favFirst,
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
  if (S.view === 'campaigns') renderCampaigns();
  if (S.view === 'fixed') renderFixed();
  if (S.view === 'spot') renderSpot();
  if (S.view === 'other') renderOther();
  if (S.sheet) renderSheet();
}

// ---------------------------------------------------------------------------
// Paneeli: yhtiön tiedot ja asetukset
// ---------------------------------------------------------------------------
function openSheet(state) {
  S.sheet = state;
  const el = $('#sheet');
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  renderSheet();
  $('#sheetBody').parentElement.scrollTop = 0;
}

function closeSheet() {
  const c = charts.sheetChart;
  if (c && !c.isDisposed()) c.dispose();
  delete charts.sheetChart;
  S.sheet = null;
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
}

function renderSheet() {
  if (!S.sheet) return;
  if (S.sheet.type === 'settings') renderSettingsSheet();
  else renderCompanySheet(S.sheet.company);
}

function renderCompanySheet(c) {
  const i = D.latest;
  const all = productsAt(i, (m) => m.c === c && !m.seed);
  const byTerm = (a, b) => (a.m.term ?? 99) - (b.m.term ?? 99);
  const fixed = all.filter((p) => category(p.m, p.comps) === 'fixed').sort(byTerm);
  const spot = all.filter((p) => p.m.pm === 'Spot');
  const other = all.filter((p) => category(p.m, p.comps) === 'other' && p.m.pm !== 'Spot').sort(byTerm);
  const row = (p, mode) => {
    const pr = energyPrice(p.m, p.comps, mode === 'spot');
    const pv = D.vals[p.id][i - 1];
    const pp = pv ? energyPrice(p.m, pv, mode === 'spot') : null;
    const meta = [p.m.term === 0 ? 'Toistaiseksi' : `${p.m.term ?? '?'} kk`, MT_LABEL[p.m.mt], mode === 'other' ? OTHER_LABEL[otherKind(p.m, p.comps)] : null].filter(Boolean).join(' · ');
    const name = p.m.link ? `<a href="${esc(p.m.link)}" target="_blank" rel="noopener">${esc(cleanName(p.m.n))}</a>` : esc(cleanName(p.m.n));
    const val = mode === 'other' ? `<div class="m" style="text-align:right">${compsText(p.m, p.comps)}</div>` : `<div class="price">${pr ? pr.txt : '–'}${deltaHtml(pr?.v, pp?.v)}</div>`;
    return `<div class="sheet-row"><div><div class="n">${name}</div><div class="m">${meta}${badges(p.m, p.comps)}</div></div>${val}</div>`;
  };
  const camp = activeCampaigns().filter((o) => o.company === c);
  const kws = [...new Set(camp.map((o) => o.keyword).filter(Boolean))];
  $('#sheetBody').innerHTML = `
    <h2 id="sheetTitle">${esc(short(c))} ${starHtml(c)}</h2>
    <p class="sub">${all.length} sopimusta · ${S.tg === 'Household' ? 'kotitaloudet, sis. alv' : 'yritykset'} · tilanne ${fmtSnap(D.snaps[i])}</p>
    ${camp.length ? `<button class="banner" data-goto="campaigns" style="margin:12px 0 4px"><span class="tag">${esc(kws[0] || 'Kampanja')}</span><div><b>Kampanja käynnissä</b><span class="txt">${esc(camp.map((o) => o.period).find(Boolean) || 'Katso kampanjat')}</span></div><span class="go">›</span></button>` : ''}
    <h3>Kiinteiden hintojen kehitys</h3>
    <div class="chart" id="sheetChart"></div>
    ${fixed.length ? `<h3>Kiinteät</h3><div class="sheet-list">${fixed.map((p) => row(p, 'fixed')).join('')}</div>` : ''}
    ${spot.length ? `<h3>Pörssisähkö (marginaali)</h3><div class="sheet-list">${spot.map((p) => row(p, 'spot')).join('')}</div>` : ''}
    ${other.length ? `<h3>Muut sopimukset</h3><div class="sheet-list">${other.map((p) => row(p, 'other')).join('')}</div>` : ''}
    <p class="hint">Hinnat c/kWh ilman kuukausimaksuja. Nuoli = muutos edelliseen keruuhetkeen.</p>`;

  // Yhtiön halvin kiinteä hinta kestoittain kaikilta keruuhetkiltä
  const terms = [12, 24, 0, 6, 36];
  const data = Object.fromEntries(terms.map((t) => [t, []]));
  for (let k = 0; k < D.snaps.length; k++) {
    const best = {};
    for (const p of productsAt(k, (m, cs) => m.c === c && m.mt === 'General' && category(m, cs) === 'fixed')) {
      const pr = energyPrice(p.m, p.comps);
      if (pr && terms.includes(p.m.term) && (best[p.m.term] == null || pr.v < best[p.m.term])) best[p.m.term] = pr.v;
    }
    for (const t of terms) data[t].push([Date.parse(D.snaps[k].t), best[t] ?? null]);
  }
  const used = terms.filter((t) => data[t].some((x) => x[1] != null));
  const el = $('#sheetChart');
  if (!window.echarts || !used.length) {
    el.outerHTML = '<p class="muted">Ei kiinteitä yleissähkösopimuksia.</p>';
    return;
  }
  const old = charts.sheetChart;
  if (old && !old.isDisposed()) old.dispose();
  const chart = echarts.init(el);
  charts.sheetChart = chart;
  const text = css('--text-2');
  chart.setOption({
    animation: false,
    grid: { left: 44, right: 12, top: used.length > 1 ? 36 : 16, bottom: 28 },
    legend: used.length > 1 ? { top: 0, textStyle: { color: text } } : { show: false },
    tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '–' : `${fmt(v)} c/kWh`) },
    xAxis: { type: 'time', axisLabel: { color: text, hideOverlap: true, formatter: { day: '{d}.{M}.', month: '{d}.{M}.', year: '{yyyy}', hour: '{HH}:{mm}' } }, axisLine: { lineStyle: { color: css('--border') } } },
    yAxis: { type: 'value', scale: true, axisLabel: { color: text, formatter: (v) => fmt(v) }, splitLine: { lineStyle: { color: css('--grid') } } },
    series: used.map((t) => {
      const color = css(`--s${terms.indexOf(t) + 1}`);
      return { name: TERM_LABEL(t), type: 'line', step: 'end', showSymbol: false, data: data[t], lineStyle: { width: 2, color }, itemStyle: { color } };
    }),
  });
}

function statusLong() {
  const s = D.snaps[D.latest];
  const now = helsinkiNow();
  const mins = now.h * 60 + now.m;
  const next = mins < 9 * 60 ? 'tänään klo 9' : mins < 17 * 60 ? 'tänään klo 17' : 'huomenna klo 9';
  const n = D.ids.filter((id) => D.vals[id][D.latest]).length;
  return `Päivitetty ${fmtSnap(s)} · ${n} sopimusta. Seuraava päivitys ${next} (voi myöhästyä).`;
}

function renderSettingsSheet() {
  const theme = document.documentElement.dataset.theme || 'dark';
  const pill = (attr, v, label, cur) => `<button data-${attr}="${v}" aria-pressed="${v === cur}">${label}</button>`;
  $('#sheetBody').innerHTML = `
    <h2 id="sheetTitle">Asetukset</h2>
    <div class="set-group"><b>Tiedot</b><p>${D ? statusLong() : 'Ladataan…'}</p></div>
    <div class="set-group"><b>Asiakasryhmä</b><div class="pills">${pill('tg', 'Household', 'Kotitaloudet', S.tg)}${pill('tg', 'Company', 'Yritykset (alv 0 %)', S.tg)}</div></div>
    <div class="set-group"><b>Teema</b><div class="pills">${pill('themeset', 'dark', 'Tumma', theme)}${pill('themeset', 'light', 'Vaalea', theme)}${pill('themeset', 'system', 'Laitteen mukaan', theme)}</div></div>
    <div class="set-group"><b>Tänään-näkymä</b><label class="chk"><input type="checkbox" id="setNational" ${S.national ? 'checked' : ''}> Piilota alueelliset ja toimitusvelvolliset sopimukset</label>
      <p>Niitä saa yleensä vain oman sähköverkkoalueen asukkaat.</p></div>
    <div class="set-group"><b>Suosikit</b><p>${FAV.size ? [...FAV].map((c) => esc(short(c))).join(', ') : 'Ei suosikkeja. Lisää yhtiö suosikiksi tähdellä ☆.'}</p></div>
    <div class="set-group"><b>Asenna sovellukseksi</b>${installPrompt ? '<button class="icon-btn" data-install>Asenna Sähkövahti</button>' : ''}
      <p>iPhone: avaa sivu Safarissa → Jaa → Lisää Koti-valikkoon. Android: Chromen valikko → Asenna sovellus.</p></div>`;
}

// ---------------------------------------------------------------------------
// Tapahtumat
// ---------------------------------------------------------------------------
function selectView(view) {
  S.view = view;
  document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  try { history.replaceState(null, '', `#${view}`); } catch { /* ignore */ }
  window.scrollTo(0, 0);
  render();
}

function setPressed(t) {
  t.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
}

document.addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) {
    e.stopPropagation();
    toggleFav(fav.dataset.fav);
    render();
    return;
  }
  if (e.target.closest('[data-close]')) { closeSheet(); return; }
  if (e.target.closest('[data-settings]')) { openSheet({ type: 'settings' }); return; }
  const comp = e.target.closest('[data-company]');
  if (comp && !e.target.closest('a')) { openSheet({ type: 'company', company: comp.dataset.company }); return; }

  const t = e.target.closest('button, th[data-sort]');
  if (!t) return;
  const ds = t.dataset;
  if (ds.goto) {
    if (S.sheet) closeSheet();
    selectView(ds.goto);
  } else if (ds.view) {
    selectView(ds.view);
  } else if (ds.topsel) {
    S.topSel = ds.topsel;
    render();
    const target = window.matchMedia('(max-width: 760px)').matches ? $('#topSeg') : document.getElementById(`top-${ds.topsel}`);
    if (t.classList.contains('kpi') && target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (ds.tg) {
    S.tg = ds.tg;
    savePref('tg', S.tg);
    setPressed(t);
    render();
  } else if (ds.themeset) {
    document.documentElement.dataset.theme = ds.themeset;
    try { localStorage.setItem('theme', ds.themeset); } catch { /* ignore */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.body).backgroundColor;
    render();
  } else if ('install' in ds) {
    if (installPrompt) installPrompt.prompt();
  } else if (ds.mt) {
    S.mt = ds.mt;
    setPressed(t);
    render();
  } else if (ds.src) {
    S.src = ds.src;
    setPressed(t);
    render();
  } else if (ds.ot) {
    S.otherType = ds.ot;
    setPressed(t);
    render();
  } else if (ds.sort) {
    const [view, col] = ds.sort.split(':');
    const st = S.sort[view];
    if (st.col === col) st.dir *= -1; else { st.col = col; st.dir = 1; }
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
  }
});

// Näppäimistö: Enter/välilyönti painikkeiksi merkityille elementeille, Esc sulkee paneelin
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.sheet) { closeSheet(); return; }
  const el = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute?.('role') === 'button' && el.tagName !== 'BUTTON') {
    e.preventDefault();
    el.click();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  const ds = t.dataset;
  if (t.id === 'setNational') {
    S.national = t.checked;
    savePref('national', S.national);
    render();
  } else if (ds.term != null) {
    const v = Number(ds.term);
    if (t.checked) S.fixedTerms.add(v); else S.fixedTerms.delete(v);
    render();
  } else if (ds.h) {
    const h = S.hist[ds.h];
    if ('daily' in ds) h.daily = t.checked;
    else if (ds.group != null) {
      if (!h.groups) h.groups = new Set([...t.closest('.groups').querySelectorAll('input[data-group]')].map((x) => x.dataset.group));
      if (t.checked) h.groups.add(ds.group); else h.groups.delete(ds.group);
    }
    render();
  }
});

// Paneelin sulkeminen vetämällä alas (mobiili)
(() => {
  let y0 = null;
  const panel = () => document.querySelector('.sheet-panel');
  document.addEventListener('touchstart', (e) => {
    const p = panel();
    if (S.sheet && p && p.contains(e.target) && p.scrollTop <= 0) y0 = e.touches[0].clientY; else y0 = null;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy > 0) panel().style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    const p = panel();
    p.style.transform = '';
    y0 = null;
    if (dy > 120) closeSheet();
  });
})();

['fixedSearch', 'spotSearch', 'otherSearch'].forEach((id) => document.getElementById(id).addEventListener('input', render));
window.addEventListener('resize', () => Object.values(charts).forEach((c) => !c.isDisposed() && c.resize()));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (S.sheet?.type === 'settings') renderSheet();
});

// ---------------------------------------------------------------------------
// Käynnistys
// ---------------------------------------------------------------------------
function updateStatusChip() {
  const s = D.snaps[D.latest];
  const [d, t] = s.t.split('T');
  const [, m, dd] = d.split('-').map(Number);
  const chip = $('#status');
  chip.querySelector('span').textContent = `${dd}.${m}. klo ${Number(t.slice(0, 2))}`;
  const age = (Date.now() - Date.parse(s.t)) / 3600000;
  chip.classList.toggle('stale', age > 16);
  chip.title = statusLong();
}

(async function init() {
  const hash = location.hash.slice(1);
  if (['top', 'fixed', 'spot', 'other', 'campaigns'].includes(hash)) selectView(hash);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    const [hist, fc, camp] = await Promise.all([
      fetch('data/history.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`history.json: HTTP ${r.status}`); return r.json(); }),
      fetch('data/forecast.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('data/campaigns.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    D = expand(hist);
    forecast = fc;
    campaigns = camp;
    updateCampaignCount();
    updateStatusChip();
    render();
    if (forecast) {
      await loadLiveRealized();
      if (S.view === 'spot') renderForecast();
      if (S.view === 'top') renderTop();
    }
  } catch (err) {
    const box = $('#loadError');
    box.classList.remove('hidden');
    box.textContent = `Datan lataus epäonnistui: ${err.message}. Aja ensin "npm run collect:now".`;
    $('#status span').textContent = 'Virhe';
  }
}());
