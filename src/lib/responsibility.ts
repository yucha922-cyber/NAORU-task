import type { Task, TaskStatus } from './types'

/**
 * そのユーザーが「自分の作業」として扱うべきタスクか。
 * - single + 担当者=本人 → 本人のタスク（カレンダー同期対象）
 * - everyone + 本人の完了行あり → 本人のタスク（カレンダー同期対象）
 * - single + 未割当 → 誰か1人が実施すれば完了。一覧には全員に出すが、カレンダーには同期しない
 */
/** 複数人がそれぞれ完了するタスク（全員 or 選んだメンバー） */
export const isMulti = (t: Pick<Task, 'assignment_mode'>) => t.assignment_mode === 'everyone' || t.assignment_mode === 'group'

export function isAssignedTo(t: Task, uid: string): boolean {
  if (isMulti(t)) return t.assignees.some((a) => a.user_id === uid)
  return t.assignee_id === uid
}

export function isUnassigned(t: Task): boolean {
  return t.assignment_mode === 'single' && !t.assignee_id
}

/** 本人から見た完了状態（全員向けタスクは本人の行、それ以外はタスク全体） */
export function statusFor(t: Task, uid: string): TaskStatus {
  if (isMulti(t)) return t.assignees.find((a) => a.user_id === uid)?.status ?? t.status
  return t.status
}

export function everyoneProgress(t: Task) {
  if (!isMulti(t)) return null
  const done = t.assignees.filter((a) => a.status === 'done').length
  return { done, total: t.assignees.length }
}

/** 店舗全体のタスク（「全員が実施」「選んだメンバー」「未割当＝誰か1人」で登録したもの） */
export function isStoreWide(t: Task) {
  return isMulti(t) || isUnassigned(t)
}

/** 一覧の「自分」に表示するか（担当 or 未割当） */
export function showInMine(t: Task, uid: string) {
  return isAssignedTo(t, uid) || isUnassigned(t)
}
