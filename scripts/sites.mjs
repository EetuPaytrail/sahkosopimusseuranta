// Kiinteähintaisten sopimusten hinnat suoraan sähköyhtiöiden omilta sivuilta.
// Sivut renderöidään Playwrightilla (headless Chromium), koska useimmat lataavat
// hinnat JavaScriptillä. Palauttaa [{ site, company, term, price, name, url }].
//
//   node scripts/sites.mjs         testaa kaikki sivut ja tulosta hinnat

import { pathToFileURL } from 'node:url';

export const SITES = [
  { id: 'helen', company: 'Helen Oy', url: 'https://www.helen.fi/sahko/sahkosopimus/maaraaikainen-perussahko' },
  { id: 'oomi', company: 'Oomi Oy', url: 'https://oomi.fi/sahko/sahkosopimukset/kiintea/' },
  { id: 'hehku12', company: 'Hehku Energia Oy', url: 'https://hehkuenergia.fi/sahkosopimukset/maaraaikainen/12kk/', terms: [12] },
  { id: 'hehku24', company: 'Hehku Energia Oy', url: 'https://hehkuenergia.fi/sahkosopimukset/maaraaikainen/24kk/', terms: [24] },
  { id: 'cheap', company: 'Cheap Energy Finland Oy', url: 'https://www.cheapenergy.fi/sahkosopimus/maaraaikainen/' },
  // Väre myy nykyään Helenin sopimuksia; "Määräaikainen Sähkö B" -sivu on poistunut.
  { id: 'vare', company: 'Väre Oy', url: 'https://vare.fi/sahkosopimus/', fallbackUrls: ['https://vare.fi/sahkosopimus/maaraaikainen-sahko-b/'] },
  { id: 'vaasa', company: 'Vaasan Sähkö Myynti Oy', url: 'https://www.vaasansahko.fi/sahkosopimus/kiintea/?measurement-type=yleissahko', mode: 'tabs' },
  { id: 'aalto', company: 'Aalto energia Oyj', url: 'https://aaltoenergia.com/sahkosopimukset/maaraaikaiset/' },
  // PKS näyttää hinnan vasta tilaussivulla; seurataan Optimi takuu 12 ja 24 kk.
  {
    id: 'pks', company: 'Pohjois-Karjalan Sähkö Oy', url: 'https://www.pks.fi/sahkosopimus-kotiin#sopimukset', mode: 'pks',
    products: [
      { term: 12, url: 'https://www.pks.fi/sahkosopimus-kotiin/optimi-takuu-12-kk' },
      { term: 24, url: 'https://www.pks.fi/sahkosopimus-kotiin/optimi-takuu-sahkosopimus' },
    ],
  },
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Ajetaan selaimessa: etsii tekstistä "x,xx snt/kWh" -hinnat ja niitä lähinnä edeltävän keston.
function extractInPage() {
  const lines = document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
  const SKIP = /spot|pörssi|käyttövaikutus|omavaikutus|kulutusvaikutus|lisäpalvelu|alennu|jousto|välkky|duo|ekoenergia|fossiilivapaa|välityspalkkio/i;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const joined = `${lines[i]} ${lines[i + 1] || ''}`;
    const m = joined.match(/^(?:energia(?:maksu)?\s*)?(\d{1,2},\d{1,3})\s*(snt|c|¢)\s*\/\s*kwh/i);
    if (!m) continue;
    const ctx = lines.slice(Math.max(0, i - 1), i + 3).join(' ');
    if (SKIP.test(ctx)) continue;
    let term = null;
    let name = '';
    for (let k = i - 1; k >= Math.max(0, i - 8) && term == null; k--) {
      const l = lines[k];
      let t = l.match(/(\d{1,2})\s*(kk|kuukau)/i);
      if (t) { term = Number(t[1]); name = l; break; }
      t = l.match(/(\d)\s*vuode/i);
      if (t) { term = Number(t[1]) * 12; name = l; break; }
      if (/toistaiseksi/i.test(l)) { term = 0; name = l; }
    }
    out.push({ price: Number(m[1].replace(',', '.')), term, name: name.slice(0, 80) });
  }
  return out;
}

async function openPage(ctx, url) {
  const page = await ctx.newPage();
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return { page, status: res?.status() ?? 0 };
}

