/**
 * デモモード（Supabase未設定時）。ブラウザの localStorage のみで動作し、外部通信は一切しない。
 * 権限ルールは Supabase の RLS と同等の簡易チェックを行う（本番の安全性は RLS が担保）。
 */
import type { Repo, SessionUser } from './repo'
import type { Activity, ActivityAction, CalendarLink, GoogleAccount, Member, Membership, Profile, Role, Store, Task, TaskTemplate } from './types'
import { addDays, todayStr } from './dates'
import { pendingOccurrences } from './recurrence'

interface DB {
  stores: Store[]
  profiles: Profile[]
  memberships: Membership[]
  tasks: Task[]
  templates: TaskTemplate[]
  activity: Activity[]
  links: CalendarLink[]
  gaccounts?: GoogleAccount[]
  invitations?: { store_id: string; email: string; role: Role; created_at: string }[]
  session: string | null
}

const KEY = 'naoru-task-demo-v1'
const uuid = () => crypto.randomUUID()
const now = () => new Date().toISOString()

export const DEMO_USERS = [
  { email: 'incho@demo.naoru', name: '山田 院長', role: 'admin' as Role },
  { email: 'sato@demo.naoru', name: '佐藤', role: 'staff' as Role },
  { email: 'suzuki@demo.naoru', name: '鈴木', role: 'staff' as Role },
]

function seed(): DB {
  const store: Store = { id: uuid(), name: 'NAORU整体 渋谷院', timezone: 'Asia/Tokyo' }
  const profiles = DEMO_USERS.map((u) => ({ id: uuid(), email: u.email, display_name: u.name }))
  const memberships = DEMO_USERS.map((u, i) => ({ id: uuid(), store_id: store.id, user_id: profiles[i].id, role: u.role, active: true }))
  const today = todayStr()
  const [boss, sato, suzuki] = profiles
  const mk = (p: Partial<Task>): Task => ({
    id: uuid(), store_id: store.id, parent_id: null, title: '', description: '', assignee_id: null, priority: 'medium',
    category: 'general', due_date: today, due_time: null, status: 'open', completed_at: null, completed_by: null,
    template_id: null, occurrence_date: null, created_by: boss.id, created_at: now(), updated_at: now(), deleted_at: null,
    assignment_mode: 'single', color_id: null, work_date: null, work_start: null, work_end: null, assignees: [], ...p,
  })
  const parent = mk({ title: '広告動画を1本制作する', assignee_id: sato.id, priority: 'high', due_date: addDays(today, 5) })
  const subs = ['企画完了', '動画撮影完了', '動画編集完了', '音声追加完了', '最終確認完了'].map((title, i) =>
    mk({ title, parent_id: parent.id, assignee_id: sato.id, due_date: addDays(today, i), ...(i < 2 ? { status: 'done', completed_at: now(), completed_by: sato.id } : {}) }),
  )
  const tasks = [
    parent, ...subs,
    mk({ title: '回数券の在庫確認', assignee_id: suzuki.id, due_date: addDays(today, -1), priority: 'high' }),
    mk({ title: '新人研修資料の更新', assignee_id: boss.id, due_date: addDays(today, 3) }),
  ]
  const tpl = (p: Partial<TaskTemplate>): TaskTemplate => ({
    id: uuid(), store_id: store.id, title: '', description: '', assignee_id: null, priority: 'medium', category: 'general',
    frequency: 'daily', interval_days: null, weekdays: [], day_of_month: null, due_time: null,
    start_date: addDays(today, -2), end_date: null, last_generated_date: null, active: true, assignment_mode: 'single', color_id: null, ...p,
  })
  const templates = [
    tpl({ title: 'カルテ入力', category: 'karte', assignee_id: sato.id, due_time: '21:00' }),
    tpl({ title: 'カルテ入力', category: 'karte', assignee_id: suzuki.id, due_time: '21:00' }),
    tpl({ title: '日報提出', category: 'daily_report', assignment_mode: 'everyone', due_time: '22:00' }),
    tpl({ title: '店内清掃', category: 'cleaning' }),
    tpl({ title: 'HPBブログ投稿', category: 'blog', frequency: 'interval', interval_days: 3, assignee_id: suzuki.id }),
    tpl({ title: '週次ミーティング準備', frequency: 'weekly', weekdays: [1], assignee_id: boss.id }),
    tpl({ title: '月次報告', category: 'report', frequency: 'monthly', day_of_month: 31, assignee_id: boss.id }),
  ]
  return { stores: [store], profiles, memberships, tasks, templates, activity: [], links: [], session: null }
}

