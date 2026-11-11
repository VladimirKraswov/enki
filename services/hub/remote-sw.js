/* Enki Remote PWA: cache only the static shell. Never cache chats, commands,
 * snapshots, Hub administration or microphone/ASR requests. */
'use strict';
const CACHE = 'enki-remote-shell-v1';
const SHELL = ['/remote', '/remote.html', '/remote.css', '/remote.js', '/remote.webmanifest', '/remote-icon-192.png', '/remote-icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('enki-remote-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/downloads/')) return;
  const shellRequest = SHELL.includes(url.pathname);
  const remoteNavigation = request.mode === 'navigate' && (url.pathname === '/remote' || url.pathname === '/remote.html');
  if (!shellRequest && !remoteNavigation) return;
  // Network-first keeps the owner on the current Hub version; the cache is only
  // an offline shell, never an alternative authority for session state.
  event.respondWith(fetch(request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (remoteNavigation) return caches.match('/remote.html');
    return Response.error();
  }));
});
