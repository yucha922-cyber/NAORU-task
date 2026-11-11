import { describe, expect, it } from 'vitest'
import { dueMessage, dueSummary } from './notify'
import type { Task } from './types'

let n = 0
const t = (p: Partial<Task>): Task => ({
  id: String(++n), store_id: 's', parent_id: null, title: 'x', description: '', assignee_id: 'u', priority: 'medium', category: 'general',
  due_date: '2026-11-11', due_time: null, status: 'open', completed_at: null, completed_by: null, template_id: null, occurrence_date: null,
  created_by: 'u', created_at: '', updated_at: '', deleted_at: null, assignment_mode: 'single', color_id: null, work_date: null, work_start: null, work_end: null, assignees: [], ...p,
})

describe('期限が近いタスクの集計', () => {
  it('期限超過・今日・明日を数え、明後日・完了・他人・小項目・削除済みは除外', () => {
    const tasks = [
      t({ due_date: '2026-11-10' }), t({ due_date: '2026-11-11' }), t({ due_date: '2026-11-12' }),
      t({ due_date: '2026-11-13' }), t({ status: 'done' }), t({ assignee_id: 'other' }), t({ parent_id: 'p' }), t({ deleted_at: 'x' }),
      t({ assignee_id: null, assignment_mode: 'group', assignees: [{ user_id: 'u', status: 'open', completed_at: null }] }),
      t({ assignee_id: null, assignment_mode: 'everyone', assignees: [{ user_id: 'u', status: 'done', completed_at: 'x' }] }),
    ]
    expect(dueSummary(tasks, 'u', '2026-11-11')).toEqual({ overdue: 1, today: 2, tomorrow: 1, total: 4 })
  })
  it('文面（該当なしは通知しない）', () => {
    expect(dueMessage({ overdue: 0, today: 0, tomorrow: 0, total: 0 })).toBeNull()
    expect(dueMessage({ overdue: 1, today: 2, tomorrow: 0, total: 3 })).toEqual({ title: '⚠ 期限が過ぎたタスクがあります', body: '期限超過 1件・今日 2件（タップして確認）' })
    expect(dueMessage({ overdue: 0, today: 0, tomorrow: 2, total: 2 })!.body).toBe('明日 2件（タップして確認）')
  })
})
