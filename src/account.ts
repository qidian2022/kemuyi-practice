import { validProgress } from '../shared/progress-schema.ts'
import {
  ACTIVE_PAGE_KEY, COMPACT_ORDER_STORAGE_KEY, COMPACT_STORAGE_KEY, FAVORITE_INDEX_KEY, FULL_ORDER_KEY,
  LEGACY_STORAGE_KEY, OLD_STORAGE_KEY, STORAGE_KEY, initialState, loadMigratedState, parseState, resumePractice, saveState,
  type PracticeData, type Question, type QuestionAliases, type SelectedQuestion,
} from './practice.ts'

export type RemoteProgress = { version: number; data: PracticeData | null; updatedAt: number }
export type AccountArchive = { version: 1; data: PracticeData; baseVersion: number; baseData: PracticeData | null; dirty: boolean; updatedAt: number }
export type PracticeStorage = {
  key: string
  load: () => { state: PracticeData; needsSave: boolean }
  save: (data: PracticeData, writable: boolean) => boolean
}
export const GUEST_BACKUP_KEY = 'kemuyi-guest-original-v1'
export const accountKey = (id: string) => `kemuyi-account-progress-v1:${id}`
export const equalData = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const guestKeys = [STORAGE_KEY, OLD_STORAGE_KEY, LEGACY_STORAGE_KEY, COMPACT_STORAGE_KEY, COMPACT_ORDER_STORAGE_KEY,
  FULL_ORDER_KEY, ACTIVE_PAGE_KEY, FAVORITE_INDEX_KEY, 'kemuyi-full-order-v1', 'kemuyi-favorite-index-v1', 'kemuyi-active-bank-v1']

