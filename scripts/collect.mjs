// Kerää sähkösopimukset Energiaviraston hintavertailusta (sahkonhinta.fi)
// ja pörssisähkön hintaennusteen Sähkövatkaimesta (sahkovatkain.web.app).
//
//   node scripts/collect.mjs           tallentaa klo 09:00 / 17:00 -tilannekuvan, jos se puuttuu
//   node scripts/collect.mjs --force   tallentaa tilannekuvan nykyhetkellä
//   node scripts/collect.mjs --forecast-only
//   node scripts/collect.mjs --no-sites      ohita yhtiöiden omat sivut (scripts/sites.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, save, expand, compress } from './history.mjs';
import { scrapeSites } from './sites.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'site', 'data');
const HISTORY = path.join(DATA, 'history.json');
const FORECAST = path.join(DATA, 'forecast.json');

const API = 'https://ev-shv-prod-app-wa-consumerapi1.azurewebsites.net/api/productlist/';
// Postinumeroita eri puolilta Suomea, jotta myös alueelliset tuotteet löytyvät.
const POSTAL_CODES = [
  '00100', '02100', '04200', '06100', '08100', '13100', '15100', '20100', '24100', '28100', '33100',
  '40100', '45100', '50100', '53100', '57100', '60100', '65100', '67100', '70100', '80100', '87100',
  '90100', '96100',
];
const SLOTS = ['09:00', '17:00'];
const MAX_LATE_HOURS = 4;

const args = new Set(process.argv.slice(2));

function helsinkiParts(date) {
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// Viimeisin ohitettu keruuhetki Helsingin aikaa, tai null jos myöhästytty liikaa.
function currentSlot(now) {
  for (let back = 0; back <= MAX_LATE_HOURS * 60; back += 1) {
    const { date, time } = helsinkiParts(new Date(now.getTime() - back * 60000));
    if (SLOTS.includes(time)) return `${date}T${time}`;
  }
  return null;
}

async function fetchRetry(url, { tries = 3, as = 'json' } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'sahkosopimusseuranta/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return as === 'json' ? await res.json() : await res.text();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw err;
}

const TERM = { Fixed6: 6, Fixed12: 12, Fixed24: 24 };

function termMonths(p) {
  const d = p.Details;
  if (d.ContractType !== 'FixedTerm') return 0; // toistaiseksi voimassa
  if (TERM[d.FixedTimeRange]) return TERM[d.FixedTimeRange];
  const m = p.Name.match(/(\d+)\s*(kk|kuukau|mån)/i);
  if (m) return Number(m[1]);
  return d.FixedTimeRange === 'Over24' ? 36 : null;
}

function stripHtml(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&aring;/g, 'å')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&amp;/g, '&').replace(/&euro;/g, '€')
    .replace(/&[a-z]+;/g, ' ').replace(/\r/g, '').replace(/\n\s*\n+/g, '\n').trim();
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

// Energiahinnan komponentit (c/kWh). Kuukausimaksut jätetään pois.
function components(p) {
  return p.Details.Pricing.PriceComponents
    .filter((c) => c.PriceComponentType !== 'Monthly' && c.OriginalPayment.PaymentUnit === 'CentPerKiwattHour')
    .map((c) => {
      const out = [c.PriceComponentType, round(c.OriginalPayment.Price)];
      if (c.HasDiscount && c.Discount.DiscountType !== 'NoDiscount') {
        const d = c.Discount;
        const val = d.IsPercentage ? `${d.DiscountValue} %` : `${d.DiscountValue} c/kWh`;
        if (d.DiscountType === 'NFirstKwh') out.push(`alennus ${val} ensimmäiset ${d.NFirstKwh} kWh`);
        else if (d.DiscountType === 'NFirstMonth') out.push(`alennus ${val} ensimmäiset ${d.NfirstMonths} kk`);
        else out.push(`alennus ${val}`);
      }
      return out;
    });
}

