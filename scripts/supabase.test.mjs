import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountSession, authStorage, createCloud, normalizeUsername, publicConfig, timedFetch, usernameEmail, usernameFromEmail } from '../src/supabase.ts'

const key = 'sb_publishable_local_test_key'
const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
function storage() {
  const map = new Map()
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) }
}
function token(id) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256' })}.${encode({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600, role: 'authenticated' })}.synthetic-signature`
}
function fakeProvider() {
  const requests = []
  const accounts = new Map()
  const sessions = new Map()
  let confirmation = false
  let missingSession = false
  let conflict = false
  let mismatch = false
  const session = (user) => {
    const value = { access_token: token(user.id), refresh_token: `refresh-${user.id}`, token_type: 'bearer', expires_in: 3600, user }
    sessions.set(value.access_token, user)
    return value
  }
  const fetcher = async (address, options = {}) => {
    const url = new URL(typeof address === 'string' ? address : address.url)
    const payload = options.body ? JSON.parse(options.body) : null
    requests.push({ path: url.pathname, search: url.search, payload })
    const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' } })
    if (url.pathname === '/auth/v1/settings') return reply({ disable_signup: false, mailer_autoconfirm: !confirmation, external: { email: true } })
    if (url.pathname === '/auth/v1/signup') {
      if (accounts.has(payload.email)) return reply({ code: 'user_already_exists', msg: 'User already registered' }, 422)
      const user = { id: accounts.size ? userB : userA, email: payload.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
      accounts.set(payload.email, { user, password: payload.password })
      return reply(confirmation || missingSession ? user : session(user))
    }
    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const account = [...accounts.values()].find(({ user }) => payload.refresh_token === `refresh-${user.id}`)
        return account ? reply(session(account.user)) : reply({ code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }, 400)
      }
      const account = accounts.get(payload.email)
      return account?.password === payload.password ? reply(session(account.user)) : reply({ code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400)
    }
    if (url.pathname === '/auth/v1/user') {
      const auth = new Headers(options.headers).get('Authorization')
      const user = sessions.get(auth?.replace('Bearer ', ''))
      return user ? reply(user) : reply({ code: 'session_not_found', msg: 'not authenticated' }, 401)
    }
    if (url.pathname === '/auth/v1/logout') return reply({})
    if (url.pathname === '/rest/v1/kemuyi_progress') return reply(null)
    if (url.pathname === '/rest/v1/rpc/kemuyi_save_progress') {
      if (mismatch) return reply({ code: '42501', message: 'kemuyi_account_mismatch' }, 403)
      if (conflict) return reply({ code: 'P0001', message: 'kemuyi_version_conflict' }, 400)
      return reply([{ version: payload.p_expected_version + 1, updated_at: new Date().toISOString() }])
    }
    throw new Error(`Unexpected test endpoint ${url.pathname}`)
  }
  return { requests, fetcher, confirmation: (value) => { confirmation = value }, missingSession: () => { missingSession = true }, conflict: () => { conflict = true }, mismatch: () => { mismatch = true } }
}
function cloud(provider, saved = storage()) {
  const value = createCloud('https://local-test.supabase.co', key, saved, provider.fetcher)
  return { value, saved, close: () => value.client.auth.dispose() }
}

test('usernames normalize case and map injectively to the application-only email namespace', () => {
  assert.equal(normalizeUsername(' Alice_01 '), 'alice_01')
  assert.equal(usernameEmail('ALICE_01'), 'kemuyi.alice_01@users.kemuyi-practice.invalid')
  assert.equal(usernameFromEmail(usernameEmail('a-b')), 'a-b')
  for (const invalid of ['ab', 'a'.repeat(33), '中文名字', 'a+b', 'a b', 'a@b', 'a.b', 'a/b']) assert.throws(() => usernameEmail(invalid), /用户名/)
  assert.notEqual(usernameEmail('a-b'), usernameEmail('a_b'))
  assert.equal(usernameFromEmail('alice@example.com'), null)
  assert.equal(usernameFromEmail('kemuyi.alice@other-app.invalid'), null)
  assert.equal(accountSession({ user: { id: userA, email: 'teacher@example.com' } }), null)
})

test('missing or incorrect public configuration stays optional; secret/server keys are rejected', () => {
  assert.equal(publicConfig('', ''), null)
  assert.throws(() => publicConfig('not a URL', key), /配置/)
  assert.throws(() => publicConfig('http://example.com', key), /配置/)
  assert.throws(() => publicConfig('https://project.supabase.co', 'sb_secret_do_not_use'), /public/)
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  assert.throws(() => publicConfig('https://project.supabase.co', `x.${encoded({ role: 'service_role' })}.x`), /public/)
  assert.ok(publicConfig('https://project.supabase.co', `x.${encoded({ role: 'anon' })}.x`))
  assert.equal(createCloud('', '', storage()), null)
})

