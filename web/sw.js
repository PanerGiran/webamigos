// Service worker mínimo: deja instalar la app y que abra sin conexión.
// Siempre va primero a la red (así nunca se sirve código viejo después de un deploy);
// la caché solo se usa si no hay internet. La API y las fotos nunca se guardan (son privadas).
const CACHE = 'amigos-v11';
const SHELL = ['/', '/css/app.css', '/css/looks.css', '/js/app.js', '/js/api.js', '/js/media.js', '/js/webm.js', '/js/theme.js', '/js/looks.js', '/icons.svg', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  // Las rutas de la app (/chat, /u/juli…) son todas la misma página.
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit ?? Response.error())),
  );
});

// --- Notificaciones push ---

self.addEventListener('push', (e) => {
  const d = e.data?.json() ?? {};
  e.waitUntil(
    self.registration.showNotification(d.title ?? 'Amigos', {
      body: d.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png', // ícono chiquito de la barra de Android (blanco sobre transparente)
      tag: d.tag,
      data: { url: d.url ?? '/' },
    }),
  );
});

// Al tocar el aviso: si la app ya está abierta, se enfoca y va a la pantalla; si no, se abre.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url ?? '/', location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).origin === location.origin);
      if (!win) return self.clients.openWindow(url);
      return win.focus().then((w) => w.navigate(url)).catch(() => self.clients.openWindow(url));
    }),
  );
});
