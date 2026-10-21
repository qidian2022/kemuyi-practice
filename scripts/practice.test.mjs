import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMPACT_ORDER_STORAGE_KEY, FULL_ORDER_KEY, LEGACY_STORAGE_KEY, OLD_STORAGE_KEY, STORAGE_KEY,
  clearLegacyState, findUnansweredIndex, initialState, loadMigratedState, movePractice, parseState,
  recordAnswer, restartState, resumePractice, saveState,
} from '../src/practice.ts'

const questions = [
  { id: 1, options: [{ key: 'A' }, { key: 'B' }], answer: 'B' },
  { id: 2, options: [{ key: 'A' }, { key: 'B' }], answer: 'A' },
]
const selected = [{ id: 1, chapter: '精选' }]

function storage({ fail = false } = {}) {
  const memory = new Map()
  globalThis.localStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => { if (fail) throw new Error('Quota exceeded'); memory.set(key, value) },
    removeItem: (key) => memory.delete(key),
  }
  return memory
}

test('one archive holds answers, favorites, orders and cursors', () => {
  storage()
  const state = initialState(questions, selected)
  state.full.index = 1
  state.compact.index = 0
  state.page = 'compact'
  state.favorites = [1]
  state.favoriteIndex = 0
  const answered = recordAnswer(state, 1, 'A', 'B')
  assert.deepEqual(answered.favorites, [1])
  assert.equal(answered.answers[1], 'A')
  assert.equal(recordAnswer(answered, 1, 'B', 'B'), answered)
  assert.equal(saveState(answered, false), false)
  assert.equal(localStorage.getItem(STORAGE_KEY), null)
  assert.equal(saveState(answered, true), true)
  const resumed = loadMigratedState(questions, selected)
  assert.deepEqual(resumed.state.answers, answered.answers)
  assert.deepEqual(resumed.state.favorites, answered.favorites)
  assert.equal(resumed.state.compact.index, 1)
  assert.equal(resumed.needsSave, true)

  const restarted = restartState(answered, 'compact', new Set([1]))
  assert.deepEqual(restarted.answers, {})
  assert.deepEqual(restarted.favorites, [1])
  assert.equal(restarted.full.index, 1)
  assert.equal(restarted.compact.index, 0)
})

test('saved state rejects stale IDs and invalid answers', () => {
  storage()
  const state = initialState(questions, selected)
  const parsed = parseState({ ...state, answers: { 1: 'C', 2: 'A', 999: 'B' },
    favorites: [1, 999, 1], full: { order: [1, 999], index: 99 },
    favoriteIndex: 99 }, questions, selected)
  assert.deepEqual(parsed.answers, { 2: 'A' })
  assert.deepEqual(parsed.favorites, [1])
  assert.deepEqual(new Set(parsed.full.order), new Set([1, 2]))
  assert.equal(parsed.full.index, 1)
  assert.equal(parsed.favoriteIndex, 0)
})

test('legacy data is cleared only after a confirmed new save', () => {
  const memory = storage({ fail: true })
  memory.set(OLD_STORAGE_KEY, JSON.stringify({ answers: { 1: 'B' }, favorites: [2], order: [1, 2], allIndex: 1 }))
  memory.set(COMPACT_ORDER_STORAGE_KEY, JSON.stringify({ order: [1], allIndex: 0 }))
  const migrated = loadMigratedState(questions, selected)
  assert.equal(migrated.needsSave, true)
  assert.deepEqual(migrated.state.answers, { 1: 'B' })
  assert.deepEqual(migrated.state.favorites, [2])
  assert.equal(migrated.state.full.index, 1)
  assert.equal(saveState(migrated.state, true), false)
  assert.equal(memory.has(OLD_STORAGE_KEY), true)
  globalThis.localStorage.setItem = (key, value) => memory.set(key, value)
  assert.equal(saveState(migrated.state, true), true)
  clearLegacyState()
  assert.equal(memory.has(OLD_STORAGE_KEY), false)
  assert.equal(memory.has(COMPACT_ORDER_STORAGE_KEY), false)
  assert.deepEqual(loadMigratedState(questions, selected).state, migrated.state)
})

test('v1 favorites carry over without resurrecting old answer history', () => {
  const memory = storage()
  memory.set(LEGACY_STORAGE_KEY, JSON.stringify({ answers: { 1: 'B' }, favorites: [2] }))
  const { state } = loadMigratedState(questions, selected)
  assert.deepEqual(state.answers, {})
  assert.deepEqual(state.favorites, [2])
})

test('migration keeps the full order cursor after removed questions', () => {
  const memory = storage()
  memory.set(FULL_ORDER_KEY, JSON.stringify({ order: ['full:999', 'full:2', 'full:1'], index: 2 }))
  const { state } = loadMigratedState(questions, selected)
  assert.deepEqual(state.full.order, [2, 1])
  assert.equal(state.full.index, 1)
})


test('switching banks skips shared answers, including wrong answers, without losing skipped questions', () => {
  const state = initialState(questions, selected)
  state.full = { order: [1, 2], index: 1 }
  state.compact = { order: [1], index: 0 }
  state.page = 'compact'
  const answered = recordAnswer(state, 1, 'A', 'B')
  assert.equal(answered.compact.index, 0, 'keep the current answer visible for its explanation')
  const full = resumePractice(answered, 'full')
  assert.equal(full.full.order[full.full.index], 2)
  assert.deepEqual(full.answers, { 1: 'A' })
  assert.deepEqual(full.favorites, [1])
  const completed = resumePractice(full, 'compact')
  assert.equal(completed.compact.index, 1)
  assert.equal(completed.answers, full.answers)
  assert.equal(findUnansweredIndex([1, 2, 3], { 2: 'A', 3: 'B' }, 2), 0)
})

test('navigation skips answered runs in both directions and wraps forward to missed questions', () => {
  const state = initialState(questions, selected)
  state.full = { order: [1, 2, 3, 4, 5], index: 0 }
  state.answers = { 2: 'A', 3: 'B', 5: 'A' }
  const next = movePractice(state, 1)
  assert.equal(next.full.order[next.full.index], 4)
  assert.equal(movePractice(next, -1).full.index, 0)
  const answered = recordAnswer(next, 4, 'A', 'A')
  assert.equal(movePractice(answered, 1).full.index, 0)
  assert.equal(movePractice(state, -1), state)
})

test('finishing the last question survives refresh and favorites still show answered questions', () => {
  storage()
  const state = initialState(questions, selected)
  state.full = { order: [1, 2], index: 1 }
  state.answers = { 1: 'B', 2: 'B' }
  state.favorites = [2]
  const completed = movePractice(state, 1)
  assert.equal(completed.full.index, 2)
  assert.equal(saveState(completed, true), true)
  assert.deepEqual(loadMigratedState(questions, selected), { state: completed, needsSave: false })
  const favorites = resumePractice(completed, 'favorites')
  assert.equal(favorites.favoriteIndex, 0)
  assert.deepEqual(favorites.favorites, [2])
  assert.equal(favorites.answers[2], 'B')
  const restarted = restartState(completed, 'full', new Set([1]))
  assert.deepEqual(restarted.answers, {})
  assert.equal(restarted.full.index, 0)
  assert.deepEqual(restarted.favorites, [2])
})