test('official SDK sends username aliases for actual signup/login requests, stores no password, and signs out locally', async () => {
  const provider = fakeProvider()
  const { value, saved, close } = cloud(provider)
  try {
    const registered = await value.login('Alice_01', 'password-12345', true)
    assert.equal(registered.user.username, 'alice_01')
    assert.deepEqual(value.cachedAccount(), registered)
    const signup = provider.requests.find(({ path }) => path === '/auth/v1/signup')
    assert.equal(signup.payload.email, usernameEmail('alice_01'))
    assert.equal(signup.payload.password, 'password-12345')
    assert.equal(provider.requests.some(({ path }) => /recover|verify|resend/.test(path)), false)
    assert.equal([...saved.map.values()].some((raw) => raw.includes('password-12345')), false)
    await value.login('ALICE_01', 'password-12345', false)
    const login = provider.requests.find(({ path }) => path === '/auth/v1/token')
    assert.equal(login.payload.email, usernameEmail('alice_01'))
    await assert.rejects(value.login('alice_01', 'wrong-password', false), /用户名或密码错误/)
    await assert.rejects(value.login('alice_01', 'password-12345', true), /用户名已被使用/)
    const refreshed = await value.client.auth.refreshSession()
    assert.equal(refreshed.error, null)
    assert.ok(provider.requests.some(({ search }) => search.includes('grant_type=refresh_token')))
    await value.assertUser(registered.user.id)
    await assert.rejects(value.assertUser(userB), /账户已变化/)
    await value.logout()
    assert.equal((await value.session()), null)
    assert.equal(value.cachedAccount(), null)
    assert.ok(provider.requests.some(({ path, search }) => path === '/auth/v1/logout' && search.includes('scope=local')))
  } finally { await close() }
})

test('signup is blocked before any creation or email request when direct confirmation is disabled', async () => {
  const provider = fakeProvider(); provider.confirmation(true)
  const { value, close } = cloud(provider)
  try {
    await assert.rejects(value.login('alice', 'password-12345', true), /直接注册登录/)
    assert.equal(provider.requests.some(({ path }) => path === '/auth/v1/signup'), false)
    assert.equal(await value.session(), null)
    const before = provider.requests.length
    await assert.rejects(value.login('bad+name', 'password-12345', true), /用户名/)
    assert.equal(provider.requests.length, before)
  } finally { await close() }
})

test('fixed tab storage restores an SDK session after reload and keeps different tabs independent', async () => {
  const provider = fakeProvider()
  const alice = cloud(provider), bob = cloud(provider)
  let restored
  try {
    await alice.value.login('alice', 'password-12345', true)
    await bob.value.login('bobby', 'password-12345', true)
    assert.notEqual(alice.value.client.auth.storageKey, bob.value.client.auth.storageKey)
    assert.equal((await alice.value.session()).user.username, 'alice')
    assert.equal((await bob.value.session()).user.username, 'bobby')
    restored = cloud(provider, alice.saved)
    assert.equal((await restored.value.session()).user.username, 'alice')
    const mapped = authStorage(alice.saved, 'stable', 'instance')
    mapped.setItem('instance-user', 'test')
    assert.equal(alice.saved.getItem('stable-user'), 'test')
  } finally { await alice.close(); await bob.close(); if (restored) await restored.close() }
})

test('cloud writes bind the expected account and version; RPC conflicts and changed credentials stop syncing', async () => {
  const provider = fakeProvider()
  const { value, close } = cloud(provider)
  try {
    await value.login('alice', 'password-12345', true)
    const signal = new AbortController().signal
    assert.deepEqual(await value.load(userA, signal), { version: 0, data: null, updatedAt: 0 })
    const result = await value.save(userA, 4, { version: 3 }, signal)
    assert.equal(result.version, 5)
    const request = provider.requests.find(({ path }) => path === '/rest/v1/rpc/kemuyi_save_progress')
    assert.deepEqual(request.payload, { p_user_id: userA, p_expected_version: 4, p_data: { version: 3 } })
    provider.conflict()
    await assert.rejects(value.save(userA, 4, {}, signal), (error) => error.kind === 'conflict')
    provider.mismatch()
    await assert.rejects(value.save(userA, 4, {}, signal), (error) => error.kind === 'expired')
  } finally { await close() }
})

test('all SDK requests share bounded fetch and preserve both Request and init abort signals', async () => {
  const pending = (_input, init) => new Promise((_resolve, reject) => {
    const abort = () => reject(init.signal.reason)
    if (init.signal.aborted) abort()
    else init.signal.addEventListener('abort', abort, { once: true })
  })
  const caller = new AbortController()
  const bounded = timedFetch(pending, 15)
  const first = bounded('https://local-test.invalid', { signal: caller.signal })
  caller.abort(new DOMException('caller stopped', 'AbortError'))
  await assert.rejects(first, /caller stopped/)
  const requestSignal = new AbortController()
  const second = bounded(new Request('https://local-test.invalid', { signal: requestSignal.signal }))
  requestSignal.abort(new DOMException('request stopped', 'AbortError'))
  await assert.rejects(second, /request stopped/)
  const keepAlive = setTimeout(() => {}, 100)
  try { await assert.rejects(bounded('https://local-test.invalid'), (error) => error.name === 'TimeoutError') }
  finally { clearTimeout(keepAlive) }
})

test('a provider user object without an authenticated session is never reported as logged in', async () => {
  const provider = fakeProvider(); provider.missingSession()
  const { value, close } = cloud(provider)
  try {
    await assert.rejects(value.login('alice', 'password-12345', true), /直接注册登录/)
    assert.equal(await value.session(), null)
    assert.equal(value.cachedAccount(), null)
  } finally { await close() }
})
