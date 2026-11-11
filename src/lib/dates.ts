import type { Task } from './types.ts'

export const TZ = 'Asia/Tokyo'

/** 指定タイムゾーンでの日付 YYYY-MM-DD */
export function todayStr(tz = TZ, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** YYYY-MM-DD を UTC 正午の Date に（日付計算専用。DSTやTZずれを避ける） */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12))
}

export function fmt(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(s: string, n: number): string {
  const d = parseDate(s)
  d.setUTCDate(d.getUTCDate() + n)
  return fmt(d)
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / 86400000)
}

export function weekday(s: string): number {
  return parseDate(s).getUTCDay()
}

/** 今週の終わり（日曜日）。月曜始まり */
export function endOfWeek(s: string): string {
  const wd = weekday(s)
  return addDays(s, wd === 0 ? 0 : 7 - wd)
}

export function labelDate(s: string | null, today = todayStr()): string {
  if (!s) return '期限なし'
  const diff = diffDays(s, today)
  if (diff === 0) return '今日'
  if (diff === 1) return '明日'
  if (diff === -1) return '昨日'
  const d = parseDate(s)
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getUTCDay()]
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${wd})`
}

export type DueState = 'done' | 'overdue' | 'soon' | 'normal' | 'none'

/** 期限超過=赤 / 今日・明日=オレンジ / 完了=緑 */
export function dueState(t: Pick<Task, 'status' | 'due_date'>, today = todayStr()): DueState {
  if (t.status === 'done') return 'done'
  if (!t.due_date) return 'none'
  const diff = diffDays(t.due_date, today)
  if (diff < 0) return 'overdue'
  if (diff <= 1) return 'soon'
  return 'normal'
}
