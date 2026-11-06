import { createDemoRepo } from './demoRepo'
import type { Repo } from './repo'
import { createSupabaseRepo } from './supabaseRepo'

// 末尾の /rest/v1/ などが付いていても動くように正規化
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim().replace(/\/(rest|auth)\/v1\/?$/, '').replace(/\/$/, '')
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim()

export const repo: Repo = url && key ? createSupabaseRepo(url, key) : createDemoRepo()
