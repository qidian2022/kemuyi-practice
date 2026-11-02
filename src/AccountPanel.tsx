import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AccountProgressStore, equalData, type RemoteProgress,
} from './account'
import { CloudError, createCloud, type AccountSession } from './supabase'
import type { PracticeData, Question, QuestionAliases, SelectedQuestion } from './practice'

type Props = {
  questions: Question[]; selected: SelectedQuestion[]; aliases: QuestionAliases
  children: (storage: AccountProgressStore, panel: React.ReactNode, identity: string, reload: number) => React.ReactNode
}
let cloud: ReturnType<typeof createCloud> = null
let configurationError = ''
try { cloud = createCloud(import.meta.env.VITE_SUPABASE_URL || '', import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '', sessionStorage) }
catch (error) { configurationError = (error as Error).message }
export function AccountPanel({ questions, selected, aliases, children }: Props) {
  const [session, setSession] = useState<AccountSession | null>(() => cloud?.cachedAccount() || null)
  const [expired, setExpired] = useState(false)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<RemoteProgress | null>(null)
  const [revision, setRevision] = useState(0)
  const [change, setChange] = useState(0)
  const [online, setOnline] = useState(navigator.onLine)
  const [writer, setWriter] = useState(false)
  const [unsaved, setUnsaved] = useState(false)
  const storeRef = useRef<AccountProgressStore | null>(null)
  const generation = useRef(0)
  const busySync = useRef(false)
  const syncAgain = useRef(false)
  const requestRef = useRef<AbortController | null>(null)
  const sessionRef = useRef(session)
  const applyAuthRef = useRef<(next: AccountSession | null) => void>(() => {})
  const pendingAuth = useRef<{ session: AccountSession | null } | null>(null)
  const identity = session?.user.id || 'guest'
  // Store identity remains stable between updates, so writer locks aren't restarted on every answer.
  if (!storeRef.current || storeRef.current.id !== (session?.user.id || null)) {
    storeRef.current = new AccountProgressStore(session?.user.id || null, questions, selected, aliases, () => setChange((value) => value + 1))
  }
  const store = storeRef.current
  sessionRef.current = session

  function flush(): { ok: boolean; data?: PracticeData } {
    const detail: { key: string; ok: boolean; data?: PracticeData } = { key: store.key, ok: true }
    window.dispatchEvent(new CustomEvent('kemuyi-flush', { detail }))
    return detail
  }
  function switchSession(next: AccountSession | null): boolean {
    if (!flush().ok) {
      pendingAuth.current = { session: next }; setExpired(true)
      setStatus('当前进度尚未保存，请重试保存后继续切换账户'); return false
    }
    pendingAuth.current = null
    generation.current++
    requestRef.current?.abort()
    busySync.current = false
    syncAgain.current = false
    setSession(next); setExpired(false); setConflict(null); setMessage(''); setStatus(''); setWriter(false)
    setRevision((value) => value + 1)
    return true
  }
  applyAuthRef.current = (next) => {
    if (next?.user.id === sessionRef.current?.user.id) {
      setSession(next); setExpired(false); return
    }
    if (!next && sessionRef.current) {
      generation.current++; requestRef.current?.abort(); busySync.current = false
      setExpired(true); setStatus('登录已过期，本机进度已保留')
      return
    }
    switchSession(next)
  }
  useEffect(() => {
    if (!cloud) return
    let active = true
    // Auth callbacks remain synchronous; any SDK work runs after its internal lock releases.
    const unsubscribe = cloud.subscribe((_event, next) => {
      setTimeout(() => { if (active) applyAuthRef.current(next) }, 0)
    })
    void cloud.session().then((next) => { if (active) applyAuthRef.current(next) }).catch((error) => { if (active) setStatus((error as Error).message) })
    return () => { active = false; unsubscribe() }
  }, [])

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; writable: boolean; unsaved: boolean }>).detail
      if (detail.key === store.key) {
        if (!detail.writable) {
          generation.current++; requestRef.current?.abort(); busySync.current = false; syncAgain.current = false
        }
        setWriter(detail.writable); setUnsaved(detail.unsaved)
      }
    }
    const unsavedUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; unsaved: boolean }>).detail
      if (detail.key === store.key) {
        setUnsaved(detail.unsaved)
        if (!detail.unsaved && pendingAuth.current) switchSession(pendingAuth.current.session)
      }
    }
    window.addEventListener('kemuyi-writer', update)
    window.addEventListener('kemuyi-unsaved', unsavedUpdate)
    return () => { window.removeEventListener('kemuyi-writer', update); window.removeEventListener('kemuyi-unsaved', unsavedUpdate) }
  }, [store])
  useEffect(() => {
    const update = () => { setOnline(navigator.onLine); setChange((value) => value + 1) }
    window.addEventListener('online', update); window.addEventListener('offline', update); window.addEventListener('focus', update)
    const timer = window.setInterval(() => setChange((value) => value + 1), 30000)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); window.removeEventListener('focus', update); clearInterval(timer) }
  }, [])
  useEffect(() => () => { generation.current++; requestRef.current?.abort() }, [])

  async function sync() {
    if (!session) return
    store.read()
    if (store.error) { setStatus(store.error); return }
    if (!session || !cloud || expired || conflict || !writer || !navigator.onLine) return
    if (busySync.current) { syncAgain.current = true; return }
    if (!flush().ok) { setStatus('当前进度尚未保存，请重试保存或导出本机记录'); return }
    busySync.current = true
    const thisGeneration = generation.current
    const controller = new AbortController()
    requestRef.current = controller
    const valid = () => generation.current === thisGeneration && sessionRef.current?.user.id === session.user.id && !controller.signal.aborted
    setStatus('正在同步…')
    try {
      await cloud.assertUser(session.user.id)
      if (!valid()) return
      const remote = store.parseRemote(await cloud.load(session.user.id, controller.signal))
      if (!valid()) return
      if (!flush().ok) { setStatus('当前进度尚未保存，同步已暂停'); return }
      const current = store.read()
      // A lost upload response can be acknowledged by comparing the returned snapshot.
      if (remote.data && equalData(remote.data, current.data)) {
        store.accept(remote)
      } else if (!current.dirty) {
        if (remote.data && !equalData(remote.data, current.data)) {
          store.accept(remote); setRevision((value) => value + 1)
        } else store.accept(remote)
      } else if (remote.version !== current.baseVersion && !equalData(remote.data, current.baseData)) {
        store.backup(remote, 'concurrent-change')
        setConflict(remote); setStatus('两台设备的记录都有更新，请选择合并方式'); return
      } else {
        const snapshot = current.data
        const result = await cloud.save(session.user.id, remote.version, snapshot, controller.signal)
        if (!valid()) return
        store.acknowledge(snapshot, result)
      }
      if (!valid()) return
      const latest = store.read()
      setStatus(latest.dirty ? '本机已保存，等待上传' : `已同步 · ${new Date(latest.updatedAt || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)
      if (latest.dirty) syncAgain.current = true
    } catch (error) {
      if (!valid()) return
      if (error instanceof CloudError && error.kind === 'expired') { setExpired(true); setStatus('登录已过期，本机进度已保留') }
      else if (error instanceof CloudError && error.kind === 'conflict') { setStatus('云端出现新记录，正在重新核对…'); syncAgain.current = true }
      else setStatus(error instanceof Error && !(error instanceof TypeError) ? error.message : '连接失败，本机进度已保留，恢复连接后重试')
    } finally {
      if (valid()) {
        busySync.current = false
        if (syncAgain.current) { syncAgain.current = false; setChange((value) => value + 1) }
      }
    }
  }
  useEffect(() => {
    if (session && writer && !expired && !conflict && cloud && online) {
      if (store.read().dirty) setStatus('本机已保存，等待上传')
      const timer = window.setTimeout(() => void sync(), 1000)
      return () => clearTimeout(timer)
    }
  }, [session, writer, expired, conflict, change, online, store])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!cloud || busy) return
    if (!flush().ok) { setMessage('当前进度尚未保存，请重试保存或导出本机记录。'); return }
    setBusy(true); setMessage('')
    try {
      const result = await cloud.login(username, password, mode === 'register')
      if (!switchSession(result)) return
      setPassword(''); setOpen(false)
    } catch (error) { setMessage(error instanceof TypeError ? '无法连接账户服务，请稍后重试' : error instanceof Error ? error.message : '请求失败') }
    finally { setBusy(false) }
  }
  async function logout() {
    if (!session || busy) return
    if (!flush().ok) { setMessage('当前进度尚未保存，请重试保存或导出本机记录。'); return }
    setBusy(true); setMessage('')
    // A logout is complete only after server-side revocation; offline users can keep practising.
    try {
      if (!cloud) return
      await cloud.logout()
      if (switchSession(null)) setOpen(false)
      else { setExpired(true); setStatus('已退出云端，本机进度尚未保存，请重试保存或导出记录') }
    } catch (error) {
      if (error instanceof CloudError && error.kind === 'expired') { switchSession(null); setOpen(false) }
      else setMessage('退出尚未完成，请联网后重试。本机账户记录已保留。')
    } finally { setBusy(false) }
  }
  function resolve(choice: 'merge' | 'local' | 'cloud') {
    if (!conflict || !writer) return
    if (!flush().ok) { setMessage('当前进度尚未保存，请先重试保存或导出记录'); return }
    try {
      store.resolve(conflict, choice); setConflict(null); setRevision((value) => value + 1); setChange((value) => value + 1); setMessage('')
    } catch (error) { setMessage((error as Error).message) }
  }
  function importGuest() {
    if (!writer) return
    if (!flush().ok) { setMessage('当前进度尚未保存，请先重试保存或导出记录'); return }
    try { const count = store.importGuest(); setRevision((value) => value + 1); setChange((value) => value + 1); setMessage(`已合并游客的 ${count} 道答题记录，游客原件仍保留。`) }
    catch (error) { setMessage((error as Error).message) }
  }
  function exportData() {
    const memory = flush().data
    let rawArchive: string | null = null
    try { rawArchive = localStorage.getItem(store.key) } catch { /* In-memory data can still be exported. */ }
    const payload = session ? { user: session.user, archive: store.read(), rawArchive, memory } : { data: memory || store.load().state }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = `kemuyi-${session?.user.username || 'guest'}-${Date.now()}.json`; link.click(); URL.revokeObjectURL(url)
  }
  const localCount = session ? Object.keys(store.read().data.answers).length : 0
  const cloudCount = conflict?.data ? Object.keys(conflict.data.answers).length : 0
  const panel = <section className="account-bar" aria-label="账户与同步">
    <div><strong>{session ? session.user.username : '游客练习'}</strong><span role="status">{store.error || configurationError || (session ? !cloud ? '账户服务尚未配置，本机记录保留' : !online ? '离线中，本机进度已保存' : !writer ? '只读标签页 · 同步由练习页处理' : status || '正在核对云端记录…' : cloud ? '登录后可跨设备继续练习' : '本机自动保存 · 账户服务待配置')}</span></div>
    <div className="account-actions">
      {session && <button className="button-secondary" disabled={!writer || expired || !!conflict || !online || unsaved} onClick={() => void sync()}>立即同步</button>}
      <button className="button-secondary" onClick={() => { setOpen(true); setMessage(''); if (expired) setMode('login') }}>{session ? expired ? '重新登录' : '账户管理' : '登录 / 注册'}</button>
    </div>
    {conflict && <div className="account-conflict" role="alert">
      <strong>本机与云端都有更新</strong><p>本机已练 {localCount} 道，云端已练 {cloudCount} 道。两份记录已备份。合并会保留两边的答案和收藏；同题答案不同时保留本机答案。</p>
      <div className="account-actions"><button className="button-primary" disabled={!writer} onClick={() => resolve('merge')}>合并进度</button><button className="button-secondary" disabled={!writer} onClick={() => resolve('cloud')}>使用云端</button><button className="button-secondary" disabled={!writer} onClick={() => resolve('local')}>以本机覆盖云端</button></div>
    </div>}
    {open && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false) }}>
      <div className="modal account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
        <h2 id="account-title">{session && !expired ? '账户管理' : mode === 'register' ? '创建账户' : '登录账户'}</h2>
        {session && !expired ? <><p>当前账户：{session.user.username}。账户记录和游客记录分别保存，退出后可继续游客练习。</p><p>导入游客记录会保留游客原件，并合并答案和收藏；同题不同答案保留账户答案。</p><div className="account-actions"><button className="button-primary" disabled={!writer || busy} onClick={importGuest}>导入游客记录</button><button className="button-secondary" onClick={exportData}>导出本机记录</button><button className="button-secondary" disabled={busy} onClick={() => void logout()}>退出登录</button><button className="button-secondary" onClick={() => setOpen(false)}>关闭</button></div><p className="account-message" role="status">{message}</p></>
          : <><p>{cloud ? '用户名使用 3–32 位字母、数字、下划线或短横线；密码至少 10 位。' : '账户服务部署并配置后即可登录。当前可继续刷题和导出本机记录。'}</p>
            <form onSubmit={(event) => void submit(event)}>
              <label>用户名<input autoComplete="username" name="username" value={username} onChange={(event) => setUsername(event.target.value)} pattern="[a-zA-Z0-9_-]{3,32}" minLength={3} maxLength={32} required /></label>
              <label>密码<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} name="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} maxLength={128} required /></label>
              <p className="account-message" role="status">{message}</p>
              <button className="button-primary" type="submit" disabled={!cloud || busy || unsaved}>{busy ? '正在处理…' : mode === 'register' ? '注册并登录' : '登录'}</button>
            </form>
            <div className="account-actions account-links"><button onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setMessage('') }}>{mode === 'register' ? '已有账户，去登录' : '创建新账户'}</button><button onClick={exportData}>导出本机记录</button>{session && <button disabled={busy} onClick={() => void logout()}>退出登录</button>}<button onClick={() => setOpen(false)}>关闭</button></div>
          </>}
      </div>
    </div>}
  </section>
  return children(store, panel, identity, revision)
}
