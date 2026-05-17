// Oomycota Service Worker 
// caches music for offline playback

const CACHE_NAME = 'oomycota';

const PRECACHE_URLS = [
  './',
  'index.html',
  'icon.png',
  'tracks.json',
  'style.css',
  'app.js',
  'fonts/outfit-latin.woff2',
  'fonts/outfit-latin-ext.woff2'
];

const CACHEABLE_EXTENSIONS = ['.mp3', '.jpg', '.jpeg', '.png', '.webp', '.html', '.css', '.js', '.woff2'];

function isCacheable(pathname) {
  return pathname === '/' || CACHEABLE_EXTENSIONS.some(ext => pathname.endsWith(ext));
}

function isJSON(pathname) {
  return pathname.endsWith('.json');
}

function isSameOriginGET(request) {
  return request.method === 'GET' && new URL(request.url).origin === location.origin;
}

// --- Strategies ---

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch {
    return caches.match(request);
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && isCacheable(new URL(request.url).pathname)) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// --- Lifecycle ---

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// --- Fetch routing ---

self.addEventListener('fetch', event => {
  if (!isSameOriginGET(event.request)) return;

  const { pathname } = new URL(event.request.url);

  // JSON gets network-first so track list updates propagate quickly
  // Everything else (HTML, MP3s, images) gets cache-first
  event.respondWith(
    isJSON(pathname) ? networkFirst(event.request) : cacheFirst(event.request)
  );
});