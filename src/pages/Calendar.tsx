import { useEffect, useMemo, useRef, useState } from 'react'
import { TaskItem } from '../components/TaskItem'
import { TaskSheet } from '../components/TaskSheet'
import { Empty } from '../components/ui'
import { useApp } from '../lib/app'
import * as gcal from '../lib/calendar'
import { repo } from '../lib/client'
import { addDays, dueState, fmt, todayStr } from '../lib/dates'
import { sortTasks } from '../lib/selectors'
import type { CalendarLink } from '../lib/types'

export function CalendarPage() {
  const { tasks, user } = useApp()
  const today = todayStr()
  const [month, setMonth] = useState(today.slice(0, 7))
  const [sel, setSel] = useState(today)
  const [adding, setAdding] = useState(false)
  const [scope, setScope] = useState<'mine' | 'all'>('mine')

  const visible = tasks.filter((t) => !t.parent_id && t.due_date && (scope === 'all' || t.assignee_id === user!.id || t.assignee_id === null))
  const byDay = useMemo(() => {
    const m = new Map<string, typeof visible>()
    for (const t of visible) m.set(t.due_date!, [...(m.get(t.due_date!) ?? []), t])
    return m
  }, [visible])

  const first = `${month}-01`
  const startPad = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7 // 月曜始まり
  const days: (string | null)[] = Array(startPad).fill(null)
  for (let d = first; d.slice(0, 7) === month; d = addDays(d, 1)) days.push(d)
  const shift = (n: number) => { const [y, m] = month.split('-').map(Number); setMonth(fmt(new Date(Date.UTC(y, m - 1 + n, 1, 12))).slice(0, 7)) }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">カレンダー</h1>
        <div className="flex rounded-xl border border-neutral-200 bg-white p-0.5 text-xs">
          {(['mine', 'all'] as const).map((s) => (
            <button key={s} onClick={() => setScope(s)} className={`h-8 rounded-lg px-3 ${scope === s ? 'bg-ink text-white' : 'text-neutral-500'}`}>{s === 'mine' ? '自分' : '店舗全体'}</button>
          ))}
        </div>
      </div>

      <div className="card p-3">
        <div className="mb-2 flex items-center justify-between">
          <button className="h-10 w-10 text-neutral-500" onClick={() => shift(-1)} aria-label="前の月">‹</button>
          <div className="text-sm font-semibold">{Number(month.slice(0, 4))}年{Number(month.slice(5))}月</div>
          <button className="h-10 w-10 text-neutral-500" onClick={() => shift(1)} aria-label="次の月">›</button>
        </div>
        <div className="grid grid-cols-7 text-center text-[11px] text-neutral-400">
          {['月', '火', '水', '木', '金', '土', '日'].map((w) => <div key={w} className="py-1">{w}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {days.map((d, i) => {
            if (!d) return <div key={i} />
            const ts = byDay.get(d) ?? []
            const open = ts.filter((t) => t.status === 'open')
            const dot = open.some((t) => dueState(t) === 'overdue') ? 'bg-red-500' : open.some((t) => dueState(t) === 'soon') ? 'bg-orange-400' : open.length ? 'bg-ink' : ts.length ? 'bg-emerald-500' : ''
            return (
              <button key={d} onClick={() => setSel(d)}
                className={`flex h-12 flex-col items-center justify-center rounded-xl text-sm ${d === sel ? 'bg-ink text-white' : d === today ? 'bg-neutral-100 font-semibold' : ''}`}>
                {Number(d.slice(8))}
                <span className={`mt-1 h-1.5 w-1.5 rounded-full ${dot}`} />
              </button>
            )
          })}
        </div>
      </div>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="section-title">{Number(sel.slice(5, 7))}月{Number(sel.slice(8))}日のタスク</h2>
          <button className="mb-2 text-xs text-neutral-500" onClick={() => setAdding(true)}>＋ この日に追加</button>
        </div>
        <div className="space-y-2">
          {(byDay.get(sel) ?? []).sort(sortTasks).map((t) => <TaskItem key={t.id} task={t} showAssignee={scope === 'all'} />)}
          {!(byDay.get(sel) ?? []).length && <Empty>タスクはありません</Empty>}
        </div>
      </section>

      <GoogleSync />
      {adding && <TaskSheet defaultDate={sel} onClose={() => setAdding(false)} />}
    </div>
  )
}

function GoogleSync() {
  const app = useApp()
  const uid = app.user!.id
  const [linked, setLinked] = useState(() => gcal.isLinked(uid))
  const [active, setActive] = useState(gcal.hasToken())
  const [links, setLinks] = useState<CalendarLink[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const running = useRef(false)

  const refreshLinks = () => app.store && repo.listCalendarLinks(app.store.id).then(setLinks).catch(() => {})
  useEffect(() => { if (linked) refreshLinks() }, [linked]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (forceRetry = false, tasks = app.tasks) => {
    if (running.current || !app.store || !gcal.hasToken()) return
    running.current = true
    setStatus('同期中…')
    try {
      const current = await repo.listCalendarLinks(app.store.id)
      const r = await gcal.syncTasks({ userId: uid, storeId: app.store.id, tasks, links: current, save: repo.saveCalendarLink, forceRetry })
      setStatus(`同期完了：送信 ${r.synced}件 / 変更なし ${r.skipped}件${r.failed ? ` / 失敗 ${r.failed}件` : ''}${r.stoppedByLimit ? '（制限・認証エラーのため中断）' : ''}`)
      setLinked(true)
    } catch (e) {
      setStatus(`同期エラー：${(e as Error).message}`)
    } finally {
      running.current = false
      setActive(gcal.hasToken())
      refreshLinks()
    }
  }

  // 連携中はタスク変更時に自動同期（5秒デバウンス・変更分のみ送信）
  useEffect(() => {
    if (!active) return
    let timer: number | undefined
    const off = app.onTasksChanged((t) => { clearTimeout(timer); timer = window.setTimeout(() => run(false, t), 5000) })
    return () => { off(); clearTimeout(timer) }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  const errors = links.filter((l) => l.sync_status === 'error')

  if (!gcal.isConfigured()) {
    return (
      <div className="card p-4 text-sm">
        <div className="font-medium">Googleカレンダー連携</div>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">未設定です（管理者が Google OAuth クライアントIDを設定すると利用できます。設定手順は docs/SETUP.md を参照）。</p>
      </div>
    )
  }
  return (
    <div className="card space-y-3 p-4 text-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">Googleカレンダー連携</div>
          <div className="text-xs text-neutral-500">{active ? '接続中' : linked ? '連携済み（再接続が必要）' : '未連携'}</div>
        </div>
        {active
          ? <button className="btn-ghost h-9" onClick={() => run(true)}>今すぐ同期</button>
          : <button className="btn-primary h-9" onClick={async () => {
              try { await gcal.connect(!linked); setActive(true); await run() } catch (e) { setStatus((e as Error).message) }
            }}>{linked ? '再接続' : 'Googleと連携'}</button>}
      </div>
      <p className="text-xs leading-relaxed text-neutral-500">
        自分が担当で期限のあるタスクを、専用の「NAORU TASK」カレンダーに反映します（アプリ→Googleの一方向）。既存の予定やカレンダーは閲覧・編集しません。
      </p>
      {status && <p className="text-xs text-neutral-600">{status}</p>}
      {errors.length > 0 && (
        <div className="rounded-xl bg-red-50 p-3 text-xs text-red-700">
          同期エラー {errors.length}件（次回同期時に自動再試行。5回失敗したものは「今すぐ同期」で再試行）
          <div className="mt-1 truncate opacity-80">{errors[0].last_error}</div>
        </div>
      )}
      {linked && (
        <button className="text-xs text-neutral-400 underline" onClick={() => { gcal.disconnect(uid); setLinked(false); setActive(false); setStatus('連携を解除しました（Google側のカレンダーは手動で削除できます）') }}>連携を解除</button>
      )}
    </div>
  )
}
