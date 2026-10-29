// Nuôi Bahi: chạy được khi không có mạng; luôn ưu tiên bản mới nhất khi có mạng
const CACHE='bahi-v44';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icons/bahi-192-v3.png','./icons/bahi-512-v3.png','./icons/bahi-maskable-512-v3.png','./icons/bahi-apple-180-v3.png','./icons/bahi-fav-32-v3.png','./apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{const r=e.request;const u=new URL(r.url);if(r.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
  if(r.mode==='navigate'||r.url.endsWith('.html')){e.respondWith(fetch(r).then(res=>{const cp=res.clone();caches.open(CACHE).then(c=>c.put('./index.html',cp));return res;}).catch(()=>caches.match('./index.html')));return;}
  e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{const cp=res.clone();caches.open(CACHE).then(c=>c.put(r,cp));return res;})));});
