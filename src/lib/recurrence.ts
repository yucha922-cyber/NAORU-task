import type { TaskTemplate } from './types'
import { addDays, diffDays, parseDate } from './dates'

/** 取りこぼし復旧時に遡る最大日数（大量生成の防止） */
export const MAX_CATCHUP_DAYS = 7

/** テンプレートが指定日に発生するか（SQL版 generate_recurring_tasks と同じ規則） */
export function occursOn(t: Pick<TaskTemplate, 'frequency' | 'interval_days' | 'weekdays' | 'day_of_month' | 'start_date' | 'end_date'>, date: string): boolean {
  if (date < t.start_date) return false
  if (t.end_date && date > t.end_date) return false
  const d = parseDate(date)
  switch (t.frequency) {
    case 'daily':
      return true
    case 'weekly':
      return t.weekdays.includes(d.getUTCDay())
    case 'interval': {
      const n = Math.max(1, t.interval_days ?? 1)
      return diffDays(date, t.start_date) % n === 0
    }
    case 'monthly': {
      const dom = t.day_of_month ?? 1
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
      return d.getUTCDate() === Math.min(dom, lastDay)
    }
  }
}

/**
 * 生成対象の日付一覧。last_generated_date の翌日〜until まで（最大 MAX_CATCHUP_DAYS 日遡る）。
 * 重複は DB の一意制約 (template_id, occurrence_date) でも防止する。
 */
export function pendingOccurrences(t: TaskTemplate, today: string, until: string): string[] {
  if (!t.active) return []
  let from = t.last_generated_date ? addDays(t.last_generated_date, 1) : t.start_date
  const floor = addDays(today, -MAX_CATCHUP_DAYS)
  if (from < floor) from = floor
  if (from < t.start_date) from = t.start_date
  const out: string[] = []
  for (let d = from; d <= until; d = addDays(d, 1)) if (occursOn(t, d)) out.push(d)
  return out
}