export function createDemoRepo(): Repo {
  let db: DB = (() => {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) {
        const d = JSON.parse(raw) as DB
        // 旧バージョンのデモデータを新しい形式に補完（既存データは保持）
        d.tasks = d.tasks.map((t) => Object.assign({ assignment_mode: 'single', color_id: null, work_date: null, work_start: null, work_end: null, assignees: [] }, t))
        d.templates = d.templates.map((t) => Object.assign({ assignment_mode: 'single', color_id: null }, t))
        d.gaccounts ??= []
        return d
      }
    } catch { /* 破損時は初期化 */ }
    return seed()
  })()
  const save = () => localStorage.setItem(KEY, JSON.stringify(db))
  save()
  const listeners = new Set<(u: SessionUser | null) => void>()
  const user = (): SessionUser | null => {
    const p = db.profiles.find((x) => x.id === db.session)
    return p ? { id: p.id, email: p.email } : null
  }
  const me = () => {
    const u = user()
    if (!u) throw new Error('ログインが必要です')
    return u.id
  }
  const role = (storeId: string) => db.memberships.find((m) => m.store_id === storeId && m.user_id === db.session && m.active)?.role
  const isManager = (storeId: string) => ['manager', 'admin'].includes(role(storeId) ?? '')
  const requireMember = (storeId: string) => { if (!role(storeId)) throw new Error('権限がありません') }
  const findTask = (id: string) => {
    const t = db.tasks.find((x) => x.id === id && !x.deleted_at)
    if (!t) throw new Error('タスクが見つかりません')
    return t
  }
  const everyoneRows = (storeId: string) =>
    db.memberships.filter((m) => m.store_id === storeId && m.active).map((m) => ({ user_id: m.user_id, status: 'open' as const, completed_at: null }))
  const canEdit = (t: Task) => isManager(t.store_id) || t.assignee_id === db.session || t.assignee_id === null || t.created_by === db.session
  const log = (t: Task, action: ActivityAction, changes: Record<string, unknown> = {}) =>
    db.activity.unshift({ id: uuid(), store_id: t.store_id, task_id: t.id, task_title: t.title, actor_id: db.session, action, changes, created_at: now() })
  const notify = () => listeners.forEach((l) => l(user()))

  const repo: Repo = {
    mode: 'demo',
    async getUser() { return user() },
    onAuthChange(cb) { listeners.add(cb); return () => listeners.delete(cb) },
    async signIn(email) {
      const p = db.profiles.find((x) => x.email === email.trim().toLowerCase())
      if (!p) throw new Error('デモユーザーが見つかりません')
      db.session = p.id; save(); notify()
    },
    async signUp() { throw new Error('デモモードでは新規登録できません') },
    async signOut() { db.session = null; save(); notify() },

    async myStores() {
      return db.memberships.filter((m) => m.user_id === db.session && m.active)
        .map((m) => ({ store: db.stores.find((s) => s.id === m.store_id)!, role: m.role }))
    },
    async createStore(name) {
      const s: Store = { id: uuid(), name, timezone: 'Asia/Tokyo' }
      db.stores.push(s)
      db.memberships.push({ id: uuid(), store_id: s.id, user_id: me(), role: 'admin', active: true })
      save(); return s.id
    },
    async listMembers(storeId) {
      requireMember(storeId)
      return db.memberships.filter((m) => m.store_id === storeId)
        .map((m) => ({ ...m, profile: db.profiles.find((p) => p.id === m.user_id)! })) as Member[]
    },
    async addMember(storeId, email, r) {
      if (role(storeId) !== 'admin') throw new Error('権限がありません')
      const em = email.trim().toLowerCase()
      const p = db.profiles.find((x) => x.email === em)
      if (!p) {
        db.invitations = (db.invitations ?? []).filter((i) => !(i.store_id === storeId && i.email === em))
        db.invitations.push({ store_id: storeId, email: em, role: r, created_at: now() })
        save(); return 'invited'
      }
      const m = db.memberships.find((x) => x.store_id === storeId && x.user_id === p.id)
      if (m) { m.role = r; m.active = true } else db.memberships.push({ id: uuid(), store_id: storeId, user_id: p.id, role: r, active: true })
      save(); return 'added'
    },
    async listInvitations(storeId) {
      return (db.invitations ?? []).filter((i) => i.store_id === storeId).map(({ email, role, created_at }) => ({ email, role, created_at }))
    },
    async cancelInvitation(storeId, email) {
      if (role(storeId) !== 'admin') throw new Error('権限がありません')
      db.invitations = (db.invitations ?? []).filter((i) => !(i.store_id === storeId && i.email === email)); save()
    },
    async updateMember(id, patch) {
      const m = db.memberships.find((x) => x.id === id)
      if (!m || role(m.store_id) !== 'admin' || m.user_id === db.session) throw new Error('権限がありません')
      Object.assign(m, patch); save()
    },
    async updateMyName(name) {
      const p = db.profiles.find((x) => x.id === me())!
      p.display_name = name; save()
    },

    async listTasks(storeId, recentDays) {
      requireMember(storeId)
      const since = new Date(Date.now() - recentDays * 86400000).toISOString()
      return db.tasks.filter((t) => t.store_id === storeId && !t.deleted_at && (t.status === 'open' || (t.completed_at ?? '') >= since))
    },
    async listHistory(storeId, offset, limit) {
      requireMember(storeId)
      return db.tasks.filter((t) => t.store_id === storeId && !t.deleted_at && t.status === 'done')
        .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? '')).slice(offset, offset + limit)
    },
    async createTask(storeId, input) {
      requireMember(storeId)
      if (input.assignee_id && input.assignee_id !== db.session && !isManager(storeId)) throw new Error('他のスタッフへの割り当ては院長・管理者のみ可能です')
      if (input.parent_id) {
        const p = findTask(input.parent_id)
        if (p.parent_id) throw new Error('親子タスクは2階層までです')
      }
      if (input.assignment_mode === 'everyone' && input.assignee_id) throw new Error('全員向けタスクには担当者を指定できません')
      const t: Task = {
        id: uuid(), store_id: storeId, status: 'open', completed_at: null, completed_by: null, template_id: null, occurrence_date: null,
        created_by: me(), created_at: now(), updated_at: now(), deleted_at: null, ...input,
        assignees: input.assignment_mode === 'everyone' ? everyoneRows(storeId) : [],
      }
      db.tasks.push(t); log(t, 'create'); save(); return t
    },
    async updateTask(id, patch) {
      const t = findTask(id)
      if (!canEdit(t)) throw new Error('権限がありません')
      if (patch.assignee_id && patch.assignee_id !== db.session && !isManager(t.store_id)) throw new Error('他のスタッフへの割り当ては院長・管理者のみ可能です')
      const changes: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(patch)) {
        const old = (t as unknown as Record<string, unknown>)[k]
        if (old !== v) changes[k] = { from: old, to: v }
      }
      if (patch.assignment_mode && patch.assignment_mode !== t.assignment_mode) {
        t.assignees = patch.assignment_mode === 'everyone' ? everyoneRows(t.store_id) : []
      }
      Object.assign(t, patch, { updated_at: now() })
      if (Object.keys(changes).length) log(t, 'update', changes)
      save(); return t
    },
    async setDone(id, done) {
      const t = findTask(id)
      if (!canEdit(t)) throw new Error('権限がありません')
      if ((t.status === 'done') === done) return t
      Object.assign(t, done ? { status: 'done', completed_at: now(), completed_by: db.session } : { status: 'open', completed_at: null, completed_by: null }, { updated_at: now() })
      log(t, done ? 'complete' : 'reopen'); save(); return t
    },
    async setMyDone(id, done) {
      const t = findTask(id)
      const row = t.assignees.find((a) => a.user_id === db.session)
      if (!row) throw new Error('このタスクの担当に含まれていません')
      Object.assign(row, done ? { status: 'done', completed_at: now() } : { status: 'open', completed_at: null })
      log(t, done ? 'complete' : 'reopen', { assignee: db.session })
      const allDone = t.assignees.every((a) => a.status === 'done')
      if (allDone && t.status === 'open') Object.assign(t, { status: 'done', completed_at: now(), completed_by: db.session })
      if (!allDone && t.status === 'done') Object.assign(t, { status: 'open', completed_at: null, completed_by: null })
      save(); return t
    },
    async getTasksByIds(ids) { return db.tasks.filter((t) => ids.includes(t.id)) },
    async deleteTask(id) {
      const t = findTask(id)
      if (!canEdit(t)) throw new Error('権限がありません')
      for (const c of db.tasks.filter((x) => x.parent_id === id && !x.deleted_at)) { c.deleted_at = now(); log(c, 'delete') }
      t.deleted_at = now(); log(t, 'delete'); save()
    },

    async listTemplates(storeId) { requireMember(storeId); return db.templates.filter((t) => t.store_id === storeId) },
    async saveTemplate(storeId, input, id) {
      if (!isManager(storeId)) throw new Error('権限がありません')
      if (id) Object.assign(db.templates.find((t) => t.id === id)!, input)
      else db.templates.push({ id: uuid(), store_id: storeId, last_generated_date: null, ...input })
      save()
    },
    async deleteTemplate(id) {
      const t = db.templates.find((x) => x.id === id)!
      if (!isManager(t.store_id)) throw new Error('権限がありません')
      t.active = false; save()
    },
    async generateRecurring(storeId) {
      requireMember(storeId)
      const today = todayStr()
      const until = addDays(today, 1)
      let n = 0
      for (const tpl of db.templates.filter((t) => t.store_id === storeId && t.active)) {
        for (const d of pendingOccurrences(tpl, today, until)) {
          if (db.tasks.some((t) => t.template_id === tpl.id && t.occurrence_date === d)) continue // 二重生成防止
          const t: Task = {
            id: uuid(), store_id: storeId, parent_id: null, title: tpl.title, description: tpl.description, assignee_id: tpl.assignee_id,
            priority: tpl.priority, category: tpl.category, due_date: d, due_time: tpl.due_time, status: 'open', completed_at: null,
            completed_by: null, template_id: tpl.id, occurrence_date: d, created_by: me(), created_at: now(), updated_at: now(), deleted_at: null,
            assignment_mode: tpl.assignment_mode, color_id: tpl.color_id ?? null, work_date: null, work_start: null, work_end: null,
            assignees: tpl.assignment_mode === 'everyone' ? everyoneRows(storeId) : [],
          }
          if (tpl.assignment_mode === 'everyone') t.assignee_id = null
          db.tasks.push(t); n++
        }
        if (!tpl.last_generated_date || tpl.last_generated_date < until) tpl.last_generated_date = until
      }
      save(); return n
    },

    async listActivity(storeId, limit) { requireMember(storeId); return db.activity.filter((a) => a.store_id === storeId).slice(0, limit) },
    async getGoogleAccount() { return db.gaccounts?.find((a) => a.user_id === db.session) ?? null },
    async saveGoogleAccount(patch) {
      const list = (db.gaccounts ??= [])
      const cur = list.find((a) => a.user_id === me())
      if (cur) Object.assign(cur, patch)
      else list.push({ user_id: me(), google_email: null, calendar_id: null, status: 'active', last_sync_at: null, last_success_count: 0, last_failure_count: 0, last_error: null, ...patch })
      save()
    },
    async claimCalendar(calendarId) {
      const cur = db.gaccounts?.find((a) => a.user_id === me())
      if (cur && !cur.calendar_id) { cur.calendar_id = calendarId; save() }
      return cur?.calendar_id ?? calendarId
    },
    async deleteGoogleAccount() { db.gaccounts = (db.gaccounts ?? []).filter((a) => a.user_id !== me()); save() },
    async listMyCalendarLinks() { return db.links.filter((l) => l.user_id === db.session) },
    async saveCalendarLink(link) {
      if (link.user_id !== me()) throw new Error('権限がありません')
      db.links = db.links.filter((l) => !(l.task_id === link.task_id && l.user_id === link.user_id)).concat(link); save()
    },
    async deleteCalendarLink(taskId) { db.links = db.links.filter((l) => !(l.task_id === taskId && l.user_id === db.session)); save() },
    async deleteAllMyCalendarLinks() { db.links = db.links.filter((l) => l.user_id !== db.session); save() },
    async exportStore(storeId) {
      requireMember(storeId)
      return {
        stores: db.stores.filter((s) => s.id === storeId),
        memberships: db.memberships.filter((m) => m.store_id === storeId),
        tasks: db.tasks.filter((t) => t.store_id === storeId),
        task_templates: db.templates.filter((t) => t.store_id === storeId),
        task_activity: db.activity.filter((a) => a.store_id === storeId),
      }
    },
  }
  return repo
}

export function resetDemo() {
  localStorage.removeItem(KEY)
}
