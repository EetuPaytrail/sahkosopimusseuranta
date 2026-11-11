// Etsii sähköyhtiöiden Black Friday / Black Week / Black Month ym. kampanjat
// yhtiöiden verkkosivuilta (Playwright), Energiaviraston sopimustiedoista,
// vertailu- ja tarjoussivustoilta sekä uutisista (Google News).
//
//   node scripts/campaigns.mjs           testaa: hae yhtiöt Energiavirastolta ja käy sivut läpi
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SITES } from './sites.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CAMPAIGNS = path.join(ROOT, 'site', 'data', 'campaigns.json');

// Kampanjasanat. Lisää tähän uusia tarvittaessa.
export const KEYWORDS = /black[\s-]*(friday|fri\b|week(end)?|month|november|days?|deals?|sale|viikko|kuu)|musta(n)?\s*perjantai\w*|cyber[\s-]*(monday|week|maanantai)|singles'?[\s-]*day|sinkkupäiv\w*/i;
const KEYWORDS_G = new RegExp(KEYWORDS.source, 'gi');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_LINKS_PER_SITE = 3;

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

function normalizeUrl(u) {
  if (!u) return null;
  let s = u.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  try {
    const url = new URL(s);
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}

// Ajetaan selaimessa: palauttaa kampanjasanan sisältävät tekstikohdat ja linkit.
function findInPage(src) {
  const re = new RegExp(src, 'i');
  const lines = document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
  const snippets = [];
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    // Lyhyt rivi (otsikko/valikko) -> otetaan mukaan seuraavat rivit
    let text = lines[i];
    let k = i + 1;
    for (; k < lines.length && text.length < 260 && k <= i + 3 && !re.test(lines[k]); k++) text += ` · ${lines[k]}`;
    snippets.push(text.slice(0, 400));
    i = k - 1; // ei päällekkäisiä otteita
  }
  const links = [...document.querySelectorAll('a[href]')]
    .filter((a) => re.test(a.textContent) || re.test(decodeURIComponent(a.getAttribute('href') || '').replace(/[-_/]/g, ' ')))
    .map((a) => ({ href: a.href, text: a.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) }))
    .filter((l) => /^https?:/.test(l.href));
  return { title: document.title, snippets, links };
}

function keywordOf(text) {
  const m = text.match(KEYWORDS);
  return m ? norm(m[0]).replace(/\b\w/g, (c) => c.toUpperCase()) : '';
}

// Poimii tekstistä hintamaininnat (c/kWh, €/kk, %)
function pricesOf(text) {
  return [...new Set((text.match(/-?\d{1,3}(?:[,.]\d{1,3})?\s*(?:snt|c|€|e)\s*\/\s*(?:kwh|kk)|-?\d{1,2}\s*%/gi) || []).map(norm))].slice(0, 6);
}

async function visit(ctx, url) {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const found = await page.evaluate(findInPage, KEYWORDS.source);
    return { status: res?.status() ?? 0, finalUrl: page.url(), ...found };
  } finally {
    await page.close();
  }
}

// companies: [{ company, url }]
export async function scanSites(companies, extraTargets = []) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: UA, locale: 'fi-FI', viewport: { width: 1280, height: 900 } });

  // Yhtiöiden etusivut + seurattavat sopimussivut
  const targets = new Map();
  for (const c of companies) {
    const u = normalizeUrl(c.url);
    if (u) targets.set(u, c.company);
  }
  // Aiemmin löydetyt kampanjasivut (esim. uutisen kautta) tarkistetaan jatkossakin
  for (const t of extraTargets) if (!targets.has(t.url)) targets.set(t.url, t.company);
  for (const s of SITES) {
    targets.set(s.url, s.company);
    for (const p of s.products || []) targets.set(p.url, s.company);
  }

  const hits = [];
  const pages = [];
  const seenLinks = new Set();
  const queue = [...targets.entries()];
  async function worker() {
    while (queue.length) {
      const [url, company] = queue.shift();
      try {
        const r = await visit(ctx, url);
        pages.push({ company, url, status: r.status });
        for (const sn of r.snippets) hits.push({ company, url: r.finalUrl, title: r.title, snippet: sn });
        // Kampanjasivuille johtavat linkit (vain saman yhtiön domainissa)
        const host = new URL(r.finalUrl).hostname.replace(/^www\./, '');
        const links = r.links.filter((l) => {
          try {
            return new URL(l.href).hostname.replace(/^www\./, '').endsWith(host) && !seenLinks.has(l.href);
          } catch {
            return false;
          }
        }).slice(0, MAX_LINKS_PER_SITE);
        for (const l of links) {
          seenLinks.add(l.href);
          try {
            const lr = await visit(ctx, l.href);
            pages.push({ company, url: l.href, status: lr.status });
            const sn = lr.snippets.length ? lr.snippets : [l.text];
            for (const s of sn) hits.push({ company, url: lr.finalUrl, title: lr.title, snippet: s });
          } catch (e) {
            pages.push({ company, url: l.href, status: 0, error: e.message.split('\n')[0] });
          }
        }
      } catch (e) {
        pages.push({ company, url, status: 0, error: e.message.split('\n')[0] });
      }
    }
  }
  try {
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    await browser.close();
  }
  return { hits, pages };
}

