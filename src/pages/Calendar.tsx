import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { TaskItem } from '../components/TaskItem'
import { TaskSheet } from '../components/TaskSheet'
import { Empty, Sheet } from '../components/ui'
import { useApp } from '../lib/app'
import { useCalendarSync } from '../lib/calendarManager'
import { isStoreWide, showInMine, statusFor } from '../lib/responsibility'
import { addDays, dueState, fmt, todayStr } from '../lib/dates'
import { sortTasks } from '../lib/selectors'
import { repo } from '../lib/client'
import { occursOn, TEMPLATES_CHANGED } from '../lib/recurrence'
import type { TaskTemplate } from '../lib/types'

export function CalendarPage() {
  const { tasks, user, store } = useApp()
  const uid = user!.id
  const today = todayStr()
  const [month, setMonth] = useState(today.slice(0, 7))
  const [sel, setSel] = useState(today)
  const [adding, setAdding] = useState(false)
  const [picking, setPicking] = useState(false)
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  const touch = useRef<{ x: number; y: number } | null>(null)

  // 繰り返しタスクの今後の予定（実際のタスクは前日に自動作成されるため、それまでは予定として表示）
  useEffect(() => {
    if (!store) return
    const load = () => repo.listTemplates(store.id).then(setTemplates).catch(() => {})
    load()
    window.addEventListener(TEMPLATES_CHANGED, load)
    return () => window.removeEventListener(TEMPLATES_CHANGED, load)
  }, [store])

  // 自分: 自分の担当＋店舗全体のタスク / 店舗全体: 「全員が実施」「未割当（誰か1人）」で登録したタスクだけ（個人の担当は出さない）
  const visible = tasks.filter((t) => !t.parent_id && t.due_date && (scope === 'all' ? isStoreWide(t) : showInMine(t, uid)))
  const byDay = useMemo(() => {
    const m = new Map<string, typeof visible>()
    for (const t of visible) m.set(t.due_date!, [...(m.get(t.due_date!) ?? []), t])
    return m
  }, [visible])

  const first = `${month}-01`
  const startPad = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7 // 月曜始まり
  const days: string[] = []
  for (let d = first; d.slice(0, 7) === month; d = addDays(d, 1)) days.push(d)

  const planned = useMemo(() => {
    const m = new Map<string, TaskTemplate[]>()
    const generated = new Set(tasks.filter((t) => t.template_id).map((t) => `${t.template_id}:${t.occurrence_date}`))
    const tomorrow = addDays(today, 1)
    for (const tpl of templates) {
      if (!tpl.active) continue
      const storeWide = tpl.assignment_mode === 'everyone' || !tpl.assignee_id
      if (scope === 'all' ? !storeWide : !(storeWide || tpl.assignee_id === uid)) continue
      for (const d of days) {
        if (d <= tomorrow || generated.has(`${tpl.id}:${d}`) || !occursOn(tpl, d)) continue
        m.set(d, [...(m.get(d) ?? []), tpl])
      }
    }
    return m
  }, [templates, tasks, month, scope, uid, today]) // eslint-disable-line react-hooks/exhaustive-deps

  const shift = (n: number) => { const [y, m] = month.split('-').map(Number); setMonth(fmt(new Date(Date.UTC(y, m - 1 + n, 1, 12))).slice(0, 7)) }
  // 横スワイプで前月・翌月（縦スクロールと区別するため、横方向が大きい場合のみ）
  const onTouchStart = (e: React.TouchEvent) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touch.current) return
    const dx = e.changedTouches[0].clientX - touch.current.x
    const dy = e.changedTouches[0].clientY - touch.current.y
    touch.current = null
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) shift(dx < 0 ? 1 : -1)
  }

  const selTasks = (byDay.get(sel) ?? []).sort(sortTasks)
  const selPlanned = planned.get(sel) ?? []

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

      <div className="card touch-pan-y p-3" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <div className="mb-2 flex items-center justify-between">
          <button className="h-11 w-11 text-xl text-neutral-500" onClick={() => shift(-1)} aria-label="前の月">‹</button>
          <button className="flex h-11 items-center gap-1 rounded-xl px-3 text-sm font-semibold active:bg-neutral-100" onClick={() => setPicking(true)} aria-label="表示する月を選ぶ">
            {Number(month.slice(0, 4))}年{Number(month.slice(5))}月<span className="text-[10px] text-neutral-400">▼</span>
          </button>
          <button className="h-11 w-11 text-xl text-neutral-500" onClick={() => shift(1)} aria-label="次の月">›</button>
        </div>
        <div className="grid grid-cols-7 text-center text-[11px] text-neutral-400">
          {['月', '火', '水', '木', '金', '土', '日'].map((w) => <div key={w} className="py-1">{w}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {Array.from({ length: startPad }, (_, i) => <div key={`pad${i}`} />)}
          {days.map((d) => {
            const ts = byDay.get(d) ?? []
            const open = ts.filter((t) => statusFor(t, uid) === 'open')
            const st = (t: (typeof ts)[number]) => dueState({ status: 'open', due_date: t.due_date })
            // 重要度「高」の未完了タスクがある日は日付を赤丸で囲む（点は期限の状態を表すため別の印にする）
            const important = open.some((t) => t.priority === 'high') || (planned.get(d) ?? []).some((p) => p.priority === 'high')
            // 毎日の繰り返しは全日に付いて目印にならないため、点は毎日以外の繰り返し予定だけ
            const plannedMark = (planned.get(d) ?? []).some((p) => p.frequency !== 'daily')
            const dot = open.some((t) => st(t) === 'overdue') ? 'bg-red-500' : open.some((t) => st(t) === 'soon') ? 'bg-orange-400' : open.length ? 'bg-ink' : ts.length ? 'bg-emerald-500' : plannedMark ? 'border border-neutral-400' : ''
            return (
              <button key={d} onClick={() => setSel(d)}
                className={`flex h-14 flex-col items-center justify-center rounded-xl text-sm ${d === sel ? 'bg-ink text-white' : d === today ? 'bg-neutral-100 font-semibold' : ''}`}>
                <span className={`flex h-7 w-7 items-center justify-center rounded-full ${important ? 'border-2 border-red-500' : ''}`}
                  aria-label={important ? `${Number(d.slice(8))}日（重要なタスクあり）` : undefined}>{Number(d.slice(8))}</span>
                <span className={`mt-0.5 h-1.5 w-1.5 rounded-full ${dot}`} />
              </button>
            )
          })}
        </div>
        {month !== today.slice(0, 7) && (
          <button className="mt-2 w-full text-xs text-neutral-500" onClick={() => { setMonth(today.slice(0, 7)); setSel(today) }}>今月に戻る</button>
        )}
      </div>

      <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-neutral-500">
        <span className="flex items-center gap-1"><span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-red-500" />重要度 高</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-red-500" />期限超過</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-orange-400" />期限間近</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-ink" />未完了</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />完了</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full border border-neutral-400" />繰り返し予定</span>
      </div>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="section-title">{Number(sel.slice(5, 7))}月{Number(sel.slice(8))}日のタスク</h2>
          <button className="mb-2 min-h-9 text-xs text-neutral-500" onClick={() => setAdding(true)}>＋ この日に追加</button>
        </div>
        <div className="space-y-2">
          {selTasks.map((t) => <TaskItem key={t.id} task={t} showAssignee={scope === 'all'} />)}
          {selPlanned.map((p) => (
            <div key={p.id} className="card flex items-center gap-3 border-dashed px-4 py-3 text-sm text-neutral-500">
              <span aria-hidden>↻</span>
              <span className="flex-1">{p.title}</span>
              <span className="text-[11px]">繰り返し予定（前日に自動作成）</span>
            </div>
          ))}
          {!selTasks.length && !selPlanned.length && <Empty>タスクはありません</Empty>}
        </div>
      </section>

      <GoogleStatus />
      {adding && <TaskSheet defaultDate={sel} onClose={() => setAdding(false)} />}
      {picking && <MonthPicker value={month} onClose={() => setPicking(false)} onPick={(m) => { setMonth(m); setPicking(false) }} />}
    </div>
  )
}

