const serviceWorkerVersion = new URL(self.location.href).searchParams.get('v') ?? 'dev';
// Bump when cached assets or preview images must be dropped for all clients.
const CACHE_EPOCH = 'og-preview-dark-1';
const VERSION = `v-${serviceWorkerVersion}-${CACHE_EPOCH}`;
const STATIC_CACHE = `finra-static-${VERSION}`;
const RUNTIME_CACHE = `finra-runtime-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE_URLS = [
	'/',
	OFFLINE_URL,
	'/manifest.webmanifest',
	'/favicon.ico',
	'/favicon-32x32.png',
	'/favicon-16x16.png',
	'/icon-192.png',
	'/icon-512.png',
	'/icon-512-maskable.png',
	'/apple-touch-icon.png',
	'/og-preview.png',
];

async function deleteAllCaches() {
	const keys = await caches.keys();
	await Promise.all(keys.map((key) => caches.delete(key)));
}

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			// Drop every prior cache (including the old light OG screenshot) before precache.
			await deleteAllCaches();
			try {
				const cache = await caches.open(STATIC_CACHE);
				await cache.addAll(PRECACHE_URLS);
			} catch {
				/* precache is best-effort */
			}
		})(),
	);
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(keys.filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE).map((key) => caches.delete(key)));
			await self.clients.claim();
		})(),
	);
});

self.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') {
		self.skipWaiting();
		return;
	}
	if (event.data?.type === 'CLEAR_CACHES') {
		event.waitUntil(
			(async () => {
				await deleteAllCaches();
				try {
					const cache = await caches.open(STATIC_CACHE);
					await cache.addAll(PRECACHE_URLS);
				} catch {
					/* ignore */
				}
				if (event.source && 'postMessage' in event.source) {
					event.source.postMessage({ type: 'CACHES_CLEARED' });
				}
			})(),
		);
	}
});

self.addEventListener('fetch', (event) => {
	const { request } = event;

	if (request.method !== 'GET') {
		return;
	}

	const url = new URL(request.url);

	if (url.origin !== self.location.origin) {
		return;
	}

	if (url.pathname.startsWith('/api/')) {
		return;
	}

	if (request.mode === 'navigate') {
		event.respondWith(networkFirstPage(request));
		return;
	}

	if (url.pathname.startsWith('/_next/static/') || ['style', 'script', 'worker', 'font', 'image'].includes(request.destination)) {
		event.respondWith(staleWhileRevalidate(request));
	}
});

async function networkFirstPage(request) {
	try {
		const response = await fetch(request);
		const cache = await caches.open(RUNTIME_CACHE);
		cache.put(request, response.clone());
		return response;
	} catch {
		const cachedPage = await caches.match(request);
		if (cachedPage) {
			return cachedPage;
		}

		return caches.match(OFFLINE_URL);
	}
}

async function staleWhileRevalidate(request) {
	const cache = await caches.open(RUNTIME_CACHE);
	const cached = await cache.match(request);
	const networkPromise = fetch(request)
		.then((response) => {
			cache.put(request, response.clone());
			return response;
		})
		.catch(() => cached);

	return cached || networkPromise;
}
