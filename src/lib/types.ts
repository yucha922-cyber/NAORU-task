export type Role = 'staff' | 'manager' | 'admin'
export type Priority = 'low' | 'medium' | 'high'
export type TaskStatus = 'open' | 'done'
/** 業務カテゴリ。日報・カルテは院長画面で提出状況を集計する */
export type Category = 'general' | 'daily_report' | 'karte' | 'cleaning' | 'blog' | 'report'
export type Frequency = 'daily' | 'weekly' | 'interval' | 'monthly'

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
}

export type TaskInput = Pick<
  Task,
  'title' | 'description' | 'assignee_id' | 'priority' | 'category' | 'due_date' | 'due_time' | 'parent_id'
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

export interface CalendarLink {
  task_id: string
  store_id: string
  user_id: string
  calendar_id: string
  google_event_id: string | null
  sync_status: 'synced' | 'pending' | 'error'
  synced_hash: string | null
  last_error: string | null
  retry_count: number
  synced_at: string | null
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
export const WEEKDAY_LABEL = ['日', '月', '火', '水', '木', '金', '土']
