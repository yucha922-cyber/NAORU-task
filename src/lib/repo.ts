import type { Activity, CalendarLink, GoogleAccount, Member, Role, Store, Task, TaskInput, TaskTemplate, TemplateInput } from './types'

export interface SessionUser {
  id: string
  email: string
}

/** データ層の共通インターフェース。Supabase版とローカルデモ版の2実装 */
export interface Repo {
  readonly mode: 'supabase' | 'demo'
  getUser(): Promise<SessionUser | null>
  onAuthChange(cb: (u: SessionUser | null) => void): () => void
  signIn(email: string, password: string): Promise<void>
  signUp(email: string, password: string, displayName: string): Promise<void>
  signOut(): Promise<void>

  myStores(): Promise<{ store: Store; role: Role }[]>
  createStore(name: string): Promise<string>
  listMembers(storeId: string): Promise<Member[]>
  addMember(storeId: string, email: string, role: Role): Promise<void>
  updateMember(id: string, patch: { role?: Role; active?: boolean }): Promise<void>
  updateMyName(name: string): Promise<void>

  /** 未完了タスク + 直近 recentDays 日に完了したタスク（院長画面・達成率用） */
  listTasks(storeId: string, recentDays: number): Promise<Task[]>
  listHistory(storeId: string, offset: number, limit: number): Promise<Task[]>
  createTask(storeId: string, input: TaskInput): Promise<Task>
  updateTask(id: string, patch: Partial<TaskInput>): Promise<Task>
  setDone(id: string, done: boolean): Promise<Task>
  /** 全員向けタスクで自分の分だけ完了/未完了にする */
  setMyDone(id: string, done: boolean): Promise<Task>
  deleteTask(id: string): Promise<void>
  /** 削除済みも含めて ID で取得（カレンダー同期の後始末用） */
  getTasksByIds(ids: string[]): Promise<Task[]>

  listTemplates(storeId: string): Promise<TaskTemplate[]>
  saveTemplate(storeId: string, input: TemplateInput, id?: string): Promise<void>
  deleteTemplate(id: string): Promise<void>
  generateRecurring(storeId: string): Promise<number>

  listActivity(storeId: string, limit: number): Promise<Activity[]>

  // Googleカレンダー連携（すべて本人の分のみ。RLS で他人の行は読み書き不可）
  getGoogleAccount(): Promise<GoogleAccount | null>
  saveGoogleAccount(patch: Partial<GoogleAccount>): Promise<void>
  /** calendar_id が未設定の場合だけ設定し、確定した calendar_id を返す */
  claimCalendar(calendarId: string): Promise<string>
  deleteGoogleAccount(): Promise<void>
  listMyCalendarLinks(): Promise<CalendarLink[]>
  saveCalendarLink(link: CalendarLink): Promise<void>
  deleteCalendarLink(taskId: string): Promise<void>
  deleteAllMyCalendarLinks(): Promise<void>

  /** バックアップ用: 店舗の全データをJSONで取得 */
  exportStore(storeId: string): Promise<Record<string, unknown[]>>
}
