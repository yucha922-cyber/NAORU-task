/**
 * 期限が近いタスクの集計（アプリのバッジ表示とサーバーの毎朝の通知で共通。Deno でも動くよう拡張子付き import）。
 * 対象: 本人の担当（個人・全員・選んだメンバー）で本人が未完了、期限が「明日まで」のもの。小項目は親にまとめるため除外。
 */
import { addDays } from './dates.ts'
import { isAssignedTo, statusFor } from './responsibility.ts'
import type { Task } from './types.ts'

export interface DueSummary { overdue: number; today: number; tomorrow: number; total: number }

export function dueSummary(tasks: Task[], uid: string, today: string): DueSummary {
  const tomorrow = addDays(today, 1)
  const s = { overdue: 0, today: 0, tomorrow: 0, total: 0 }
  for (const t of tasks) {
    if (t.deleted_at || t.parent_id || !t.due_date || t.due_date > tomorrow) continue
    if (!isAssignedTo(t, uid) || statusFor(t, uid) !== 'open') continue
    if (t.due_date < today) s.overdue++
    else if (t.due_date === today) s.today++
    else s.tomorrow++
  }
  s.total = s.overdue + s.today + s.tomorrow
  return s
}

/** 通知の文面（該当がなければ null＝通知しない） */
export function dueMessage(s: DueSummary): { title: string; body: string } | null {
  if (!s.total) return null
  const parts = [s.overdue && `期限超過 ${s.overdue}件`, s.today && `今日 ${s.today}件`, s.tomorrow && `明日 ${s.tomorrow}件`].filter(Boolean)
  return { title: s.overdue ? '⚠ 期限が過ぎたタスクがあります' : '今日・明日のタスク', body: parts.join('・') + '（タップして確認）' }
}
