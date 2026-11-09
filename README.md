# Sähkösopimusseuranta

Verkkosivu, joka kerää klo 9.00 ja 17.00 kaikkien Energiaviraston hintavertailuun
(sahkonhinta.fi) ilmoitettujen sähkösopimusten hinnat ja näyttää ne sekä niiden historian.

**Näkymät**

- **Kiinteähintaiset** – yhtiöittäin halvin hinta: toistaiseksi voimassa, 6, 12, 24 ja 36 kk
  (yleis-, aika- tai kausisähkö). Historiataulukko + kaavio.
- **Pörssisähkö** – Sähkövatkaimen hintaennuste, kaikkien pörssisopimusten marginaalit ja marginaalihistoria.
- **Top 5** – viisi halvinta kussakin sopimustyypissä.
- **Kampanjat** – Black Friday, Black Week, Black Month, Cyber Monday, Singles’ Day ym. tarjoukset (ks. alla).
- **Muut sopimukset** – kulutusvaikutteiset/hybridit (Välkky, Duo, Vaikuttaja…), paketit ym. + historia.

Kuukausimaksuja ei huomioida missään. Kotitalouksien ja yritysten sopimukset erotellaan (yritysten hinnat yleensä alv 0 %).

## Tietolähteet

| Data | Lähde |
| --- | --- |
| Sopimukset ja hinnat | Energiaviraston hintavertailun rajapinta (`/api/productlist/<postinumero>`), haetaan 24 postinumerolla eri puolilta Suomea |
| Yhtiöiden omat sivut | Helen, Oomi, Hehku (12 & 24 kk), Cheap Energy, Väre, Vaasan Sähkö, Aalto, PKS (Optimi takuu 12 & 24 kk) – luetaan headless-selaimella, ks. `scripts/sites.mjs` |
| Pörssisähkön ennuste | `https://sahkovatkain.web.app/prediction.json` |
| Toteutuneet pörssihinnat | `https://sahkotin.fi/prices.csv` |

Mukana ovat vain yhtiöt, jotka ilmoittavat sopimuksensa Energiavirastolle (tällä hetkellä n. 34 yhtiötä, ~390 sopimusta).
Väre ei ilmoita sopimuksiaan palveluun (Väre myy nykyään Helenin sopimuksia), ja Aallolla ei ole siellä määräaikaisia – niiden hinnat tulevat yhtiöiden omilta sivuilta.

Yhtiöiden sivujen hinnat näkyvät omina sopimuksinaan (merkintä ”Yhtiön sivu”), ja Kiinteähintaiset-näkymän **Lähteiden vertailu** näyttää, täsmäävätkö ne Energiaviraston tietoihin. Jos yhtiö uudistaa sivunsa, sen lukija voi lakata toimimasta – tila näkyy vertailutaulukon alla (✓ / ✗). Yksittäisen sivun voi testata: `node scripts/sites.mjs vaasa`.

## Kampanjahaku (Black Friday ym.)

`scripts/campaigns.mjs` käy jokaisella keruukerralla läpi kaikkien Energiavirastolla mukana olevien yhtiöiden etusivut,
seurattavat sopimussivut ja niiltä löytyvät kampanjalinkit (headless-selaimella), sekä Energiaviraston sopimusten nimet ja kuvaukset.
Kampanjasanat (`KEYWORDS` tiedostossa) kattavat mm. Black Friday/Week/Weekend/Month/November, Musta perjantai, Cyber Monday/Week,
Singles’ Day ja Sinkkupäivä. Löydöt tallentuvat tiedostoon `site/data/campaigns.json` ensimmäisen ja viimeisimmän havainnon kanssa.

Testaus: `node scripts/campaigns.mjs`

## Käyttö paikallisesti

Vaatii Node.js 18+.

```bash
npm install && npx playwright install chromium   # kerran
npm run collect:now   # hae data heti
npm run serve         # http://localhost:8080
```

`npm run collect` tallentaa tilannekuvan vain, jos klo 9.00 tai 17.00 keruuhetki (Suomen aikaa) on ohitettu alle 4 h sitten eikä sitä ole vielä tallennettu.

## Julkaisu GitHub Pagesiin (automaattinen keruu klo 9 ja 17)

1. Luo GitHub-repo ja pushaa tämä kansio sen `main`-haaraan.
2. Repon asetuksista: **Settings → Pages → Source: GitHub Actions**.
3. Workflow `.github/workflows/collect.yml` ajaa keruun ajastetusti, commitoi datan ja julkaisee sivun.
   Voit ajaa sen myös käsin: **Actions → Kerää sähkösopimukset → Run workflow**.

GitHubin ajastukset voivat viivästyä jopa tunteja, joten workflow ajetaan tunnin välein ja skripti tallentaa klo 9 keruun viimeistään klo 16 ja klo 17 keruun viimeistään keskiyöllä. Sivu julkaistaan uudelleen vain, kun data muuttuu.

## Data

`site/data/history.json` sisältää kaikki tilannekuvat. Jokaisesta sopimuksesta tallennetaan vain muutokset,
joten tiedosto kasvaa hitaasti. `seed/taulukko.tsv` on aiemmin käsin kerätty taulukko, joka on tuotu historiaan
komennolla `npm run seed` (rivit merkitty sivulla tähdellä *).