function MonthPicker({ value, onPick, onClose }: { value: string; onPick: (m: string) => void; onClose: () => void }) {
  const [year, setYear] = useState(Number(value.slice(0, 4)))
  const cur = todayStr().slice(0, 7)
  return (
    <Sheet title="表示する月を選ぶ" onClose={onClose}>
      <div className="mb-4 flex items-center justify-between">
        <button className="h-11 w-11 text-xl text-neutral-500" onClick={() => setYear(year - 1)} aria-label="前の年">‹</button>
        <div className="text-base font-semibold">{year}年</div>
        <button className="h-11 w-11 text-xl text-neutral-500" onClick={() => setYear(year + 1)} aria-label="次の年">›</button>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {Array.from({ length: 12 }, (_, i) => {
          const m = `${year}-${String(i + 1).padStart(2, '0')}`
          return (
            <button key={m} onClick={() => onPick(m)}
              className={`h-12 rounded-xl border text-sm ${m === value ? 'border-ink bg-ink text-white' : m === cur ? 'border-ink' : 'border-neutral-200'}`}>{i + 1}月</button>
          )
        })}
      </div>
      <button className="btn-ghost mt-4 w-full" onClick={() => onPick(cur)}>今月</button>
    </Sheet>
  )
}

function GoogleStatus() {
  const g = useCalendarSync()
  if (!g.configured) return null
  return (
    <Link to="/settings" className="card flex items-center justify-between gap-3 p-4 text-sm">
      <div>
        <div className="font-medium">Googleカレンダー連携</div>
        <div className="text-xs text-neutral-500">
          {!g.linked ? '未連携 — 自分のタスクをGoogleカレンダーに表示できます' : g.running ? '同期中…' : g.pending ? `未反映 ${g.pending}件` : 'すべて反映済み'}
        </div>
      </div>
      <span className="text-neutral-300">›</span>
    </Link>
  )
}