function readJson(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
}
export function writeJson(key: string, value: unknown): boolean {
  try {
    const raw = JSON.stringify(value)
    localStorage.setItem(key, raw)
    return localStorage.getItem(key) === raw
  } catch { return false }
}
// Store the exact original strings once, before any migration or account import.
export function backupGuest(): boolean {
  try {
    const existing = localStorage.getItem(GUEST_BACKUP_KEY)
    if (existing !== null) {
      const backup = JSON.parse(existing)
      return backup !== null && typeof backup === 'object' && backup.entries !== null && typeof backup.entries === 'object' && Object.values(backup.entries).every((item) => typeof item === 'string')
    }
    const entries = Object.fromEntries(guestKeys.map((key) => [key, localStorage.getItem(key)]).filter(([, value]) => value !== null))
    if (!Object.keys(entries).length) return true
    return writeJson(GUEST_BACKUP_KEY, { createdAt: Date.now(), entries })
  } catch { return false }
}
export class AccountProgressStore implements PracticeStorage {
  key: string
  id: string | null
  questions: Question[]
  selected: SelectedQuestion[]
  aliases: QuestionAliases
  onSaved: () => void
  error: string | null = null
  fallback: PracticeData | null = null
  constructor(id: string | null, questions: Question[], selected: SelectedQuestion[], aliases: QuestionAliases, onSaved = () => {}) {
    this.id = id; this.key = id ? accountKey(id) : STORAGE_KEY
    this.questions = questions; this.selected = selected; this.aliases = aliases; this.onSaved = onSaved
  }
  read(): AccountArchive {
    if (!this.id) throw new Error('游客没有账户存档')
    let raw: string | null = null
    try {
      raw = localStorage.getItem(this.key)
      if (raw !== null) {
        const value = JSON.parse(raw) as AccountArchive | null
        const data = parseState(value?.data, this.questions, this.selected)
        const base = value?.baseData === null ? null : parseState(value?.baseData, this.questions, this.selected)
        if (value?.version !== 1 || !validProgress(value.data) || !data || (value.baseData !== null && (!validProgress(value.baseData) || !base)) || !Number.isSafeInteger(value.baseVersion) || value.baseVersion < 0 || typeof value.dirty !== 'boolean') throw new Error('invalid archive')
        this.error = null
        return { ...value, data, baseData: base }
      }
      this.error = null
    } catch {
      this.error = '本机账户存档无法读取，原始内容已保留。请导出记录后恢复存档。'
    }
    this.fallback ||= initialState(this.questions, this.selected)
    return { version: 1, data: this.fallback, baseVersion: 0, baseData: null, dirty: false, updatedAt: 0 }
  }
  load(): { state: PracticeData; needsSave: boolean } {
    if (!this.id) {
      const backedUp = backupGuest()
      const loaded = loadMigratedState(this.questions, this.selected, this.aliases)
      return { ...loaded, needsSave: loaded.needsSave || !backedUp }
    }
    const archive = this.read()
    const state = resumePractice(archive.data)
    return { state, needsSave: !this.error && (!equalData(state, archive.data) || !localStorage.getItem(this.key)) }
  }
  save(data: PracticeData, writable: boolean): boolean {
    if (!writable) return false
    if (!this.id) return backupGuest() && saveState(data, true)
    const archive = this.read()
    if (this.error) return false
    const changed = !equalData(data, archive.data)
    const saved = writeJson(this.key, { ...archive, data, dirty: archive.dirty || changed })
    if (saved && changed) this.onSaved()
    return saved
  }
  write(archive: AccountArchive): void {
    this.read()
    if (this.error) throw new Error(this.error)
    if (!writeJson(this.key, archive)) throw new Error('本机存储空间不足，进度尚未保存')
  }
  parseRemote(remote: RemoteProgress): RemoteProgress {
    if (!Number.isSafeInteger(remote.version) || remote.version < 0 || (remote.data !== null && (!validProgress(remote.data) || !parseState(remote.data, this.questions, this.selected)))) throw new Error('云端记录格式无效')
    return { ...remote, data: remote.data ? parseState(remote.data, this.questions, this.selected)! : null }
  }
  accept(remote: RemoteProgress): void {
    const current = this.read()
    this.write({ ...current, data: remote.data || current.data, baseData: remote.data, baseVersion: remote.version, dirty: false, updatedAt: remote.updatedAt })
  }
  acknowledge(snapshot: PracticeData, result: { version: number; updatedAt: number }): void {
    const current = this.read()
    this.write({ ...current, baseData: snapshot, baseVersion: result.version, dirty: !equalData(current.data, snapshot), updatedAt: result.updatedAt })
  }
  backup(remote: RemoteProgress, reason: string): void {
    const key = `${this.key}:backups`
    const previous = readJson(key)
    if (localStorage.getItem(key) !== null && !Array.isArray(previous)) throw new Error('冲突备份无法读取，请先导出本机记录')
    const list = Array.isArray(previous) ? previous : []
    if (!writeJson(key, [...list.slice(-4), { at: Date.now(), reason, local: this.read(), remote }])) throw new Error('无法保存冲突备份，请先导出本机记录')
  }
  resolve(remote: RemoteProgress, choice: 'merge' | 'local' | 'cloud'): void {
    this.backup(remote, choice)
    const current = this.read()
    const data = choice === 'cloud' ? remote.data || initialState(this.questions, this.selected)
      : choice === 'merge' && remote.data ? mergeProgress(current.data, remote.data) : current.data
    this.write({ ...current, data, baseVersion: remote.version, baseData: remote.data, dirty: choice !== 'cloud', updatedAt: remote.updatedAt })
  }
  importGuest(): number {
    if (!this.id || !backupGuest()) throw new Error('无法保留游客原始备份，请先检查本机存储空间')
    const guest = loadMigratedState(this.questions, this.selected, this.aliases).state
    const current = this.read()
    this.backup({ version: current.baseVersion, data: current.baseData, updatedAt: current.updatedAt }, 'import-guest')
    const isEmpty = !Object.keys(current.data.answers).length && !current.data.favorites.length && !current.data.favoritePractice
    this.write({ ...current, data: isEmpty ? guest : mergeProgress(current.data, guest), dirty: true })
    return Object.keys(guest.answers).length
  }
}
// Explicit user-requested merging keeps every answered question and favorite.
// A different answer to the same question keeps this device's answer.
export function mergeProgress(local: PracticeData, remote: PracticeData): PracticeData {
  return { ...local, answers: { ...remote.answers, ...local.answers }, favorites: [...new Set([...local.favorites, ...remote.favorites])] }
}
