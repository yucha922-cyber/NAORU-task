/**
 * Web Push 送信（無料。各ブラウザのプッシュサービスに直接送る）。Deno / Node 共通（WebCrypto のみ使用）。
 * - 暗号化: RFC 8291（aes128gcm）
 * - 送信元の証明: VAPID（RFC 8292, ES256 署名の JWT）
 */
const enc = new TextEncoder()
const utf8 = (t: string) => new Uint8Array(enc.encode(t)) as Uint8Array<ArrayBuffer>

export function b64url(u: Uint8Array) {
  return btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0))
}
const concat = (...a: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of a) { out.set(x, o); o += x.length }
  return out
}

export interface VapidKeys { publicKey: string; privateJwk: JsonWebKey }

/** VAPID の鍵ペアを生成（公開鍵は 65バイトの非圧縮形式を base64url） */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  return { publicKey: b64url(raw), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) }
}

/** VAPID 認証ヘッダー（Authorization: vapid t=JWT, k=公開鍵） */
export async function vapidHeader(endpoint: string, keys: VapidKeys, subject: string, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64url(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })))
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${header}.${payload}`)))
  return `vapid t=${header}.${payload}.${b64url(sig)}, k=${keys.publicKey}`
}

type Bytes = Uint8Array<ArrayBuffer>
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8))
}

/** RFC 8291: 受信端末の公開鍵（p256dh）と認証用秘密（auth）で本文を暗号化 */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = unb64url(p256dh)
  const authSecret = unb64url(auth)
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey))
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256))
  const ikm = await hkdf(authSecret, shared, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))))
  const rs = new Uint8Array([0, 0, 16, 0]) // レコードサイズ 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct)
}

export interface PushSubscriptionRow { endpoint: string; p256dh: string; auth: string; user_id: string }

/** 1件送信。戻り値: 'ok' / 'gone'（購読が無効＝削除すべき）/ 'error' */
export async function sendPush(sub: PushSubscriptionRow, payload: unknown, keys: VapidKeys, subject: string, fetchFn: typeof fetch = fetch): Promise<'ok' | 'gone' | 'error'> {
  const body = await encryptPayload(utf8(JSON.stringify(payload)), sub.p256dh, sub.auth)
  const r = await fetchFn(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(12 * 3600),
      Urgency: 'normal',
    },
    body,
  }).catch(() => null)
  if (!r) return 'error'
  if (r.status === 404 || r.status === 410) return 'gone'
  return r.ok ? 'ok' : 'error'
}
