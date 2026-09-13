// Service worker: exists only so notifications work where the page can't
// construct them directly (Android Chrome), and so clicking one brings the
// dashboard forward on that trigger's details instead of doing nothing.
// It caches nothing.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.hash ?? "", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((w) => w.url.startsWith(self.registration.scope));
      if (!existing) {
        return self.clients.openWindow(target);
      }
      return existing.focus().then((client) => ("navigate" in client ? client.navigate(target) : client));
    })
  );
});
