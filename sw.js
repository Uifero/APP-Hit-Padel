// Service worker do Hit Padel: cuida só do "app shell" (HTML/JS/ícones) pra abrir mais rápido e
// ainda funcionar (mostrando a última versão vista) sem sinal na quadra. NUNCA intercepta domínio
// externo (Firebase, Google Fonts, YouTube, API de QR) — dados ao vivo e serviços de terceiros
// continuam saindo direto da rede, sem passar pelo cache.
const CACHE_NAME = 'hitpadel-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './scheduling.js',
  './firebase-config.js',
  './manifest.json',
  './logo.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

// Network-first: sempre tenta buscar a versão mais nova primeiro; só cai pro cache (última versão
// salva) quando a rede falha de verdade (offline). Assim ninguém fica preso numa versão velha do
// app só porque o service worker está ativo — o cache é rede de segurança, não a fonte principal.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // nunca intercepta domínio externo

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
  );
});
