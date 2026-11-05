import { addDays, endOfWeek, todayStr } from './dates'
import type { Task } from './types'

export type Bucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'all'

const prio = { high: 0, medium: 1, low: 2 }
export const sortTasks = (a: Task, b: Task) =>
  (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') ||
  (a.due_time ?? '99').localeCompare(b.due_time ?? '99') ||
  prio[a.priority] - prio[b.priority]

/** 通常一覧用: 未完了の親タスク（小項目は親の中に表示） */
export function openTopLevel(tasks: Task[]) {
  return tasks.filter((t) => t.status === 'open' && !t.parent_id)
}

export function inBucket(t: Task, b: Bucket, today = todayStr()) {
  const d = t.due_date
  switch (b) {
    case 'overdue': return !!d && d < today
    case 'today': return d === today
    case 'tomorrow': return d === addDays(today, 1)
    case 'week': return !!d && d >= today && d <= endOfWeek(today)
    case 'all': return true
  }
}

export function childrenOf(tasks: Task[], id: string) {
  return tasks.filter((t) => t.parent_id === id).sort(sortTasks)
}

export function progress(tasks: Task[], id: string) {
  const c = childrenOf(tasks, id)
  if (!c.length) return null
  const done = c.filter((x) => x.status === 'done').length
  return { done, total: c.length, pct: Math.round((done / c.length) * 100) }
}

/** 期限超過の小項目がある親も「期限超過」に含めて漏れを防ぐ */
export function effectiveTasks(tasks: Task[]) {
  const open = tasks.filter((t) => t.status === 'open')
  const orphanChildren = open.filter((t) => t.parent_id && !open.some((p) => p.id === t.parent_id))
  return [...openTopLevel(tasks), ...orphanChildren]
}
