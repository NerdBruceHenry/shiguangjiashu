// 由 tools/gen-sw.mjs 生成，请勿手改
const VERSION = 'sgjs-db77436243';
const FILES = [
  "./",
  "./css/style.css",
  "./icon.svg",
  "./index.html",
  "./js/app.js",
  "./js/backup.js",
  "./js/crypto.js",
  "./js/dates.js",
  "./js/github.js",
  "./js/media.js",
  "./js/prompts.js",
  "./js/reader.js",
  "./js/store.js",
  "./manifest.webmanifest",
  "./reader.template.html"
];
self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
// 同一域名下还有别的工具，只清理自己的旧缓存
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('sgjs-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
// 网络优先，离线用缓存
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(async () => {
    const c = await caches.open(VERSION);
    return (await c.match(e.request)) || (e.request.mode === 'navigate' && (await c.match('./index.html'))) || Response.error();
  }));
});
