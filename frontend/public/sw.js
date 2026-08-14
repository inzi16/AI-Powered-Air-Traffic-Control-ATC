/* Smart ATC deliberately caches only its local application shell and hashed
 * build assets. Simulation APIs, mutations, WebSockets, and third-party map
 * tiles always go directly to the network and are never queued. */
const CACHE_PREFIX = 'smart-atc-shell-';
const LEGACY_CACHE_PREFIX = 'skycommand-shell-';
// Vite replaces these two development-safe placeholders in the production copy.
const BUILD_VERSION = 'dev';
const BUILD_ASSET_MANIFEST = [];
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_VERSION}`;
const SHELL_RESOURCES = [
  '/manifest.webmanifest',
  '/favicon.svg',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/fonts/instrument-sans-variable.woff2',
  '/fonts/jetbrains-mono-variable.woff2',
];
const MAX_RUNTIME_ASSETS = 80;

async function precacheBuiltShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexResponse = await fetch('/index.html', { cache: 'no-cache' });
  if (!indexResponse.ok) throw new Error(`Unable to precache Smart ATC shell (${indexResponse.status}).`);
  const markup = await indexResponse.clone().text();
  const discoveredAssets = [...markup.matchAll(/(?:src|href)=["']([^"']+)["']/gi)]
    .map((match) => new URL(match[1], self.location.origin))
    .filter((url) => url.origin === self.location.origin && isHashedBuildAsset(url))
    .map((url) => url.pathname + url.search);
  const manifestAssets = BUILD_ASSET_MANIFEST.map((entry) => entry.url);
  const shellUrls = [...new Set([...SHELL_RESOURCES, ...manifestAssets, ...discoveredAssets])]
    .filter((url) => url !== '/' && url !== '/index.html');
  const assetResponses = await Promise.all(shellUrls.map(async (url) => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok || response.type !== 'basic') throw new Error(`Unable to precache build asset ${url}.`);
    return [url, response];
  }));

  await Promise.all(assetResponses.map(([url, response]) => cache.put(url, response)));
  await cache.put('/index.html', indexResponse.clone());
  await cache.put('/', indexResponse);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheBuiltShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) || key.startsWith(LEGACY_CACHE_PREFIX))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function isApiRequest(url) {
  return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

function isHashedBuildAsset(url) {
  return url.pathname.includes('/assets/') && /-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(url.pathname);
}

async function trimRuntimeCache(cache) {
  const keys = await cache.keys();
  const runtimeKeys = keys.filter((request) => new URL(request.url).pathname.includes('/assets/'));
  await Promise.all(runtimeKeys.slice(0, Math.max(0, runtimeKeys.length - MAX_RUNTIME_ASSETS)).map((request) => cache.delete(request)));
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
    await trimRuntimeCache(cache);
  }
  return response;
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put('/index.html', response.clone());
    return response;
  } catch {
    return (await cache.match(request))
      || (await cache.match('/index.html'))
      || new Response('Smart ATC is offline and its local shell is unavailable.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Non-GET requests are never intercepted, persisted, or replayed.
  if (request.method !== 'GET') return;
  // Cross-origin assets (including map tiles), APIs, and upgrade traffic remain network-only.
  if (url.origin !== self.location.origin || isApiRequest(url) || request.headers.get('upgrade') === 'websocket') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (isHashedBuildAsset(url)) event.respondWith(cacheFirstAsset(request));
});
