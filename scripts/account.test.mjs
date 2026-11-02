import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AccountProgressStore, GUEST_BACKUP_KEY, accountKey, backupGuest, mergeProgress } from '../src/account.ts'
import { STORAGE_KEY, initialState, recordAnswer } from '../src/practice.ts'

const questions = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, options: [{ key: 'A' }, { key: 'B' }], answer: 'A' }))
const selected = questions.map(({ id }) => ({ id, chapter: '精选' }))
function memoryStorage() {
  const memory = new Map()
  let fail = false
  globalThis.localStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => { if (fail) throw new Error('quota'); memory.set(key, value) },
    removeItem: (key) => memory.delete(key),
  }
  return { memory, fail: (value) => { fail = value } }
}
const store = (id) => new AccountProgressStore(id, questions, selected, {})

test('255 guest answers are imported once explicitly; guest and exact original remain unchanged', () => {
  const { memory } = memoryStorage()
  const original = initialState(questions, selected)
  original.answers = Object.fromEntries(questions.slice(0, 255).map(({ id }) => [id, 'A']))
  original.favorites = questions.slice(0, 62).map(({ id }) => id)
  original.page = 'compact'
  const raw = JSON.stringify(original)
  memory.set(STORAGE_KEY, raw)
  const guest = store(null)
  assert.equal(Object.keys(guest.load().state.answers).length, 255)
  const account = store('alice')
  const initial = account.load()
  account.save(initial.state, true)
  assert.equal(Object.keys(account.read().data.answers).length, 0)
  assert.equal(account.read().dirty, false)
  assert.equal(account.importGuest(), 255)
  assert.equal(Object.keys(account.read().data.answers).length, 255)
  assert.equal(account.read().data.favorites.length, 62)
  assert.equal(account.read().data.page, 'compact')
  assert.deepEqual(account.read().data.compact.order, original.compact.order)
  assert.equal(account.importGuest(), 255)
  assert.equal(memory.get(STORAGE_KEY), raw)
  assert.equal(JSON.parse(memory.get(GUEST_BACKUP_KEY)).entries[STORAGE_KEY], raw)
})

test('new device starts clean and can accept the cloud; two users never share their cache', () => {
  memoryStorage()
  const alice = store('alice')
  const bob = store('bob')
  const initial = alice.load().state
  assert.deepEqual(initial, alice.load().state)
  assert.equal(alice.save(initial, true), true)
  assert.equal(alice.read().dirty, false)
  const cloud = recordAnswer(initial, 1, 'A', 'A')
  alice.accept({ version: 4, data: cloud, updatedAt: 1 })
  assert.equal(alice.read().data.answers[1], 'A')
  assert.equal(alice.read().dirty, false)
  assert.equal(bob.read().data.answers[1], undefined)
  bob.save(recordAnswer(bob.load().state, 2, 'B', 'A'), true)
  assert.deepEqual(alice.read().data.answers, { 1: 'A' })
  assert.deepEqual(bob.read().data.answers, { 2: 'B' })
})

test('answers written during upload remain dirty after acknowledging the captured snapshot', () => {
  memoryStorage()
  const account = store('alice')
  const snapshot = recordAnswer(account.load().state, 1, 'A', 'A')
  account.save(snapshot, true)
  account.save(recordAnswer(snapshot, 2, 'B', 'A'), true)
  account.acknowledge(snapshot, { version: 1, updatedAt: 1 })
  assert.equal(account.read().dirty, true)
  assert.deepEqual(account.read().baseData.answers, { 1: 'A' })
  assert.deepEqual(account.read().data.answers, { 1: 'A', 2: 'B' })
})

test('conflict resolution backs up both records, merges explicitly, and preserves reset choice', () => {
  const { memory } = memoryStorage()
  const account = store('alice')
  const local = recordAnswer(account.load().state, 1, 'B', 'A')
  account.save(local, true)
  const cloud = recordAnswer(recordAnswer(initialState(questions, selected), 1, 'A', 'A'), 2, 'A', 'A')
  cloud.favorites = [2]
  const remote = { version: 3, data: cloud, updatedAt: 1 }
  account.resolve(remote, 'merge')
  assert.deepEqual(account.read().data.answers, { 1: 'B', 2: 'A' })
  assert.deepEqual(new Set(account.read().data.favorites), new Set([1, 2]))
  assert.equal(account.read().baseVersion, 3)
  assert.equal(account.read().dirty, true)
  const backups = JSON.parse(memory.get(`${accountKey('alice')}:backups`))
  assert.deepEqual(backups[0].local.data.answers, { 1: 'B' })
  assert.deepEqual(backups[0].remote.data.answers, { 1: 'A', 2: 'A' })
  const reset = { ...local, answers: {} }
  account.save(reset, true)
  account.resolve(remote, 'local')
  assert.deepEqual(account.read().data.answers, {})
  account.resolve(remote, 'cloud')
  assert.deepEqual(account.read().data.answers, cloud.answers)
  assert.equal(account.read().dirty, false)
  assert.deepEqual(mergeProgress(local, cloud).answers, { 1: 'B', 2: 'A' })
})

test('malformed and unreadable account storage cannot be replaced by an empty archive', () => {
  const { memory } = memoryStorage()
  const raw = '{"partial":'
  memory.set(accountKey('alice'), raw)
  const account = store('alice')
  const loaded = account.load()
  assert.equal(loaded.needsSave, false)
  assert.match(account.error, /无法读取/)
  assert.equal(account.save(loaded.state, true), false)
  assert.throws(() => account.accept({ version: 1, data: initialState(questions, selected), updatedAt: 1 }), /无法读取/)
  assert.equal(memory.get(accountKey('alice')), raw)
  globalThis.localStorage.getItem = () => { throw new Error('blocked') }
  assert.equal(account.save(loaded.state, true), false)
})

test('quota failure leaves account archive and guest source intact', () => {
  const { memory, fail } = memoryStorage()
  const account = store('alice')
  const initial = account.load().state
  account.save(initial, true)
  const raw = memory.get(account.key)
  memory.set(STORAGE_KEY, JSON.stringify(initial))
  fail(true)
  assert.equal(backupGuest(), false)
  assert.equal(store(null).load().needsSave, true)
  assert.equal(store(null).save(initial, true), false)
  assert.equal(account.save(recordAnswer(initial, 1, 'A', 'A'), true), false)
  assert.equal(memory.get(account.key), raw)
  assert.ok(memory.has(STORAGE_KEY))
})

test('structurally invalid JSON archives retain their exact contents', () => {
  const { memory } = memoryStorage()
  const value = { version: 1, data: { ...initialState(questions, selected), answers: 'invalid' }, baseVersion: 0, baseData: null, dirty: true, updatedAt: 0 }
  const raw = JSON.stringify(value)
  memory.set(accountKey('alice'), raw)
  const account = store('alice')
  account.load()
  assert.ok(account.error)
  assert.equal(account.save(initialState(questions, selected), true), false)
  assert.equal(memory.get(account.key), raw)
})

