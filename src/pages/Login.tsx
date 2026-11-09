import { useState } from 'react'
import { repo } from '../lib/client'
import { DEMO_USERS, resetDemo } from '../lib/demoRepo'
import { ROLE_LABEL } from '../lib/types'

export function Login() {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg(null)
    try {
      if (mode === 'in') await repo.signIn(email, password)
      else {
        if (password.length < 8) throw new Error('パスワードは8文字以上にしてください')
        await repo.signUp(email, password, name)
        setMsg('確認メールを送信しました。メール内のリンクを開いた後にログインしてください。')
        setMode('in')
      }
    } catch (err) { setMsg((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <div className="mb-10 text-center">
        <div className="text-2xl font-semibold tracking-[0.25em]">NAORU<span className="text-gold"> TASK</span></div>
        <div className="mt-2 text-xs tracking-widest text-neutral-400">整体院のためのタスク管理</div>
      </div>

      {repo.mode === 'demo' ? (
        <div className="space-y-3">
          <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">
            デモモードで動作中です（Supabase未設定）。データはこのブラウザ内にのみ保存され、外部には送信されません。
          </p>
          {DEMO_USERS.map((u) => (
            <button key={u.email} className="btn-ghost w-full justify-between" onClick={() => repo.signIn(u.email, '')}>
              <span>{u.name}</span><span className="text-xs text-neutral-400">{ROLE_LABEL[u.role]}としてログイン</span>
            </button>
          ))}
          <button className="w-full pt-2 text-xs text-neutral-400 underline" onClick={() => { resetDemo(); location.reload() }}>デモデータを初期化</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          {mode === 'up' && (
            <div><label className="label">表示名</label><input className="field" value={name} onChange={(e) => setName(e.target.value)} required maxLength={50} placeholder="例：佐藤" /></div>
          )}
          <div><label className="label">メールアドレス</label><input type="email" className="field" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></div>
          <div><label className="label">パスワード</label><input type="password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={mode === 'in' ? 'current-password' : 'new-password'} /></div>
          {msg && <p className="text-sm text-red-600">{msg}</p>}
          <button className="btn-primary w-full" disabled={busy}>{mode === 'in' ? 'ログイン' : 'アカウント登録'}</button>
          <button type="button" className="w-full text-sm text-neutral-500" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
            {mode === 'in' ? 'はじめての方はこちら（アカウント登録）' : 'ログイン画面に戻る'}
          </button>
        </form>
      )}
      <a href={`${import.meta.env.BASE_URL}privacy.html`} className="mt-10 text-center text-xs text-neutral-400 underline">プライバシーポリシー</a>
    </div>
  )
}

export function NoStore() {
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-lg font-semibold">所属店舗がありません</h1>
      <p className="text-sm leading-relaxed text-neutral-500">スタッフの方は、院長・管理者に登録メールアドレスを伝え、店舗への追加を依頼してください。追加後に再読み込みしてください。</p>
      <div className="card space-y-2 p-4">
        <div className="text-xs text-neutral-500">管理者の方：新しい店舗を作成</div>
        <input className="field" placeholder="例：NAORU整体 渋谷院" value={name} onChange={(e) => setName(e.target.value)} />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button className="btn-primary w-full" disabled={!name.trim()} onClick={async () => {
          try { await repo.createStore(name.trim()); location.reload() } catch (e) { setErr((e as Error).message) }
        }}>店舗を作成</button>
      </div>
      <button className="btn-ghost" onClick={() => location.reload()}>再読み込み</button>
      <button className="text-sm text-neutral-400" onClick={() => repo.signOut()}>ログアウト</button>
    </div>
  )
}