function best(found, terms) {
  const byTerm = new Map();
  for (const f of found) {
    if (f.term == null || !(f.price > 0)) continue;
    if (terms && !terms.includes(f.term)) continue;
    if (f.term === 0) continue; // vain määräaikaiset
    const cur = byTerm.get(f.term);
    if (!cur || f.price < cur.price) byTerm.set(f.term, f);
  }
  return [...byTerm.values()];
}

async function scrapeGeneric(ctx, site) {
  for (const url of [site.url, ...(site.fallbackUrls || [])]) {
    const { page, status } = await openPage(ctx, url);
    try {
      if (status >= 400) continue;
      const found = best(await page.evaluate(extractInPage), site.terms);
      if (found.length) return found.map((f) => ({ ...f, url }));
    } finally {
      await page.close();
    }
  }
  return [];
}

// Vaasan Sähkö: kestot ovat välilehtinä, joten jokainen klikataan erikseen.
async function scrapeTabs(ctx, site) {
  const { page } = await openPage(ctx, site.url);
  const out = [];
  try {
    const labels = await page.$$eval('button[aria-selected]', (bs) => bs.map((b) => b.textContent.trim()).filter((t) => /^\d+\s*kk$/.test(t)));
    for (const label of [...new Set(labels)]) {
      const btn = page.locator('button[aria-selected]', { hasText: new RegExp(`^\\s*${label}\\s*$`) }).first();
      await btn.click();
      await page.waitForTimeout(700);
      const text = await btn.evaluate((b) => {
        let el = b;
        for (let i = 0; i < 6 && el.parentElement; i++) {
          el = el.parentElement;
          if (/c\/kWh/.test(el.innerText)) break;
        }
        return el.innerText.replace(/\n+/g, ' ');
      });
      const m = text.match(/(\d{1,2},\d{1,3})\s*c\/kWh/);
      if (m) out.push({ term: Number(label.match(/\d+/)[0]), price: Number(m[1].replace(',', '.')), name: `Kiinteä ${label}`, url: site.url });
    }
  } finally {
    await page.close();
  }
  return out;
}

// PKS: tuotesivulta "Tilaa"-linkki tilaussivulle, jossa energiamaksu näkyy.
async function scrapePks(ctx, site) {
  const out = [];
  for (const p of site.products) {
    const { page } = await openPage(ctx, p.url);
    try {
      const order = await page.$$eval('a[href*="sopimus.pks.fi"]', (as) => as.map((a) => a.href).find((h) => h.includes('productIdentifier')));
      if (!order) continue;
      await page.goto(order, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForFunction(() => /snt\/kWh/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
      const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
      const m = text.match(/Energiamaksu yksiaika\s*(\d{1,2},\d{1,3})\s*snt\/kWh/i);
      const name = text.match(/Optimi takuu \d+\s*kk/i)?.[0] || `Optimi takuu ${p.term} kk`;
      if (m) out.push({ term: p.term, price: Number(m[1].replace(',', '.')), name, url: p.url });
    } finally {
      await page.close();
    }
  }
  return out;
}

export async function scrapeSites({ only } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.warn('Playwright puuttuu (npm install && npx playwright install chromium) – yhtiöiden sivuja ei luettu');
    return { results: [], status: {} };
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: UA, locale: 'fi-FI', viewport: { width: 1280, height: 900 } });
  const results = [];
  const status = {};
  try {
    for (const site of SITES.filter((s) => !only || only.includes(s.id))) {
      try {
        const fn = site.mode === 'tabs' ? scrapeTabs : site.mode === 'pks' ? scrapePks : scrapeGeneric;
        const rows = await fn(ctx, site);
        for (const r of rows) results.push({ site: site.id, company: site.company, ...r });
        status[site.id] = rows.length ? `ok (${rows.map((r) => `${r.term} kk ${r.price}`).join(', ')})` : 'ei hintoja';
      } catch (e) {
        status[site.id] = `virhe: ${e.message.split('\n')[0]}`;
      }
      console.log(`  ${site.id}: ${status[site.id]}`);
    }
  } finally {
    await browser.close();
  }
  return { results, status };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = process.argv.slice(2);
  const { results } = await scrapeSites({ only: only.length ? only : undefined });
  console.table(results.map(({ site, term, price, name }) => ({ site, term, price, name })));
}
