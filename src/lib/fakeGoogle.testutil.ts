/** テスト用の偽 Google（Calendar API・OAuth トークン・userinfo）。calendar.app.created と同じく作成者のカレンダーしか見えない */
interface GEvent { body: Record<string, unknown>; status: 'confirmed' | 'cancelled' }
export class FakeGoogle {
  calendars = new Map<string, { owner: string; events: Map<string, GEvent> }>()
  tokens = new Map<string, { email: string; expired?: boolean }>()
  calls = 0
  codes = new Map<string, { email: string; scope: string; noRefresh?: boolean }>()
  refreshTokens = new Map<string, string>()
  failNext: { status: number; body?: string; count: number } | null = null
  seq = 0

  events(email: string) {
    const out: { cal: string; id: string; summary: string; status: string }[] = []
    for (const [cid, c] of this.calendars) if (c.owner === email) for (const [id, e] of c.events) out.push({ cal: cid, id, summary: String(e.body.summary), status: e.status })
    return out
  }
  live(email: string) { return this.events(email).filter((e) => e.status === 'confirmed') }
  /** Google カレンダー上での見え方（date があれば終日として表示される） */
  shownAs(email: string) {
    return [...this.calendars.values()].filter((c) => c.owner === email).flatMap((c) => [...c.events.values()]).map((e) => {
      const st = e.body.start as { date?: string; dateTime?: string }
      return st.date ? `終日 ${st.date}` : `時間 ${st.dateTime}`
    })
  }

  fetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    this.calls++
    const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })
    if (this.failNext && this.failNext.count > 0) { this.failNext.count--; return new Response(this.failNext.body ?? '{}', { status: this.failNext.status }) }
    const u = new URL(url)
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const p = new URLSearchParams(init.body ?? '')
      if (p.get('client_secret') !== 'secret') return res(401, { error: 'invalid_client' })
      if (p.get('grant_type') === 'authorization_code') {
        const g = this.codes.get(p.get('code') ?? '')
        if (!g) return res(400, { error: 'invalid_grant' })
        this.codes.delete(p.get('code')!)
        const access = `acc-${++this.seq}`
        this.tokens.set(access, { email: g.email })
        const refresh = `ref-${g.email}-${this.seq}`
        this.refreshTokens.set(refresh, g.email)
        return res(200, { access_token: access, expires_in: 3600, scope: g.scope, ...(g.noRefresh ? {} : { refresh_token: refresh }) })
      }
      if (p.get('grant_type') === 'refresh_token') {
        const email = this.refreshTokens.get(p.get('refresh_token') ?? '')
        if (!email) return res(400, { error: 'invalid_grant' })
        const access = `acc-${++this.seq}`
        this.tokens.set(access, { email })
        return res(200, { access_token: access, expires_in: 3600 })
      }
    }
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/revoke') {
      this.refreshTokens.delete(u.searchParams.get('token') ?? '')
      return res(200, {})
    }
    if (u.pathname === '/oauth2/v3/userinfo') {
      const t = this.tokens.get((init.headers?.Authorization ?? '').replace('Bearer ', ''))
      return t ? res(200, { email: t.email }) : res(401, {})
    }
    const tok = this.tokens.get((init.headers?.Authorization ?? '').replace('Bearer ', ''))
    if (!tok || tok.expired) return res(401, { error: { code: 401 } })
    const me = tok.email
    const path = new URL(url).pathname.replace('/calendar/v3', '')
    const m = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent) // calendars, {cid}, events, {eid}
    if (m === 'POST' && parts.length === 1) {
      const id = `cal-${++this.seq}@group.calendar.google.com`
      this.calendars.set(id, { owner: me, events: new Map() })
      return res(200, { id })
    }
    const c = this.calendars.get(parts[1])
    if (!c || c.owner !== me) return res(404, { error: { code: 404, message: 'Not Found' } }) // 他人のカレンダーは存在しないのと同じ
    if (parts.length === 2) {
      if (m === 'GET') return res(200, { id: parts[1] })
      if (m === 'DELETE') { this.calendars.delete(parts[1]); return res(204) }
    }
    if (parts.length === 3 && m === 'GET') {
      const items = [...c.events.entries()].filter(([, e]) => e.status === 'confirmed').map(([id, e]) => ({ id, summary: e.body.summary, colorId: e.body.colorId ?? undefined, extendedProperties: e.body.extendedProperties }))
      return res(200, { items })
    }
    if (parts.length === 3 && m === 'POST') {
      if (c.events.has(body.id)) return res(409, { error: { code: 409, message: 'The requested identifier already exists.' } })
      c.events.set(body.id, { body, status: 'confirmed' })
      return res(200, { id: body.id })
    }
    const ev = c.events.get(parts[3])
    if (m === 'PUT') {
      // 本物と同じ: 送られた内容で丸ごと置き換え（送らなかった項目は消える）
      if (!ev) return res(404, {})
      c.events.set(parts[3], { body: { ...body }, status: body.status ?? 'confirmed' })
      return res(200, { id: parts[3] })
    }
    if (m === 'PATCH') {
      if (!ev) return res(404, {})
      // 本物の Google と同じ PATCH の動き: 入れ子のオブジェクト（start/end）は項目単位でマージ、null は削除
      const merged: Record<string, unknown> = { ...ev.body }
      for (const [k, v] of Object.entries(body)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object') {
          const o: Record<string, unknown> = { ...(merged[k] as object) }
          for (const [k2, v2] of Object.entries(v as object)) { if (v2 === null) delete o[k2]; else o[k2] = v2 }
          merged[k] = o
        } else if (v === null) delete merged[k]
        else merged[k] = v
      }
      c.events.set(parts[3], { body: merged, status: body.status ?? ev.status })
      return res(200, { id: parts[3] })
    }
    if (m === 'DELETE') {
      if (!ev) return res(404, {})
      if (ev.status === 'cancelled') return res(410, {})
      ev.status = 'cancelled'
      return res(204)
    }
    return res(400, {})
  }
}

