// Etsii sähköyhtiöiden Black Friday / Black Week / Black Month ym. kampanjat
// yhtiöiden verkkosivuilta (Playwright) ja Energiaviraston sopimustiedoista.
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
export async function scanSites(companies) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: UA, locale: 'fi-FI', viewport: { width: 1280, height: 900 } });

  // Yhtiöiden etusivut + seurattavat sopimussivut
  const targets = new Map();
  for (const c of companies) {
    const u = normalizeUrl(c.url);
    if (u) targets.set(u, c.company);
  }
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
export function mergeCampaigns(prev, { siteHits, apiHits, pages, runAt }) {
  const offers = new Map((prev.offers || []).map((o) => [o.id, o]));
  const grouped = new Map();
  for (const h of [...apiHits, ...siteHits.map((x) => ({ ...x, source: 'site' }))]) {
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
      firstSeen: cur?.firstSeen || runAt,
      lastSeen: runAt,
    });
  }
  const checked = [...new Set(pages.filter((p) => !p.error && p.status < 400).map((p) => p.company))];
  return {
    updatedAt: runAt,
    keywords: KEYWORDS.source,
    checkedPages: pages.length,
    failedPages: pages.filter((p) => p.error || p.status >= 400).map((p) => ({ company: p.company, url: p.url, error: p.error || `HTTP ${p.status}` })),
    checkedCompanies: checked.sort(),
    offers: [...offers.values()].sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '') || a.company.localeCompare(b.company, 'fi')),
  };
}

export async function collectCampaigns(products, runAt) {
  const companies = [...new Map(products.map((p) => [p.Company.Name.trim(), p.Company.CompanyUrl])).entries()]
    .map(([company, url]) => ({ company, url }));
  const apiHits = scanProducts(products);
  const { hits: siteHits, pages } = await scanSites(companies);
  const prev = fs.existsSync(CAMPAIGNS) ? JSON.parse(fs.readFileSync(CAMPAIGNS, 'utf8')) : {};
  const out = mergeCampaigns(prev, { siteHits, apiHits, pages, runAt });
  fs.writeFileSync(CAMPAIGNS, JSON.stringify(out));
  const active = out.offers.filter((o) => o.lastSeen === runAt);
  console.log(`Kampanjat: ${pages.length} sivua, ${out.checkedCompanies.length} yhtiötä, ${active.length} aktiivista löytöä`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const list = await fetch('https://ev-shv-prod-app-wa-consumerapi1.azurewebsites.net/api/productlist/00100').then((r) => r.json());
  const out = await collectCampaigns(list, new Date().toISOString());
  for (const o of out.offers.filter((x) => x.lastSeen === out.updatedAt)) {
    console.log(`- [${o.source}] ${o.company} | ${o.keyword} | ${o.period || ''} | ${o.prices.join(', ')} | ${o.url}\n    ${o.snippets[0].slice(0, 200)}`);
  }
  if (out.failedPages.length) console.log('Epäonnistuneet sivut:', out.failedPages.map((p) => `${p.company} (${p.error})`).join('; '));
}
