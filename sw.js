// Service Worker for Staff Attendance Tracker PWA
// Network-first strategy: always fetch fresh content when online, fall back to cache when offline
const CACHE_VERSION = '1.0.8';
const CACHE_NAME = `attendance-tracker-v${CACHE_VERSION}`;
const ASSETS_TO_CACHE = [
  './index.html',
  './src/styles.css',
  './app.js',
  './src/attendanceCalculator.js',
  './src/pdfExporter.js',
  './src/ocrExtractor.js',
  './src/sampleData.js',
  './manifest.json'
];

self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (evt) => {
  if (evt.request.method !== 'GET') return;
  evt.respondWith(
    fetch(evt.request)
      .then((networkRes) => {
        const resClone = networkRes.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(evt.request, resClone);
        });
        return networkRes;
      })
      .catch(() => {
        return caches.match(evt.request);
      })
  );
});
