import { useEffect, useState } from 'react'
import { repo } from '../lib/client'
import { ServerUnavailableError } from '../lib/repo'
import { currentSubscription, isIOS, isStandalone, pushSupported, subscribePush, unsubscribePush } from '../lib/pwa'

/** 設定画面「通知」: 毎朝8時に期限が近いタスクを通知＋ホーム画面アイコンのバッジ */
export function NotificationPanel() {
  const [state, setState] = useState<'loading' | 'unavailable' | 'needs-home' | 'unsupported' | 'off' | 'on'>('loading')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    (async () => {
      if (repo.mode === 'demo') return setState('unavailable')
      if (isIOS() && !isStandalone()) return setState('needs-home')
      if (!pushSupported()) return setState('unsupported')
      const sub = await currentSubscription()
      setState(sub && Notification.permission === 'granted' ? 'on' : 'off')
    })().catch(() => setState('unsupported'))
  }, [])

  const act = (fn: () => Promise<void>) => async () => {
    setBusy(true); setMsg(null)
    try { await fn() } catch (e) {
      setMsg({ tone: 'err', text: e instanceof ServerUnavailableError ? '通知のサーバーが準備できていません。管理者に連絡してください。' : (e as Error).message })
    } finally { setBusy(false) }
  }

  const turnOn = act(async () => {
    const { publicKey } = await repo.googleServer('push-key') as { publicKey: string }
    const sub = await subscribePush(publicKey)
    await repo.savePushSubscription(sub)
    setState('on')
    await repo.googleServer('push-test')
    setMsg({ tone: 'ok', text: '通知をオンにしました。確認のための通知を送りました。' })
  })
  const test = act(async () => {
    await repo.googleServer('push-test')
    setMsg({ tone: 'ok', text: 'テスト通知を送りました。数秒で届きます。' })
  })
  const turnOff = act(async () => {
    const endpoint = await unsubscribePush()
    if (endpoint) await repo.deletePushSubscription(endpoint)
    setState('off')
    setMsg({ tone: 'ok', text: 'この端末の通知をオフにしました。' })
  })

  return (
    <section>
      <h2 className="section-title">通知・バッジ</h2>
      <div className="card space-y-3 p-4 text-sm">
        <p className="text-xs leading-relaxed text-neutral-600">
          毎朝8時に、<b>期限超過・今日・明日</b>の自分が担当のタスク（全員・選んだメンバーのタスクを含み、未割当は含まない）をお知らせします。該当がない日は通知しません。ホーム画面のアイコンにも件数のバッジが付きます。
        </p>
        {state === 'loading' && <p className="text-xs text-neutral-400">確認中…</p>}
        {state === 'unavailable' && <p className="text-xs text-neutral-500">デモモードでは通知を使えません。</p>}
        {state === 'unsupported' && <p className="text-xs text-neutral-500">この端末・ブラウザは通知に対応していません。iPhone は Safari、Android は Chrome でホーム画面に追加してお使いください。</p>}
        {state === 'needs-home' && (
          <div className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
            iPhone では、<b>ホーム画面に追加したアプリ</b>から開くと通知をオンにできます。<br />
            Safari の共有ボタン（□↑）→「ホーム画面に追加」→ 追加したアイコンから開き、この画面でもう一度操作してください。
          </div>
        )}
        {state === 'off' && <button className="btn-primary w-full" disabled={busy} onClick={turnOn}>{busy ? '設定中…' : '通知をオンにする'}</button>}
        {state === 'on' && (
          <>
            <div className="flex items-center justify-between">
              <span className="chip bg-emerald-50 text-emerald-700">この端末で通知オン</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-ghost" disabled={busy} onClick={test}>テスト通知</button>
              <button className="btn-ghost" disabled={busy} onClick={turnOff}>この端末でオフ</button>
            </div>
          </>
        )}
        {msg && <p className={`rounded-xl p-3 text-xs leading-relaxed ${msg.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
        <p className="text-[11px] leading-relaxed text-neutral-400">※ 通知は端末ごとの設定です。スマホとPCの両方で受け取る場合は、それぞれでオンにしてください。</p>
      </div>
    </section>
  )
}
