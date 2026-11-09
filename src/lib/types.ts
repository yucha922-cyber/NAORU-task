export type Role = 'staff' | 'manager' | 'admin'
export type Priority = 'low' | 'medium' | 'high'
export type TaskStatus = 'open' | 'done'
/** 業務カテゴリ。日報・カルテは院長画面で提出状況を集計する */
export type Category = 'general' | 'daily_report' | 'karte' | 'cleaning' | 'blog' | 'report'
export type Frequency = 'daily' | 'weekly' | 'interval' | 'monthly'
/** single: 担当者1人 or 未割当（誰か1人が実施すれば完了） / everyone: 全員が各自実施 / group: 選んだメンバーが各自実施 */
export type AssignmentMode = 'single' | 'everyone' | 'group'

export interface TaskAssignee {
  user_id: string
  status: TaskStatus
  completed_at: string | null
}

export interface Store {
  id: string
  name: string
  timezone: string
}

export interface Profile {
  id: string
  email: string
  display_name: string
}

export interface Membership {
  id: string
  store_id: string
  user_id: string
  role: Role
  active: boolean
}

export interface Invitation {
  email: string
  role: Role
  created_at: string
}

export interface Member extends Membership {
  profile: Profile
}

export interface Task {
  id: string
  store_id: string
  parent_id: string | null
  title: string
  description: string
  assignee_id: string | null
  priority: Priority
  category: Category
  due_date: string | null // YYYY-MM-DD（店舗タイムゾーン）
  due_time: string | null // HH:MM
  status: TaskStatus
  completed_at: string | null
  completed_by: string | null
  template_id: string | null
  occurrence_date: string | null
  created_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  assignment_mode: AssignmentMode
  /** Googleカレンダーの予定の色（1〜11、10=完了用は除く）。null=カレンダーの標準色 */
  color_id: string | null
  work_date: string | null // 作業日（作業時間を指定する場合）
  work_start: string | null // HH:MM
  work_end: string | null // HH:MM
  /** 全員向けタスクのスタッフ別完了状態（single では空） */
  assignees: TaskAssignee[]
}

export type TaskInput = Pick<
  Task,
  'title' | 'description' | 'assignee_id' | 'priority' | 'category' | 'due_date' | 'due_time' | 'parent_id'
  | 'assignment_mode' | 'work_date' | 'work_start' | 'work_end' | 'color_id'
>

export interface TaskTemplate {
  id: string
  store_id: string
  title: string
  description: string
  assignee_id: string | null
  priority: Priority
  category: Category
  frequency: Frequency
  interval_days: number | null
  weekdays: number[] // 0=日 … 6=土（weekly で使用）
  day_of_month: number | null
  due_time: string | null
  start_date: string
  end_date: string | null
  last_generated_date: string | null
  active: boolean
  assignment_mode: AssignmentMode
  color_id: string | null
  /** group のときのメンバー */
  assignee_ids: string[]
}

export type TemplateInput = Omit<TaskTemplate, 'id' | 'store_id' | 'last_generated_date'>

export type ActivityAction = 'create' | 'update' | 'complete' | 'reopen' | 'delete'

export interface Activity {
  id: string
  store_id: string
  task_id: string
  actor_id: string | null
  action: ActivityAction
  changes: Record<string, unknown>
  task_title: string
  created_at: string
}

/** 未同期 / 同期中 / 同期成功 / 同期失敗 / 再認証が必要 */
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'error' | 'reauth_required'

export interface CalendarLink {
  task_id: string
  store_id: string
  user_id: string
  calendar_id: string
  google_event_id: string | null
  sync_status: SyncStatus
  synced_hash: string | null
  last_error: string | null
  retry_count: number
  synced_at: string | null
}

export interface GoogleAccount {
  user_id: string
  google_email: string | null
  calendar_id: string | null
  status: 'active' | 'reauth_required' | 'disconnected'
  last_sync_at: string | null
  last_success_count: number
  last_failure_count: number
  last_error: string | null
}

export const ROLE_LABEL: Record<Role, string> = { staff: 'スタッフ', manager: '院長', admin: '管理者' }
export const PRIORITY_LABEL: Record<Priority, string> = { low: '低', medium: '中', high: '高' }
export const CATEGORY_LABEL: Record<Category, string> = {
  general: '一般',
  daily_report: '日報',
  karte: 'カルテ入力',
  cleaning: '清掃',
  blog: 'HPBブログ',
  report: '月次報告',
}
/** Googleカレンダーの予定の色（グラファイト=8・バジル=10 は「完了」の目印のため除外） */
export const EVENT_COLORS: { id: string; name: string; hex: string }[] = [
  { id: '11', name: 'トマト', hex: '#d50000' },
  { id: '4', name: 'フラミンゴ', hex: '#e67c73' },
  { id: '6', name: 'ミカン', hex: '#f4511e' },
  { id: '5', name: 'バナナ', hex: '#f6bf26' },
  { id: '2', name: 'セージ', hex: '#33b679' },
  { id: '7', name: 'ピーコック', hex: '#039be5' },
  { id: '9', name: 'ブルーベリー', hex: '#3f51b5' },
  { id: '1', name: 'ラベンダー', hex: '#7986cb' },
  { id: '3', name: 'ブドウ', hex: '#8e24aa' },
]
export const colorHex = (id: string | null) => EVENT_COLORS.find((c) => c.id === id)?.hex ?? null

export const WEEKDAY_LABEL = ['日', '月', '火', '水', '木', '金', '土']
