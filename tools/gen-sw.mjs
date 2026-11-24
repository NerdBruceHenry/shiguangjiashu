// 生成 sw.js：node tools/gen-sw.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const files = ['index.html', 'manifest.webmanifest', 'icon.svg', 'reader.template.html', 'css/style.css', ...readdirSync('js').map((f) => 'js/' + f)].sort();
const h = createHash('sha1');
files.forEach((f) => h.update(readFileSync(f, 'utf8').replace(/\r/g, '')));
const v = 'sgjs-' + h.digest('hex').slice(0, 10);
writeFileSync('sw.js', `// 由 tools/gen-sw.mjs 生成，请勿手改
const VERSION = '${v}';
const FILES = ${JSON.stringify(['./', ...files.map((f) => './' + f)], null, 2)};
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
`);
console.log(v, files.length);