// ---------------------------------------------------------------------------
// Muut lähteet: vertailu- ja tarjoussivustot sekä uutiset
// ---------------------------------------------------------------------------
// Sivustot, jotka listaavat sähköyhtiöiden Black Friday -tarjouksia. Lisää tähän uusia.
export const EXTERNAL_SOURCES = [
  'https://vertaa-kilpailuttajat.fi/black-friday-sahkotarjous/',
  'https://parassahko.fi/black-friday-sahkotarjoukset',
  'https://sahkovertaaja.fi/black-friday-sahkosopimus/',
  'https://sahkovertailu.fi/black-friday-sahkosopimus',
  'https://sahkokuningas.fi/black-friday/',
  'https://xn--prssishknhinta-bib6zia.com/black-friday/',
  'https://xn--shksopimukset-bfb6y.com/black-friday-sahko/',
  'https://sahkon-hintavertailu.fi/black-friday-sahkosopimus/',
  'https://xn--shksopimuskilpailutus-51b03b.fi/black-friday-sahkotarjoukset/',
  'https://blackfridayy.fi/helen-black-friday/',
];
const NEWS_QUERIES = ['sähkö black friday', 'black friday sähkötarjous', 'sähkösopimus black week', 'sähkösopimus kampanja tarjous'];
const NEWS_MAX_AGE_DAYS = 60;
const NEWS_MAX_ITEMS = 12;

// Yleisiä lyhenteitä ja nimiä, joita vertailusivut käyttävät
const EXTRA_ALIASES = {
  PKS: 'Pohjois-Karjalan Sähkö Oy',
  Cheap: 'Cheap Energy Finland Oy',
  'Nordic Green': 'Nordic Green Energy',
  Väre: 'Väre Oy',
  Lumo: 'Lumo Energia',
  Hehku: 'Hehku Energia Oy',
};
const shortName = (c) => c.replace(/\s+(Oyj|Oy Ab|Oy|Ab|Ltd)$/i, '').replace(/\s+(Myynti|Markets|Finland)$/i, '').trim();
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function aliasTable(companies) {
  const map = new Map();
  for (const c of companies) map.set(shortName(c), c);
  for (const [a, c] of Object.entries(EXTRA_ALIASES)) {
    const full = companies.find((x) => shortName(x) === shortName(c)) || c;
    map.set(a, full);
  }
  // Pidemmät nimet ensin, ettei "Helen" peitä pidempää osumaa
  return [...map.entries()].sort((a, b) => b[0].length - a[0].length)
    .map(([alias, company]) => ({ company, re: new RegExp(`(^|[^a-zåäö])${escRe(alias)}[a-zåäö]{0,4}(?![a-zåäö])`, 'i') }));
}
const companiesIn = (text, aliases) => [...new Set(aliases.filter((a) => a.re.test(text)).map((a) => a.company))];

const OFFER_RE = /c\s*\/\s*kwh|snt|€|%|ilman kk|kk-maksu|perusmaksu|marginaali|kuukausimaksu/i;
// Hylkää otteet, jotka koskevat vain aiempia vuosia (vanhentuneet listaukset)
function isCurrent(text, year) {
  const years = (text.match(/\b20\d\d\b/g) || []).map(Number);
  return !years.length || years.includes(year) || years.some((y) => y > year);
}

