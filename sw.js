const V = "sawt-v1";
const FILES = ["./", "index.html", "manifest.webmanifest", "assets/icon-192.png", "assets/icon-512.png", "css/style.css", "js/i18n.js", "js/lib.js", "js/app.js", "assets/logo.svg", "assets/empty.svg"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request).then(m => m || caches.match("index.html"))));
});
