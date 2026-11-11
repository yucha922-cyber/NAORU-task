/// <reference types="node" />
/** Web Push 暗号化・VAPID 署名の検証（独立した実装 http_ece で復号して確かめる） */
import { createECDH, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 型定義なし
import ece from 'http_ece'
import { b64url, encryptPayload, generateVapidKeys, sendPush, unb64url, vapidHeader } from './webpush'

const device = () => {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
  const auth = randomBytes(16)
  return { ecdh, p256dh: b64url(new Uint8Array(ecdh.getPublicKey())), auth: b64url(new Uint8Array(auth)) }
}

describe('Web Push 暗号化（RFC 8291）', () => {
  it('端末側の鍵で正しく復号できる（http_ece で検証）', async () => {
    const d = device()
    const msg = JSON.stringify({ title: '今日・明日のタスク', body: '今日 2件・明日 1件', badge: 3 })
    const body = await encryptPayload(new TextEncoder().encode(msg), d.p256dh, d.auth)
    const plain = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: d.ecdh, authSecret: d.auth })
    expect(plain.toString('utf8')).toBe(msg)
  })
  it('別の端末の鍵では復号できない', async () => {
    const a = device(), b = device()
    const body = await encryptPayload(new TextEncoder().encode('secret'), a.p256dh, a.auth)
    expect(() => ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: b.ecdh, authSecret: b.auth })).toThrow()
  })
})

describe('VAPID 署名（RFC 8292）', () => {
  it('JWT の署名を公開鍵で検証でき、宛先・期限・送信者が正しい', async () => {
    const keys = await generateVapidKeys()
    const h = await vapidHeader('https://web.push.apple.com/abc', keys, 'https://yucha922-cyber.github.io/NAORU-task/', 1_000_000)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!
    const pub = await crypto.subtle.importKey('raw', unb64url(m[4]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`))
    expect(ok).toBe(true)
    const payload = JSON.parse(new TextDecoder().decode(unb64url(m[2])))
    expect(payload).toEqual({ aud: 'https://web.push.apple.com', exp: 1_000_000 + 43200, sub: 'https://yucha922-cyber.github.io/NAORU-task/' })
  })
})

describe('送信', () => {
  it('必要なヘッダーで送信し、410 は「無効な購読」と判定', async () => {
    const keys = await generateVapidKeys(); const d = device()
    let seen: RequestInit | undefined
    const ok = await sendPush({ endpoint: 'https://fcm.googleapis.com/x', p256dh: d.p256dh, auth: d.auth, user_id: 'u' }, { title: 't' }, keys, 'https://a/',
      (async (_u: unknown, init?: RequestInit) => { seen = init; return new Response(null, { status: 201 }) }) as typeof fetch)
    expect(ok).toBe('ok')
    const h = seen!.headers as Record<string, string>
    expect(h['Content-Encoding']).toBe('aes128gcm'); expect(h.TTL).toBeTruthy(); expect(h.Authorization).toMatch(/^vapid t=/)
    const gone = await sendPush({ endpoint: 'https://fcm.googleapis.com/x', p256dh: d.p256dh, auth: d.auth, user_id: 'u' }, {}, keys, 'https://a/',
      (async () => new Response(null, { status: 410 })) as typeof fetch)
    expect(gone).toBe('gone')
  })
})
