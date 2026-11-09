// Sähkövahti service worker: sovelluksen kuori välimuistiin, data verkosta (varalla välimuisti)
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const DATA = 'data';
const SHELL_FILES = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw new Error('offline');
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Hintadata ja oma sovellus: verkosta ensin, jotta tiedot ovat aina tuoreita
  if (url.origin === location.origin) {
    e.respondWith(networkFirst(req, url.pathname.includes('/data/') ? DATA : SHELL));
    return;
  }
  // Kirjastot ja fontit (CDN): välimuistista, jos löytyy
  if (/cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.host)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(req, copy));
      return res;
    })));
  }
});
