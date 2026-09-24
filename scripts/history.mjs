// Historiatiedoston luku, purku ja pakkaus.
//
// site/data/history.json:
// {
//   version: 1,
//   snapshots: [{ t: "2026-09-24T09:00", at: "<ISO>", src: "api" | "seed" }],
//   products: { <id>: { m: <meta>, h: [[snapshotIndex, comps | null], ...] } }
// }
// h sisältää vain muutokset: arvo on voimassa seuraavaan merkintään asti.
// null = tuote ei ollut saatavilla kyseisellä hetkellä.
import fs from 'node:fs';

export function load(path) {
  if (!fs.existsSync(path)) return { version: 1, snapshots: [], products: {} };
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

export function save(path, history) {
  fs.writeFileSync(path, JSON.stringify(history));
}

// Palauttaa { snapshots, metas, states } missä states[i] = { id: comps }
export function expand(history) {
  const S = history.snapshots.length;
  const states = Array.from({ length: S }, () => ({}));
  const metas = {};
  for (const [id, p] of Object.entries(history.products)) {
    metas[id] = p.m;
    let k = 0;
    let cur = null;
    for (let i = 0; i < S; i++) {
      while (k < p.h.length && p.h[k][0] <= i) cur = p.h[k++][1];
      if (cur) states[i][id] = cur;
    }
  }
  return { snapshots: history.snapshots.slice(), metas, states };
}

export function compress({ snapshots, metas, states }) {
  const products = {};
  for (const [id, m] of Object.entries(metas)) {
    const h = [];
    let last = 'null';
    for (let i = 0; i < snapshots.length; i++) {
      const v = states[i][id] || null;
      const key = JSON.stringify(v);
      if (key !== last) {
        h.push([i, v]);
        last = key;
      }
    }
    if (h.some(([, v]) => v)) products[id] = { m, h };
  }
  return { version: 1, snapshots, products };
}
