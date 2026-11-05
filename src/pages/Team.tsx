import { useState } from 'react'
import { TaskItem } from '../components/TaskItem'
import { Bar, Empty, Stat, Tabs } from '../components/ui'
import { useApp } from '../lib/app'
import { addDays, todayStr } from '../lib/dates'
import { inBucket, sortTasks } from '../lib/selectors'
import type { Category } from '../lib/types'

export function Team() {
  const app = useApp()
  const [view, setView] = useState<'staff' | 'overdue' | 'open' | 'reports'>('staff')
  const [who, setWho] = useState<string | null>(null)
  if (!app.isManager) return <Empty>この画面は院長・管理者のみ利用できます</Empty>

  const today = todayStr()
  const weekAgo = addDays(today, -6)
  const live = app.tasks.filter((t) => !t.deleted_at)
  const open = live.filter((t) => t.status === 'open')
  const overdue = open.filter((t) => inBucket(t, 'overdue')).sort(sortTasks)
  const staff = app.members.filter((m) => m.active)

  // 達成率: 直近7日に期限が来たタスクのうち完了した割合
  const rate = (uid: string) => {
    const due = live.filter((t) => t.assignee_id === uid && t.due_date && t.due_date >= weekAgo && t.due_date <= today)
    const done = due.filter((t) => t.status === 'done').length
    return { done, total: due.length, pct: due.length ? Math.round((done / due.length) * 100) : null }
  }
  const reportStatus = (uid: string, cat: Category) => {
    const ts = live.filter((t) => t.assignee_id === uid && t.category === cat && t.due_date === today)
    if (!ts.length) return null
    return ts.every((t) => t.status === 'done')
  }
  const totalRate = (() => {
    const due = live.filter((t) => t.due_date && t.due_date >= weekAgo && t.due_date <= today)
    return due.length ? Math.round((due.filter((t) => t.status === 'done').length / due.length) * 100) : 0
  })()

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">チーム管理</h1>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="未完了" value={open.filter((t) => !t.parent_id).length} />
        <Stat label="期限超過" value={overdue.length} tone={overdue.length ? 'red' : undefined} />
        <Stat label="7日達成率" value={`${totalRate}%`} tone="green" />
      </div>
      <Tabs value={view} onChange={(v) => { setView(v); setWho(null) }} items={[
        { value: 'staff', label: 'スタッフ別' },
        { value: 'reports', label: '日報・カルテ' },
        { value: 'overdue', label: '期限超過', count: overdue.length },
        { value: 'open', label: '未完了一覧' },
      ]} />

      {view === 'staff' && !who && (
        <div className="space-y-2">
          {staff.map((m) => {
            const r = rate(m.user_id)
            const mineOpen = open.filter((t) => t.assignee_id === m.user_id && !t.parent_id)
            const od = mineOpen.filter((t) => inBucket(t, 'overdue')).length
            return (
              <button key={m.id} className="card w-full p-4 text-left" onClick={() => setWho(m.user_id)}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{m.profile.display_name}</span>
                  <span className="text-xs text-neutral-500">未完了 {mineOpen.length}{od > 0 && <span className="ml-2 font-medium text-red-600">超過 {od}</span>}</span>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <Bar pct={r.pct ?? 0} tone="green" />
                  <span className="w-24 shrink-0 text-right text-xs tabular-nums text-neutral-500">{r.pct === null ? '対象なし' : `${r.pct}%（${r.done}/${r.total}）`}</span>
                </div>
              </button>
            )
          })}
          <p className="px-1 text-[11px] text-neutral-400">達成率＝直近7日間に期限を迎えたタスクのうち完了した割合</p>
        </div>
      )}
      {view === 'staff' && who && (
        <div className="space-y-2">
          <button className="text-sm text-neutral-500" onClick={() => setWho(null)}>‹ スタッフ一覧</button>
          <h2 className="font-semibold">{app.memberName(who)} さんの未完了タスク</h2>
          {open.filter((t) => t.assignee_id === who && !t.parent_id).sort(sortTasks).map((t) => <TaskItem key={t.id} task={t} showAssignee={false} />)}
          {!open.some((t) => t.assignee_id === who) && <Empty>未完了タスクはありません</Empty>}
        </div>
      )}
      {view === 'reports' && (
        <div className="card divide-y divide-neutral-100">
          <div className="grid grid-cols-3 px-4 py-2 text-[11px] text-neutral-500"><span>スタッフ（本日）</span><span className="text-center">日報</span><span className="text-center">カルテ入力</span></div>
          {staff.map((m) => (
            <div key={m.id} className="grid grid-cols-3 items-center px-4 py-3 text-sm">
              <span>{m.profile.display_name}</span>
              <Mark v={reportStatus(m.user_id, 'daily_report')} />
              <Mark v={reportStatus(m.user_id, 'karte')} />
            </div>
          ))}
        </div>
      )}
      {view === 'overdue' && <div className="space-y-2">{overdue.length ? overdue.map((t) => <TaskItem key={t.id} task={t} />) : <Empty>期限超過のタスクはありません</Empty>}</div>}
      {view === 'open' && <div className="space-y-2">{open.filter((t) => !t.parent_id).sort(sortTasks).map((t) => <TaskItem key={t.id} task={t} />)}</div>}
    </div>
  )
}

function Mark({ v }: { v: boolean | null }) {
  if (v === null) return <span className="text-center text-xs text-neutral-300">対象外</span>
  return v
    ? <span className="text-center text-xs font-medium text-emerald-600">✓ 完了</span>
    : <span className="text-center text-xs font-medium text-red-600">未提出</span>
}
