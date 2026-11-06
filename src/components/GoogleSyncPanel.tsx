import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useCalendarSync } from '../lib/calendarManager'

const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')

/** 管理設定の「Googleカレンダー連携」。全スタッフが自分のGoogleアカウントを連携する */
export function GoogleSyncPanel() {
  const g = useCalendarSync()
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<void>) => async () => { setBusy(true); try { await fn() } finally { setBusy(false) } }

  if (!g.configured) {
    return (
      <section>
        <h2 className="section-title">Googleカレンダー連携</h2>
        <div className="card p-4 text-sm leading-relaxed text-neutral-500">管理者がGoogle連携の初期設定を行うと利用できます（docs/SETUP.md の手順3）。</div>
      </section>
    )
  }

  const state = !g.linked ? { label: '未連携', cls: 'bg-neutral-100 text-neutral-600' }
    : g.account?.status === 'reauth_required' ? { label: '再接続が必要', cls: 'bg-orange-50 text-orange-600' }
      : g.connected ? { label: '接続中', cls: 'bg-emerald-50 text-emerald-700' }
        : { label: '連携済み（待機中）', cls: 'bg-neutral-100 text-neutral-600' }

  return (
    <section>
      <h2 className="section-title">Googleカレンダー連携</h2>
      <div className="card space-y-4 p-4 text-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium">{g.account?.google_email ?? '自分のGoogleカレンダーに反映'}</div>
            <div className="text-[11px] text-neutral-400">自分が担当のタスクだけを、専用の「NAORU TASK」カレンダーに反映します</div>
          </div>
          <span className={`chip shrink-0 ${state.cls}`}>{state.label}</span>
        </div>

        {!g.linked ? (
          <>
            <button className="btn-primary w-full" disabled={busy} onClick={run(() => g.connect())}>
              {busy ? '接続中…' : 'Googleアカウントと連携する'}
            </button>
            <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-neutral-500">
              <li>上のボタンを押す</li>
              <li>自分のGoogleアカウントを選び「許可」を押す（カレンダーのチェックはオンのまま）</li>
              <li>完了。以後、自分のタスクが自動でカレンダーに入ります</li>
            </ol>
          </>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-neutral-50 py-2"><div className="text-[10px] text-neutral-500">最終同期</div><div className="text-xs font-medium">{fmtTime(g.account?.last_sync_at ?? null)}</div></div>
              <div className="rounded-xl bg-neutral-50 py-2"><div className="text-[10px] text-neutral-500">成功</div><div className="text-base font-semibold text-emerald-600 tabular-nums">{g.account?.last_success_count ?? 0}</div></div>
              <div className="rounded-xl bg-neutral-50 py-2"><div className="text-[10px] text-neutral-500">失敗</div><div className={`text-base font-semibold tabular-nums ${g.account?.last_failure_count ? 'text-red-600' : ''}`}>{g.account?.last_failure_count ?? 0}</div></div>
            </div>
            <div className="text-xs text-neutral-600">
              {g.running ? '同期中…' : g.pending > 0 ? <>未反映のタスク <b className="text-orange-500">{g.pending}件</b></> : 'すべて反映済みです'}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-primary" disabled={busy || g.running} onClick={run(() => g.syncNow())}>{g.connected ? '今すぐ同期' : '接続して同期'}</button>
              <button className="btn-ghost" disabled={busy} onClick={run(() => g.connect({ forceConsent: true }))}>再認証</button>
            </div>
            <button className="w-full text-xs text-neutral-400 underline" disabled={busy}
              onClick={run(async () => { if (confirm('連携を解除しますか？\nGoogle側の「NAORU TASK」カレンダー（このアプリが作った予定）も削除されます。他の予定には影響しません。')) await g.disconnect() })}>
              連携を解除
            </button>
          </>
        )}

        {g.error && <p className="rounded-xl bg-red-50 p-3 text-xs leading-relaxed text-red-700">{g.error}</p>}
        {g.failedLinks.length > 0 && !g.error && (
          <p className="rounded-xl bg-orange-50 p-3 text-xs leading-relaxed text-orange-700">反映できていないタスクが {g.failedLinks.length} 件あります。「今すぐ同期」で再試行します。<br />{g.failedLinks[0].last_error}</p>
        )}
        <p className="text-[11px] leading-relaxed text-neutral-400">
          ※ Googleの安全上の仕組みにより、接続は約1時間で切れます。アプリを閉じている間は反映されません。アプリを開いて「反映する」を押すと、その間の変更（院長による変更・削除も含む）がまとめて反映されます。
        </p>
      </div>
    </section>
  )
}

/** ホーム上部のお知らせ: 未反映があり、Googleとの接続が切れているときだけ表示 */
export function GoogleSyncBanner() {
  const g = useCalendarSync()
  const [busy, setBusy] = useState(false)
  if (!g.configured || !g.linked) return null
  if (g.error) {
    return (
      <div className="card flex items-center gap-3 border-red-200 bg-red-50/60 p-3 text-xs text-red-700">
        <span className="flex-1 leading-relaxed">{g.error}</span>
        <Link to="/settings" className="shrink-0 underline">設定へ</Link>
      </div>
    )
  }
  if (g.connected || g.pending === 0) return null
  return (
    <div className="card flex items-center gap-3 p-3">
      <span className="flex-1 text-xs leading-relaxed text-neutral-600">Googleカレンダーに未反映のタスクが <b className="text-orange-500">{g.pending}件</b> あります</span>
      <button className="btn-primary h-10 shrink-0 px-3" disabled={busy} onClick={async () => { setBusy(true); try { await g.syncNow() } finally { setBusy(false) } }}>
        {busy ? '反映中…' : '反映する'}
      </button>
    </div>
  )
}
