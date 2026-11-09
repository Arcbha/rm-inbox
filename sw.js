// RM Inbox service worker: only here so Android can install the page and list it in the Share menu.
// It caches nothing — every request goes straight to the network, so the page is never stale.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