function readPage() {
  return {
    title: document.title,
    lines: document.body.innerText.split('\n').map((s) => s.replace(/\t+/g, ' | ').replace(/\s+/g, ' ').trim()).filter(Boolean),
    updated: (document.body.innerText.match(/päivitetty[^\n]{0,30}?(\d{1,2}\.\d{1,2}\.\d{4})/i) || [])[1] || null,
  };
}

async function scanExternal(ctx, aliases) {
  const year = new Date().getFullYear();
  const hits = [];
  const pages = [];
  for (const url of EXTERNAL_SOURCES) {
    const page = await ctx.newPage();
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const r = await page.evaluate(readPage);
      const host = new URL(page.url()).hostname.replace(/^www\./, '');
      pages.push({ url, host, status: res?.status() ?? 0, updated: r.updated, title: r.title });
      for (const line of r.lines) {
        if (line.length < 12 || line.length > 600 || !OFFER_RE.test(line) || !isCurrent(line, year)) continue;
        for (const company of companiesIn(line, aliases)) {
          hits.push({ company, url: page.url(), host, title: r.title, snippet: line.slice(0, 350), updated: r.updated });
        }
      }
    } catch (e) {
      pages.push({ url, host: new URL(url).hostname, status: 0, error: e.message.split('\n')[0] });
    } finally {
      await page.close();
    }
  }
  return { hits, pages };
}

const xml = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

