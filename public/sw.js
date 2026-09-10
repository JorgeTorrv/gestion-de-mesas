const CACHE = 'seatmap-v6';
const ASSET_VER = '6';
const SHELL = [
  './index.html',
  './styles.css?v=' + ASSET_VER,
  './app.js?v=' + ASSET_VER,
  './manifest.json',
  './icon.svg',
  './icon-dark.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // {cache:'reload'} bypasses the browser HTTP cache so a new SW always
      // pulls fresh assets even within the max-age window.
      .then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache API or SSE traffic
  if (url.pathname.startsWith('/api/')) return;
  if (url.origin !== location.origin) return;

  // Navegacion (HTML): red primero, cache como fallback
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(resp => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Assets (CSS, JS, SVG, etc): cache primero, red como fallback
  // Si no esta en cache y la red falla, dejamos que el navegador maneje el error
  // (NO caer a index.html para evitar que CSS se reemplace con HTML)
  e.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return resp;
      });
    })
  );
});
