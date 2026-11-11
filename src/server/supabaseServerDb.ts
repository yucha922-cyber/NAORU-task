/**
 * ServerDb の Supabase 実装（Edge Function 内でサービスロールの supabase-js クライアントを渡す）。
 * サービスロールは RLS を通らないため、すべての処理で user_id を明示的に絞り込むこと。
 */
import type { ServerAccount, ServerDb } from './googleServer.ts'
import type { CalendarLink, Task } from '../lib/types.ts'

const TASK_SEL = '*, task_assignees(user_id,status,completed_at)'
const hm = (v: string | null | undefined) => (v ? v.slice(0, 5) : null)
// deno-lint-ignore no-explicit-any
const toTask = (r: any): Task => {
  const { task_assignees, ...t } = r
  return { ...t, due_time: hm(t.due_time), work_start: hm(t.work_start), work_end: hm(t.work_end), assignment_mode: t.assignment_mode ?? 'single', assignees: task_assignees ?? [] }
}
// deno-lint-ignore no-explicit-any
function check<T = any>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message)
  return r.data
}

// deno-lint-ignore no-explicit-any
export function createSupabaseServerDb(sb: any): ServerDb {
  const now = () => new Date().toISOString()
  return {
    async userIdFromJwt(jwt) {
      const { data, error } = await sb.auth.getUser(jwt)
      return error || !data?.user ? null : data.user.id
    },
    async cronSecret() {
      const rows = check(await sb.from('private_config').select('value').eq('key', 'cron_secret'))
      return rows[0]?.value ?? null
    },
    async getAccount(uid) {
      const rows = check(await sb.from('google_calendar_accounts').select('*').eq('user_id', uid))
      return (rows[0] as ServerAccount) ?? null
    },
    async saveAccount(uid, patch) {
      check(await sb.from('google_calendar_accounts').upsert({ ...patch, user_id: uid, updated_at: now() }))
    },
    async claimCalendar(uid, calendarId) {
      check(await sb.from('google_calendar_accounts').update({ calendar_id: calendarId }).eq('user_id', uid).is('calendar_id', null))
      const rows = check(await sb.from('google_calendar_accounts').select('calendar_id').eq('user_id', uid))
      return rows[0]?.calendar_id ?? calendarId
    },
    async deleteAccount(uid) {
      check(await sb.from('google_calendar_accounts').delete().eq('user_id', uid))
    },
    async getToken(uid) {
      const rows = check(await sb.from('google_tokens').select('enc_refresh_token, google_email').eq('user_id', uid))
      return rows[0] ?? null
    },
    async saveToken(uid, encToken, email) {
      check(await sb.from('google_tokens').upsert({ user_id: uid, enc_refresh_token: encToken, google_email: email, updated_at: now() }))
    },
    async deleteToken(uid) {
      check(await sb.from('google_tokens').delete().eq('user_id', uid))
    },
    async listLinks(uid) {
      return check(await sb.from('task_calendar_links').select('*').eq('user_id', uid).limit(5000)) as CalendarLink[]
    },
    async saveLink(uid, link) {
      check(await sb.from('task_calendar_links').upsert({ ...link, user_id: uid, updated_at: now() }))
    },
    async deleteLink(uid, taskId) {
      check(await sb.from('task_calendar_links').delete().eq('user_id', uid).eq('task_id', taskId))
    },
    async deleteAllLinks(uid) {
      check(await sb.from('task_calendar_links').delete().eq('user_id', uid))
    },
    async tasksForUser(uid) {
      const ms = check(await sb.from('memberships').select('store_id').eq('user_id', uid).eq('active', true)) as { store_id: string }[]
      if (!ms.length) return []
      const since = new Date(Date.now() - 31 * 86400000).toISOString()
      const rows = check(await sb.from('tasks').select(TASK_SEL).in('store_id', ms.map((m) => m.store_id)).is('deleted_at', null)
        .or(`status.eq.open,completed_at.gte.${since}`).limit(3000))
      return rows.map(toTask)
    },
    async tasksByIds(ids) {
      const out: Task[] = []
      for (let i = 0; i < ids.length; i += 100) out.push(...check(await sb.from('tasks').select(TASK_SEL).in('id', ids.slice(i, i + 100))).map(toTask))
      return out
    },
    async completeTask(uid, task) {
      if (task.assignment_mode !== 'single') {
        check(await sb.from('task_assignees').update({ status: 'done' }).eq('task_id', task.id).eq('user_id', uid))
      } else {
        if (task.assignee_id !== uid) throw new Error('本人の担当ではありません')
        check(await sb.from('tasks').update({ status: 'done' }).eq('id', task.id).eq('assignee_id', uid))
      }
      return toTask(check(await sb.from('tasks').select(TASK_SEL).eq('id', task.id).single()))
    },
    async accountsToSync(staleMinutes, limit, onlyUsers) {
      let q = sb.from('google_calendar_accounts').select('user_id').eq('server_sync', true).neq('status', 'disconnected')
      if (Number.isFinite(staleMinutes)) {
        const stale = new Date(Date.now() - staleMinutes * 60000).toISOString()
        q = q.or(`needs_sync.eq.true,last_sync_at.is.null,last_sync_at.lt.${stale}`)
      } else q = q.eq('needs_sync', true)
      if (onlyUsers) q = q.in('user_id', onlyUsers.length ? onlyUsers : ['00000000-0000-0000-0000-000000000000'])
      const rows = check(await q.order('last_sync_at', { ascending: true, nullsFirst: true }).limit(limit)) as { user_id: string }[]
      return rows.map((r) => r.user_id)
    },
    async usersInSameStores(uid) {
      const ms = check(await sb.from('memberships').select('store_id').eq('user_id', uid).eq('active', true)) as { store_id: string }[]
      if (!ms.length) return []
      const rows = check(await sb.from('memberships').select('user_id').in('store_id', ms.map((m) => m.store_id)).eq('active', true)) as { user_id: string }[]
      return [...new Set(rows.map((r) => r.user_id))]
    },
  }
}
