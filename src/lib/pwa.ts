/**
 * ホーム画面アプリ（PWA）: サービスワーカー・アイコンのバッジ・通知の購読。
 * サービスワーカーは通知とバッジ専用で、キャッシュはしない（public/sw.js）。
 */
const BASE = import.meta.env.BASE_URL

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
/** ホーム画面から起動しているか（iPhone は、ホーム画面に追加したアプリでのみ通知を使える） */
export const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null
  try { return await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }) } catch { return null }
}

/** アプリアイコンのバッジ（対応している端末のみ。iPhone は通知の許可が必要） */
export function setBadge(count: number) {
  const n = navigator as Navigator & { setAppBadge?: (c: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
  if (!n.setAppBadge) return
  ;(count > 0 ? n.setAppBadge(count) : n.clearAppBadge!()).catch(() => {})
}

const toKey = (b64: string) => {
  const p = b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0))
}

export async function currentSubscription() {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration(BASE)
  return (await reg?.pushManager.getSubscription()) ?? null
}

/** 通知を許可してもらい、この端末を購読（ボタン押下から呼ぶこと） */
export async function subscribePush(publicKey: string) {
  if (!pushSupported()) throw new Error('この端末・ブラウザは通知に対応していません。')
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('通知が許可されませんでした。端末の設定で、NAORU TASK の通知を許可してください。')
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.ready)
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }))
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  return { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }
}

export async function unsubscribePush() {
  const sub = await currentSubscription()
  const endpoint = sub?.endpoint ?? null
  await sub?.unsubscribe().catch(() => {})
  return endpoint
}
