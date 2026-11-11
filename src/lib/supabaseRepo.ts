import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ServerUnavailableError, type Repo, type SessionUser } from './repo'
import type { Activity, CalendarLink, GoogleAccount, Invitation, Member, Role, Store, Task, TaskTemplate } from './types'

const JA: [RegExp, string][] = [
  [/Invalid login credentials/i, 'メールアドレスまたはパスワードが違います'],
  [/User already registered/i, 'このメールアドレスは既に登録されています。ログインしてください'],
  [/Password should be at least/i, 'パスワードが短すぎます（8文字以上にしてください）'],
  [/Email not confirmed/i, 'メールアドレスの確認が完了していません'],
  [/rate limit/i, '短時間に操作が集中しました。しばらく待ってから再度お試しください'],
  [/Failed to fetch|NetworkError/i, '通信できませんでした。電波状況を確認してください'],
]
const ja = (m: string) => JA.find(([r]) => r.test(m))?.[1] ?? m

function check<T>(r: { data: T; error: { message: string } | null } | { data: unknown; error: { message: string } }): T {
  if (r.error) throw new Error(ja(r.error.message))
  return r.data as T
}

const hm = (v: string | null | undefined) => (v ? v.slice(0, 5) : null)
const trimTime = <T extends { due_time: string | null }>(t: T): T => ({ ...t, due_time: hm(t.due_time) })
/** タスクと全員向けの完了状態を1クエリで取得（0002 未適用のDBでは '*' にフォールバック） */
let TASK_SEL = '*, task_assignees(user_id,status,completed_at)'
type TaskRow = Task & { task_assignees?: Task['assignees'] }
const toTask = (r: TaskRow): Task => {
  const { task_assignees, ...t } = r
  return { ...t, due_time: hm(t.due_time), work_start: hm(t.work_start), work_end: hm(t.work_end), assignment_mode: t.assignment_mode ?? 'single', assignees: task_assignees ?? [] }
}

