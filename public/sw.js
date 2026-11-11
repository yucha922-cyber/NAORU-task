// NAORU TASK サービスワーカー: 通知とアプリアイコンのバッジだけを扱う。
// ページやデータのキャッシュは一切しない（常に最新版を表示するため。fetch ハンドラなし）。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { title: 'NAORU TASK', body: event.data ? event.data.text() : '' } }
  const title = data.title || 'NAORU TASK'
  const tasks = []
  tasks.push(self.registration.showNotification(title, {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    tag: data.tag || 'naoru-daily',
    data: { url: data.url || './' },
  }))
  if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
    tasks.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge())
  }
  event.waitUntil(Promise.all(tasks).catch(() => {}))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) { if (c.url.startsWith(self.registration.scope)) { await c.focus(); return } }
    await self.clients.openWindow(url)
  })())
})
