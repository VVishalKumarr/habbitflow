// HabbitFlow service worker: push notifications only. It doesn't cache or
// intercept page requests. Registered when someone turns on push in
// Settings → Notifications.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'HabbitFlow', body: event.data ? event.data.text() : '' }
  }
  const scope = self.registration.scope
  event.waitUntil(
    self.registration.showNotification(data.title || 'HabbitFlow', {
      body: data.body || '',
      icon: new URL('favicon.svg', scope).href,
      badge: new URL('favicon.svg', scope).href,
      tag: data.tag || undefined,
      data: { url: new URL(String(data.url || '/').replace(/^\//, ''), scope).href },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const same = wins.find((w) => w.url.startsWith(self.registration.scope))
      if (same) return same.focus().then((w) => (w && 'navigate' in w ? w.navigate(url) : undefined))
      return self.clients.openWindow(url)
    }),
  )
})
