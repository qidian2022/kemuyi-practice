import { createClient, type Session, type SupabaseClient, type AuthChangeEvent } from '@supabase/supabase-js'
import type { PracticeData } from './practice.ts'
import type { RemoteProgress } from './account.ts'

export type AccountSession = { user: { id: string; username: string } }
export const AUTH_STORAGE_PREFIX = 'kemuyi-supabase-auth-v1'
export const USERNAME_DOMAIN = 'users.kemuyi-practice.invalid'
export class CloudError extends Error {
  kind: 'expired' | 'conflict' | 'unavailable'
  constructor(kind: CloudError['kind'], message: string) { super(message); this.kind = kind }
}
export function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase()
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) throw new Error('用户名需为 3–32 位字母、数字、下划线或短横线')
  return username
}
export function usernameEmail(value: string): string {
  return `kemuyi.${normalizeUsername(value)}@${USERNAME_DOMAIN}`
}
export function usernameFromEmail(value: string | undefined): string | null {
  const match = value?.toLowerCase().match(/^kemuyi\.([a-z0-9_-]{3,32})@users\.kemuyi-practice\.invalid$/)
  return match?.[1] || null
}
export function accountSession(value: Session | null): AccountSession | null {
  const username = usernameFromEmail(value?.user.email)
  return value?.user.id && username ? { user: { id: value.user.id, username } } : null
}
export function publicConfig(url: string, key: string): { url: string; key: string } | null {
  if (!url && !key) return null
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('账户服务地址配置无效，当前可继续游客练习') }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
    !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new Error('账户服务地址配置无效，当前可继续游客练习')
  let allowed = /^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)
  if (!allowed) {
    try { allowed = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon' } catch { /* Non-public keys are rejected. */ }
  }
  if (!allowed) throw new Error('账户服务需配置 public publishable / anon key，当前可继续游客练习')
  return { url: parsed.origin, key }
}
// SDK instances use separate broadcast/refresh-lock names, while their tab's session
// survives reload under a fixed project-specific sessionStorage key.
export function authStorage(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, persistedKey: string, instanceKey: string) {
  const keyFor = (key: string) => key.startsWith(instanceKey) ? persistedKey + key.slice(instanceKey.length) : key
  return {
    getItem: (key: string) => storage.getItem(keyFor(key)),
    setItem: (key: string, value: string) => storage.setItem(keyFor(key), value),
    removeItem: (key: string) => storage.removeItem(keyFor(key)),
  }
}
function failure(error: { code?: string; status?: number; message?: string }): CloudError {
  if (error.code === 'P0001' && error.message?.includes('kemuyi_version_conflict')) return new CloudError('conflict', '云端记录已更新，正在重新核对…')
  if (error.status === 401 || ['PGRST301', 'PGRST303', '42501', 'session_not_found', 'refresh_token_not_found'].includes(error.code || '')) return new CloudError('expired', '登录已过期或账户已变化，本机进度已保留')
  if (error.status === 429 || error.code === 'over_request_rate_limit') return new CloudError('unavailable', '尝试次数较多，请稍后再试')
  if (['email_not_confirmed', 'email_address_invalid', 'email_address_not_authorized'].includes(error.code || '')) return new CloudError('unavailable', '账户服务设置需调整，请联系站点维护者')
  if (error.code === 'invalid_credentials') return new CloudError('unavailable', '用户名或密码错误')
  if (['user_already_exists', 'email_exists'].includes(error.code || '')) return new CloudError('unavailable', '该用户名已被使用')
  if (error.code === 'weak_password') return new CloudError('unavailable', '密码强度不足，请换一个更长的密码')
  if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(error.code || '')) return new CloudError('unavailable', '云端进度表尚未配置，本机进度已保留')
  return new CloudError('unavailable', '连接账户服务失败，本机进度已保留，请稍后重试')
}
export function timedFetch(fetcher: typeof fetch, timeoutMs = 20000): typeof fetch {
  return (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (input instanceof Request) signals.push(input.signal)
    if (init?.signal) signals.push(init.signal)
    return fetcher(input, { ...init, signal: AbortSignal.any(signals) })
  }
}
export class SupabaseCloud {
  client: SupabaseClient
  url: string
  publicKey: string
  fetcher: typeof fetch
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  hintKey: string
  constructor(client: SupabaseClient, url: string, publicKey: string, fetcher: typeof fetch, storage: SupabaseCloud['storage'], hintKey: string) {
    this.client = client; this.url = url; this.publicKey = publicKey; this.fetcher = fetcher; this.storage = storage; this.hintKey = hintKey
  }
  cachedAccount(): AccountSession | null {
    try {
      const hint = JSON.parse(this.storage.getItem(this.hintKey) || 'null') as AccountSession | null
      return hint && /^[a-f0-9-]{36}$/.test(hint.user.id) && normalizeUsername(hint.user.username) === hint.user.username ? hint : null
    } catch { return null }
  }
  rememberAccount(value: AccountSession | null): void {
    if (!value) return
    try { this.storage.setItem(this.hintKey, JSON.stringify(value)) } catch { /* Practice storage reports its own save errors. */ }
  }
  async registrationAllowed(): Promise<void> {
    const response = await this.fetcher(`${this.url}/auth/v1/settings`, { headers: { apikey: this.publicKey }, signal: AbortSignal.timeout(15000), cache: 'no-store' })
    if (!response.ok) throw new CloudError('unavailable', '无法读取账户服务设置，请稍后重试')
    const settings = await response.json()
    if (settings.external?.email !== true || settings.mailer_autoconfirm !== true || settings.disable_signup === true) {
      throw new CloudError('unavailable', '账户服务尚未开启直接注册登录，请联系站点维护者')
    }
  }
  subscribe(callback: (event: AuthChangeEvent, session: AccountSession | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((event, value) => {
      const account = accountSession(value)
      this.rememberAccount(account)
      callback(event, account)
    })
    return () => data.subscription.unsubscribe()
  }
  async session(): Promise<AccountSession | null> {
    const { data, error } = await this.client.auth.getSession()
    if (error) throw failure(error)
    const account = accountSession(data.session)
    this.rememberAccount(account)
    return account
  }
  async login(username: string, password: string, register: boolean): Promise<AccountSession> {
    const email = usernameEmail(username)
    if (password.length < 10 || password.length > 128) throw new Error('密码需为 10–128 位')
    // Check before signup so a misconfigured project cannot send confirmation mail.
    if (register) await this.registrationAllowed()
    const result = register
      ? await this.client.auth.signUp({ email, password })
      : await this.client.auth.signInWithPassword({ email, password })
    if (result.error) throw failure(result.error)
    const session = accountSession(result.data.session)
    if (!session) throw new CloudError('unavailable', '账户服务尚未开启直接注册登录，请联系站点维护者')
    this.rememberAccount(session)
    return session
  }
  async logout(): Promise<void> {
    const { error } = await this.client.auth.signOut({ scope: 'local' })
    if (error) throw failure(error)
    try { this.storage.removeItem(this.hintKey) } catch { /* The SDK's session remains authoritative. */ }
  }
  async assertUser(id: string): Promise<void> {
    const { data, error } = await this.client.auth.getUser()
    if (error) throw failure(error)
    if (data.user?.id !== id || !usernameFromEmail(data.user.email)) throw new CloudError('expired', '账户已变化，请重新登录；本机进度已保留')
  }
  async load(id: string, signal: AbortSignal): Promise<RemoteProgress> {
    const { data, error } = await this.client.from('kemuyi_progress').select('version,data,updated_at').eq('user_id', id).abortSignal(signal).maybeSingle()
    if (error) throw failure(error)
    return data ? { version: Number(data.version), data: data.data, updatedAt: Date.parse(data.updated_at) } : { version: 0, data: null, updatedAt: 0 }
  }
  async save(id: string, expectedVersion: number, snapshot: PracticeData, signal: AbortSignal): Promise<{ version: number; updatedAt: number }> {
    const { data, error } = await this.client.rpc('kemuyi_save_progress', { p_user_id: id, p_expected_version: expectedVersion, p_data: snapshot }).abortSignal(signal)
    if (error) throw failure(error)
    const row = Array.isArray(data) ? data[0] : null
    if (!row || !Number.isSafeInteger(Number(row.version)) || Number(row.version) <= expectedVersion || !Number.isFinite(Date.parse(row.updated_at))) throw new Error('云端返回的保存版本无效，本机进度已保留')
    return { version: Number(row.version), updatedAt: Date.parse(row.updated_at) }
  }
}
export function createCloud(url: string, key: string, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, fetcher?: typeof fetch): SupabaseCloud | null {
  const config = publicConfig(url, key)
  if (!config) return null
  const persistedKey = `${AUTH_STORAGE_PREFIX}:${new URL(config.url).host}`
  const instanceKey = `${persistedKey}:${crypto.randomUUID()}`
  const boundedFetch = timedFetch(fetcher || fetch)
  const client = createClient(config.url, config.key, {
    auth: { storageKey: instanceKey, storage: authStorage(storage, persistedKey, instanceKey), persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: boundedFetch },
  })
  return new SupabaseCloud(client, config.url, config.key, boundedFetch, storage, `${persistedKey}:account`)
}