function meta(p) {
  const d = p.Details;
  const t = d.TransparencyIndex || {};
  return {
    c: p.Company.Name.trim(),
    n: p.Name.trim(),
    pm: d.PricingModel, // FixedPrice | Spot | Hybrid
    ct: d.ContractType, // FixedTerm | OpenEnded
    term: termMonths(p),
    mt: d.Metering, // General | Time | Season
    tg: d.TargetGroup, // Household | Company | Both
    nat: !!d.AvailabilityArea?.IsNational,
    dr: !!d.DeliveryResponsibilityProduct,
    newOnly: !!t.IsOnlyForNewCustomers,
    custom: !!d.HasCustomPricingElement,
    link: d.ProductLink || p.Company.CompanyUrl || '',
    info: stripHtml(d.ExtraInformation?.FI).slice(0, 700),
  };
}

async function fetchProducts() {
  const all = new Map();
  let ok = 0;
  const queue = POSTAL_CODES.slice();
  async function worker() {
    while (queue.length) {
      const pc = queue.shift();
      try {
        const list = await fetchRetry(API + pc);
        for (const p of list) all.set(p.Id, p);
        ok++;
      } catch (e) {
        console.warn(`Postinumero ${pc} epäonnistui: ${e.message}`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (ok < POSTAL_CODES.length / 2) throw new Error(`Liian moni haku epäonnistui (${ok}/${POSTAL_CODES.length})`);
  console.log(`Haettu ${all.size} tuotetta ${ok}/${POSTAL_CODES.length} postinumerolla`);
  return [...all.values()];
}

function siteMeta(r) {
  return {
    c: r.company, n: `${r.name || `${r.term} kk`} (yhtiön sivu)`, pm: 'FixedPrice', ct: 'FixedTerm', term: r.term,
    mt: 'General', tg: 'Household', nat: true, dr: false, newOnly: false, custom: false,
    link: r.url, info: 'Luettu yhtiön omalta verkkosivulta.', src: 'site',
  };
}

async function collectContracts(slot) {
  const [products, sites] = await Promise.all([
    fetchProducts(),
    args.has('--no-sites') ? { results: [], status: {} } : scrapeSites().catch((e) => {
      console.warn('Yhtiöiden sivujen luku epäonnistui:', e.message);
      return { results: [], status: {} };
    }),
  ]);
  const ex = expand(load(HISTORY));
  const state = {};
  for (const p of products) {
    ex.metas[p.Id] = meta(p);
    state[p.Id] = components(p);
  }
  for (const r of sites.results) {
    const id = `site:${r.company}:${r.term}`;
    ex.metas[id] = siteMeta(r);
    state[id] = [['General', round(r.price)]];
  }
  ex.snapshots.push({ t: slot, at: new Date().toISOString(), src: 'api', sites: sites.status });
  ex.states.push(state);
  save(HISTORY, compress(ex));
  console.log(`Tallennettu tilannekuva ${slot}`);
}

async function collectForecast() {
  const now = Date.now();
  const start = new Date(now - 2 * 86400000).toISOString();
  const end = new Date(now + 3 * 86400000).toISOString();
  const [prediction, csv] = await Promise.all([
    fetchRetry('https://sahkovatkain.web.app/prediction.json'),
    fetchRetry(`https://sahkotin.fi/prices.csv?fix=true&vat=true&start=${start}&end=${end}`, { as: 'text' }).catch(() => ''),
  ]);
  const realized = csv.split('\n').slice(1).map((l) => {
    const [t, v] = l.split(',');
    return [Date.parse(t), Number(v)];
  }).filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  fs.writeFileSync(FORECAST, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    prediction: prediction.map(([t, v]) => [t, v == null ? null : round(v)]),
    realized,
  }));
  console.log(`Ennuste päivitetty (${prediction.length} tuntia)`);
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  let failed = false;

  try {
    await collectForecast();
  } catch (e) {
    failed = true;
    console.error('Ennusteen haku epäonnistui:', e.message);
  }

  if (!args.has('--forecast-only')) {
    const now = new Date();
    const hp = helsinkiParts(now);
    const slot = args.has('--force') ? `${hp.date}T${hp.time}` : currentSlot(now);
    const done = new Set(load(HISTORY).snapshots.map((s) => s.t));
    if (!slot) console.log(`Ei keruuhetkeä nyt (${hp.date} ${hp.time} Helsinki)`);
    else if (done.has(slot)) console.log(`Tilannekuva ${slot} on jo tallennettu`);
    else {
      try {
        await collectContracts(slot);
      } catch (e) {
        failed = true;
        console.error('Sopimusten haku epäonnistui:', e.message);
      }
    }
  }
  if (failed) process.exitCode = 1;
}

main();