async function fetchNews() {
  const items = new Map();
  for (const q of NEWS_QUERIES) {
    try {
      const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=fi-FI&gl=FI&ceid=FI:fi`, { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
      const body = await res.text();
      for (const [, it] of body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const get = (t) => xml((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '');
        const date = new Date(get('pubDate'));
        if (!(Date.now() - date.getTime() < NEWS_MAX_AGE_DAYS * 86400000)) continue;
        const title = get('title');
        if (!KEYWORDS.test(title) && !/tarjou|kampanj/i.test(title)) continue;
        const sourceUrl = (it.match(/<source url="([^"]+)"/) || [])[1] || '';
        items.set(title, { title, link: get('link'), date: date.toISOString(), publisher: get('source'), sourceUrl });
      }
    } catch { /* uutishaku ei ole kriittinen */ }
  }
  return [...items.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, NEWS_MAX_ITEMS);
}

// Avaa uutislinkin (Google News ohjaa julkaisijan sivulle) ja palauttaa lopullisen osoitteen
async function resolveNews(ctx, link) {
  const page = await ctx.newPage();
  try {
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (/consent\.google/.test(page.url())) {
      // Evästekysely: valitaan "Hylkää kaikki" ja avataan linkki uudelleen
      await page.locator('button:visible', { hasText: /Hylkää kaikki|Reject all/ }).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await page.waitForURL((u) => !/google\.com/.test(u.hostname), { timeout: 15000 }).catch(() => {});
    return page.url();
  } catch {
    return link;
  } finally {
    await page.close();
  }
}

export async function scanOtherSources(companies, companyHosts) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: UA, locale: 'fi-FI', viewport: { width: 1280, height: 900 } });
  const aliases = aliasTable(companies);
  const siteHits = [];
  const pages = [];
  const news = [];
  try {
    const ext = await scanExternal(ctx, aliases);
    for (const n of await fetchNews()) {
      const url = await resolveNews(ctx, n.link);
      let host = '';
      try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
      const company = host && companyHosts.get(host);
      if (company) {
        // Uutislinkki vie yhtiön omalle sivulle -> luetaan kuin yhtiön kampanjasivu
        try {
          const r = await visit(ctx, url);
          pages.push({ company, url, status: r.status });
          for (const sn of r.snippets) siteHits.push({ company, url: r.finalUrl, title: r.title, snippet: sn });
        } catch (e) {
          pages.push({ company, url, status: 0, error: e.message.split('\n')[0] });
        }
      }
      news.push({ ...n, url: /google\.com/.test(host) || !host ? n.link : url, host, companies: companiesIn(n.title, aliases), own: !!company });
    }
    return { extHits: ext.hits, extPages: ext.pages, siteHits, pages, news };
  } finally {
    await browser.close();
  }
}

function stripHtml(html) {
  return norm((html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&[a-z]+;/g, ' '));
}

// Energiaviraston sopimukset, joiden nimessä tai kuvauksessa on kampanjasana
export function scanProducts(products) {
  const hits = [];
  for (const p of products) {
    const info = stripHtml(p.Details?.ExtraInformation?.FI);
    const text = `${p.Name} ${info}`;
    if (!KEYWORDS.test(text)) continue;
    const idx = info.search(KEYWORDS);
    const around = idx >= 0 ? info.slice(Math.max(0, idx - 120), idx + 280) : '';
    const energy = p.Details.Pricing.PriceComponents
      .filter((c) => c.PriceComponentType !== 'Monthly' && c.OriginalPayment.PaymentUnit === 'CentPerKiwattHour')
      .map((c) => `${String(c.OriginalPayment.Price).replace('.', ',')} c/kWh`);
    hits.push({
      company: p.Company.Name.trim(),
      url: p.Details.ProductLink || p.Company.CompanyUrl || '',
      title: p.Name.trim(),
      snippet: norm(`${p.Name} · ${around}`).slice(0, 400),
      source: 'api',
      prices: energy,
      contract: p.Details.PricingModel === 'Spot' ? 'Pörssisähkö' : p.Details.ContractType === 'FixedTerm' ? 'Määräaikainen' : 'Toistaiseksi voimassa',
    });
  }
  return hits;
}

// Kampanja-aika, esim. "alkaa 2.11.2026 ja kestää 30.11.2026" tai "voimassa 10.–30.11.2026"
function periodOf(text) {
  const d = String.raw`\d{1,2}\.\d{1,2}\.(?:\d{4})?`;
  const s = String.raw`\d{1,2}\.(?:\d{1,2}\.)?(?:\d{4})?`; // alku voi olla pelkkä päivä: 10.–30.11.
  const m = text.match(new RegExp(`(?:alkaa|voimassa|ajalla|välillä)\\s+(${s})\\s*(?:ja kestää|–|-|—)\\s*(${d})`, 'i'))
    || text.match(new RegExp(`(${s})\\s*[–—-]\\s*(${d})`));
  return m ? `${m[1]}–${m[2]}` : null;
}

// Otteiden järjestys: hinnat / tarjous / kampanja-aika ensin, UKK-kysymykset viimeiseksi
function rankSnippet(s) {
  let score = 0;
  if (pricesOf(s).length) score += 4;
  if (/\d{1,2}\.\d{1,2}\.(\d{4})?/.test(s)) score += 2;
  if (/tarjou|kampanja|0\s*€|ilmai|alennu|hinta/i.test(s)) score += 2;
  if (/\?/.test(s.split(' · ')[0])) score -= 3;
  return score;
}

// Yhdistää uudet löydöt aiempaan historiaan (firstSeen / lastSeen).
// Yksi löytö = yhtiön yksi sivu (tai Energiaviraston sopimus).
export function mergeCampaigns(prev, { siteHits, apiHits, pages, runAt, extHits = [], extPages = [], news = [] }) {
  const offers = new Map((prev.offers || []).map((o) => [o.id, o]));
  const grouped = new Map();
  for (const h of [...apiHits, ...siteHits.map((x) => ({ ...x, source: 'site' })), ...extHits.map((x) => ({ ...x, source: 'external' }))]) {
    const page = h.source === 'api' ? h.title : h.url.split('#')[0].replace(/\/$/, '');
    const id = hash(`${h.company}|${h.source}|${page}`);
    if (!grouped.has(id)) grouped.set(id, { ...h, id, snippets: [] });
    const g = grouped.get(id);
    const sn = norm(h.snippet);
    if (!g.snippets.some((x) => x.includes(sn) || sn.includes(x))) g.snippets.push(sn);
  }
  for (const g of grouped.values()) {
    const cur = offers.get(g.id);
    const snippets = g.snippets.map((s, i) => [s, rankSnippet(s), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map((x) => x[0]).slice(0, 6);
    const all = snippets.join(' ');
    offers.set(g.id, {
      id: g.id,
      company: g.company,
      source: g.source,
      keyword: keywordOf(`${g.title} ${all}`) || keywordOf(g.url.replace(/[-_/]/g, ' ')),
      title: g.title,
      snippets,
      url: g.url,
      prices: g.prices?.length ? g.prices : pricesOf(all),
      period: periodOf(all),
      contract: g.contract || null,
      host: g.host || null,
      updated: g.updated || null,
      firstSeen: cur?.firstSeen || runAt,
      lastSeen: runAt,
    });
  }
  const checked = [...new Set(pages.filter((p) => !p.error && p.status < 400).map((p) => p.company))];
  const prevNews = new Map((prev.news || []).map((n) => [n.id, n]));
  const newsOut = news.map((n) => {
    const id = hash(n.title);
    return { id, ...n, firstSeen: prevNews.get(id)?.firstSeen || runAt, lastSeen: runAt };
  });
  return {
    updatedAt: runAt,
    keywords: KEYWORDS.source,
    checkedPages: pages.length,
    failedPages: pages.filter((p) => p.error || p.status >= 400).map((p) => ({ company: p.company, url: p.url, error: p.error || `HTTP ${p.status}` })),
    checkedCompanies: checked.sort(),
    externalSources: extPages.map((p) => ({ host: p.host, url: p.url, ok: !p.error && p.status < 400, updated: p.updated || null })),
    news: newsOut,
    offers: [...offers.values()].sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '') || a.company.localeCompare(b.company, 'fi')),
  };
}

export async function collectCampaigns(products, runAt) {
  const companies = [...new Map(products.map((p) => [p.Company.Name.trim(), p.Company.CompanyUrl])).entries()]
    .map(([company, url]) => ({ company, url }));
  const apiHits = scanProducts(products);
  const prev = fs.existsSync(CAMPAIGNS) ? JSON.parse(fs.readFileSync(CAMPAIGNS, 'utf8')) : {};
  const recent = (prev.offers || []).filter((o) => o.source === 'site' && Date.now() - Date.parse(o.lastSeen) < 21 * 86400000)
    .map((o) => ({ url: o.url, company: o.company }));
  const { hits: siteHits, pages } = await scanSites(companies, recent);
  const companyHosts = new Map();
  for (const c of companies) {
    try { companyHosts.set(new URL(normalizeUrl(c.url)).hostname.replace(/^www\./, ''), c.company); } catch { /* ignore */ }
  }
  let other = { extHits: [], extPages: [], siteHits: [], pages: [], news: [] };
  try {
    other = await scanOtherSources(companies.map((c) => c.company), companyHosts);
  } catch (e) {
    console.warn('Muiden lähteiden haku epäonnistui:', e.message);
  }
  const out = mergeCampaigns(prev, {
    siteHits: [...siteHits, ...other.siteHits], apiHits, pages: [...pages, ...other.pages], runAt,
    extHits: other.extHits, extPages: other.extPages, news: other.news,
  });
  fs.writeFileSync(CAMPAIGNS, JSON.stringify(out));
  const active = out.offers.filter((o) => o.lastSeen === runAt);
  console.log(`Kampanjat: ${out.checkedPages} yhtiösivua, ${out.checkedCompanies.length} yhtiötä, ${active.filter((o) => o.source !== 'external').length} löytöä yhtiöiltä, ${active.filter((o) => o.source === 'external').length} muista lähteistä (${out.externalSources.filter((x) => x.ok).length}/${EXTERNAL_SOURCES.length} sivustoa), ${out.news.length} uutista`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const list = await fetch('https://ev-shv-prod-app-wa-consumerapi1.azurewebsites.net/api/productlist/00100').then((r) => r.json());
  const out = await collectCampaigns(list, new Date().toISOString());
  for (const o of out.offers.filter((x) => x.lastSeen === out.updatedAt)) {
    console.log(`- [${o.source}${o.host ? ` ${o.host}` : ''}] ${o.company} | ${o.keyword} | ${o.period || ''} | ${o.prices.join(', ')} | ${o.url}\n    ${o.snippets[0].slice(0, 200)}`);
  }
  for (const n of out.news) console.log(`  uutinen ${n.date.slice(0, 10)} ${n.own ? '(yhtiön sivu) ' : ''}${n.title} → ${n.host}`);
  if (out.failedPages.length) console.log('Epäonnistuneet sivut:', out.failedPages.map((p) => `${p.company} (${p.error})`).join('; '));
}
