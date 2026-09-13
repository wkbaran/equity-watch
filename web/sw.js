// Service worker: exists only so notifications work where the page can't
// construct them directly (Android Chrome), and so clicking one brings the
// dashboard tab forward instead of doing nothing. It caches nothing.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((w) => w.url.startsWith(self.registration.scope));
      return existing ? existing.focus() : self.clients.openWindow(self.registration.scope);
    })
  );
});