export function createSupabaseRepo(url: string, key: string): Repo {
  const sb: SupabaseClient = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } })
  const toUser = (u: { id: string; email?: string } | null | undefined): SessionUser | null => (u ? { id: u.id, email: u.email ?? '' } : null)
  const uid = async () => {
    const { data } = await sb.auth.getSession()
    if (!data.session) throw new Error('ログインが必要です')
    return data.session.user.id
  }

  return {
    mode: 'supabase',
    async getUser() {
      const { data } = await sb.auth.getSession()
      return toUser(data.session?.user)
    },
    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_e, s) => cb(toUser(s?.user)))
      return () => data.subscription.unsubscribe()
    },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }))
    },
    async signUp(email, password, displayName) {
      check(await sb.auth.signUp({ email, password, options: { data: { display_name: displayName } } }))
    },
    async signOut() {
      await sb.auth.signOut()
    },

    async myStores() {
      const me = await uid()
      const rows = check(await sb.from('memberships').select('role, store:stores(id,name,timezone)').eq('user_id', me).eq('active', true))
      return (rows as unknown as { role: Role; store: Store }[]).map((r) => ({ store: r.store, role: r.role }))
    },
    async createStore(name) {
      return check(await sb.rpc('create_store', { p_name: name })) as string
    },
    async listMembers(storeId) {
      const rows = check(await sb.from('memberships').select('*, profile:profiles(id,email,display_name)').eq('store_id', storeId))
      return rows as Member[]
    },
    async addMember(storeId, email, role) {
      const r = await sb.rpc('invite_member', { p_store: storeId, p_email: email, p_role: role })
      if (r.error && /invite_member|function/i.test(r.error.message) && /find|exist/i.test(r.error.message)) {
        // 0004 未適用のDBでは従来どおり（登録済みユーザーのみ追加）
        check(await sb.rpc('add_member_by_email', { p_store: storeId, p_email: email, p_role: role }))
        return 'added'
      }
      return check(r) as 'added' | 'invited'
    },
    async listInvitations(storeId) {
      const r = await sb.from('store_invitations').select('email, role, created_at').eq('store_id', storeId).order('created_at')
      return r.error ? [] : (r.data as Invitation[]) // 0004 未適用なら空
    },
    async cancelInvitation(storeId, email) {
      check(await sb.from('store_invitations').delete().eq('store_id', storeId).eq('email', email))
    },
    async updateMember(id, patch) {
      check(await sb.from('memberships').update(patch).eq('id', id))
    },
    async updateMyName(name) {
      check(await sb.from('profiles').update({ display_name: name }).eq('id', await uid()))
    },

    async listTasks(storeId, recentDays) {
      const since = new Date(Date.now() - recentDays * 86400000).toISOString()
      if (TASK_SEL !== '*') {
        const probe = await sb.from('tasks').select(TASK_SEL).limit(1)
        if (probe.error && /task_assignees|relationship/i.test(probe.error.message)) TASK_SEL = '*' // マイグレーション未適用でも既存機能は動かす
      }
      // 1クエリで取得（未完了 or 直近完了）。通信量を抑えるため必要件数に上限
      const rows = check(
        await sb.from('tasks').select(TASK_SEL).eq('store_id', storeId).is('deleted_at', null)
          .or(`status.eq.open,completed_at.gte.${since}`).order('due_date', { ascending: true, nullsFirst: false }).limit(2000),
      )
      return (rows as unknown as TaskRow[]).map(toTask)
    },
    async listHistory(storeId, offset, limit) {
      const rows = check(
        await sb.from('tasks').select(TASK_SEL).eq('store_id', storeId).eq('status', 'done').is('deleted_at', null)
          .order('completed_at', { ascending: false }).range(offset, offset + limit - 1),
      )
      return (rows as unknown as TaskRow[]).map(toTask)
    },
    async createTask(storeId, input) {
      const row = check(await sb.from('tasks').insert({ ...input, store_id: storeId, created_by: await uid() }).select(TASK_SEL).single())
      return toTask(row as unknown as TaskRow)
    },
    async updateTask(id, patch) {
      return toTask(check(await sb.from('tasks').update(patch).eq('id', id).select(TASK_SEL).single()) as unknown as TaskRow)
    },
    async setDone(id, done) {
      return toTask(check(await sb.from('tasks').update({ status: done ? 'done' : 'open' }).eq('id', id).select(TASK_SEL).single()) as unknown as TaskRow)
    },
    async setMyDone(id, done) {
      const me = await uid()
      const rows = check(await sb.from('task_assignees').update({ status: done ? 'done' : 'open' }).eq('task_id', id).eq('user_id', me).select('task_id')) as unknown[]
      if (!rows.length) throw new Error('このタスクの担当に含まれていません')
      return toTask(check(await sb.from('tasks').select(TASK_SEL).eq('id', id).single()) as unknown as TaskRow)
    },
    async setAssignees(id, userIds) {
      check(await sb.rpc('set_task_assignees', { p_task: id, p_users: userIds }))
    },
    async getTasksByIds(ids) {
      const out: Task[] = []
      for (let i = 0; i < ids.length; i += 100) {
        const rows = check(await sb.from('tasks').select(TASK_SEL).in('id', ids.slice(i, i + 100))) as unknown as TaskRow[]
        out.push(...rows.map(toTask))
      }
      return out
    },
    async deleteTask(id) {
      const now = new Date().toISOString()
      check(await sb.from('tasks').update({ deleted_at: now }).eq('parent_id', id))
      check(await sb.from('tasks').update({ deleted_at: now }).eq('id', id))
    },

    async listTemplates(storeId) {
      const rows = check(await sb.from('task_templates').select('*').eq('store_id', storeId).order('created_at'))
      return (rows as TaskTemplate[]).map(trimTime)
    },
    async saveTemplate(storeId, input, id) {
      if (id) check(await sb.from('task_templates').update(input).eq('id', id))
      else check(await sb.from('task_templates').insert({ ...input, store_id: storeId, created_by: await uid() }))
    },
    async deleteTemplate(id) {
      // 生成済みタスクは残し、テンプレートは停止扱い（履歴保全）
      check(await sb.from('task_templates').update({ active: false }).eq('id', id))
    },
    async generateRecurring(storeId) {
      return check(await sb.rpc('generate_recurring_tasks', { p_store: storeId })) as number
    },

    async listActivity(storeId, limit) {
      return check(await sb.from('task_activity').select('*').eq('store_id', storeId).order('created_at', { ascending: false }).limit(limit)) as Activity[]
    },

    async getGoogleAccount() {
      const rows = check(await sb.from('google_calendar_accounts').select('*').eq('user_id', await uid())) as GoogleAccount[]
      return rows[0] ?? null
    },
    async saveGoogleAccount(patch) {
      check(await sb.from('google_calendar_accounts').upsert({ ...patch, user_id: await uid(), updated_at: new Date().toISOString() }))
    },
    async claimCalendar(calendarId) {
      const me = await uid()
      check(await sb.from('google_calendar_accounts').update({ calendar_id: calendarId }).eq('user_id', me).is('calendar_id', null))
      const rows = check(await sb.from('google_calendar_accounts').select('calendar_id').eq('user_id', me)) as { calendar_id: string }[]
      return rows[0]?.calendar_id ?? calendarId
    },
    async deleteGoogleAccount() {
      check(await sb.from('google_calendar_accounts').delete().eq('user_id', await uid()))
    },
    async listMyCalendarLinks() {
      return check(await sb.from('task_calendar_links').select('*').eq('user_id', await uid()).limit(5000)) as CalendarLink[]
    },
    async saveCalendarLink(link) {
      check(await sb.from('task_calendar_links').upsert({ ...link, updated_at: new Date().toISOString() }))
    },
    async deleteCalendarLink(taskId) {
      check(await sb.from('task_calendar_links').delete().eq('task_id', taskId).eq('user_id', await uid()))
    },
    async googleServer(action, payload = {}) {
      const { data, error } = await sb.functions.invoke('naoru-google', { body: { action, ...payload } })
      if (error) {
        const ctx = (error as { context?: Response }).context
        const status = ctx?.status
        if (status === 404 || (!status && /Failed to send|fetch/i.test(error.message))) throw new ServerUnavailableError('server unavailable')
        let msg = error.message
        try { const j = await ctx?.json(); if (j?.error) msg = j.error } catch { /* 本文なし */ }
        throw new Error(msg)
      }
      return data as Record<string, unknown>
    },
    async savePushSubscription(sub) {
      check(await sb.from('push_subscriptions').upsert({ ...sub, user_id: await uid(), user_agent: navigator.userAgent.slice(0, 200) }))
    },
    async deletePushSubscription(endpoint) {
      check(await sb.from('push_subscriptions').delete().eq('endpoint', endpoint))
    },
    async deleteAllMyCalendarLinks() {
      check(await sb.from('task_calendar_links').delete().eq('user_id', await uid()))
    },

    async exportStore(storeId) {
      const out: Record<string, unknown[]> = {}
      for (const t of ['stores', 'memberships', 'tasks', 'task_assignees', 'task_templates', 'task_activity'] as const) {
        const col = t === 'stores' ? 'id' : 'store_id'
        const all: unknown[] = []
        for (let from = 0; ; from += 1000) {
          const rows = check(await sb.from(t).select('*').eq(col, storeId).range(from, from + 999)) as unknown[]
          all.push(...rows)
          if (rows.length < 1000) break
        }
        out[t] = all
      }
      return out
    },
  }
}
