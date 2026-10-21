import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COMPACT_ORDER_STORAGE_KEY, FULL_ORDER_KEY, LEGACY_STORAGE_KEY, OLD_STORAGE_KEY, STORAGE_KEY,
  clearLegacyState, findUnansweredIndex, initialState, loadMigratedState, movePractice, parseState,
  recordAnswer, restartState, resumePractice, saveState, startFavoritePractice, toggleFavoriteState,
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

test('favorite retry hides old answers and records a separate round without changing bank progress', () => {
  storage()
  const original = initialState(questions, selected)
  original.answers = { 1: 'A', 2: 'A' }
  original.favorites = [1, 2]
  original.full = { order: [2, 1], index: 2 }
  original.compact.index = 1
  const round = startFavoritePractice(original)
  assert.equal(round.page, 'favorites')
  assert.deepEqual(round.favoritePractice.answers, {})
  assert.deepEqual(new Set(round.favoritePractice.order), new Set([1, 2]))
  round.favoritePractice.order = [1, 2]
  const answered = recordAnswer(round, 1, 'B', 'B')
  assert.deepEqual(answered.favoritePractice.answers, { 1: 'B' })
  assert.equal(recordAnswer(answered, 1, 'A', 'B'), answered)
  assert.equal(recordAnswer(answered, 999, 'A', 'A'), answered)
  assert.deepEqual(answered.answers, original.answers)
  assert.deepEqual(answered.full, original.full)
  assert.deepEqual(answered.compact, original.compact)
  assert.deepEqual(answered.favorites, [1, 2])
  assert.equal(answered.favoritePractice.index, 0, 'keep feedback visible until navigation')
  const next = movePractice(answered, 1)
  assert.equal(next.favoritePractice.index, 1)
  assert.equal(saveState(next, true), true)
  assert.deepEqual(loadMigratedState(questions, selected).state, next)
  const wrong = recordAnswer(next, 2, 'B', 'A')
  assert.deepEqual(wrong.favoritePractice.answers, { 1: 'B', 2: 'B' })
  assert.equal(wrong.favoritePractice.index, 1)
  const completed = movePractice(wrong, 1)
  assert.equal(completed.favoritePractice.index, 2)
  assert.equal(saveState(completed, true), true)
  assert.deepEqual(loadMigratedState(questions, selected), { state: completed, needsSave: false })
  const restarted = restartState(completed, 'favorites', new Set([1]))
  assert.deepEqual(restarted.favoritePractice.answers, {})
  assert.equal(restarted.favoritePractice.index, 0)
  assert.deepEqual(restarted.answers, original.answers)
  assert.deepEqual(restarted.full, original.full)
  assert.deepEqual(restarted.compact, original.compact)
  assert.deepEqual(restarted.favorites, original.favorites)
})

test('favorite retry resumes unanswered questions across banks and wraps over skipped questions', () => {
  const state = initialState(questions, selected)
  state.favorites = [1, 2, 3, 4]
  const round = startFavoritePractice(state)
  round.favoritePractice = { order: [1, 2, 3, 4], index: 0, answers: { 2: 'A' } }
  const next = movePractice(round, 1)
  assert.equal(next.favoritePractice.index, 2)
  assert.equal(movePractice(next, -1).favoritePractice.index, 0)
  assert.equal(movePractice(round, -1), round)
  const wrong = recordAnswer(next, 3, 'B', 'A')
  const full = resumePractice(wrong, 'full')
  assert.equal(resumePractice(full, 'favorites').favoritePractice.index, 3)
  const last = recordAnswer(movePractice(wrong, 1), 4, 'A', 'A')
  assert.equal(movePractice(last, 1).favoritePractice.index, 0)
  assert.deepEqual(last.answers, {})
})

test('removing favorites keeps retry answers and cursors aligned, including completion', () => {
  const state = initialState(questions, selected)
  state.full.order = [1, 2, 3]
  state.favorites = [1, 2, 3]
  state.favoriteIndex = 1
  state.page = 'favorites'
  state.favoritePractice = { order: [1, 2, 3], index: 1, answers: { 1: 'B' } }
  const earlierRemoved = toggleFavoriteState(state, 1)
  assert.deepEqual(earlierRemoved.favorites, [2, 3])
  assert.equal(earlierRemoved.favoriteIndex, 0)
  assert.deepEqual(earlierRemoved.favoritePractice, { order: [2, 3], index: 0, answers: {} })
  const currentRemoved = toggleFavoriteState(earlierRemoved, 2)
  assert.deepEqual(currentRemoved.favoritePractice, { order: [3], index: 0, answers: {} })
  const completed = movePractice(recordAnswer(currentRemoved, 3, 'A', 'A'), 1)
  assert.equal(completed.favoritePractice.index, 1)
  const allRemoved = toggleFavoriteState(completed, 3)
  assert.deepEqual(allRemoved.favoritePractice, { order: [], index: 0, answers: {} })
  assert.equal(startFavoritePractice(allRemoved), allRemoved)
  const added = toggleFavoriteState(earlierRemoved, 1)
  assert.deepEqual(added.favoritePractice.order, [2, 3], 'new favorites join the next round')
  assert.deepEqual(new Set(startFavoritePractice(added).favoritePractice.order), new Set([1, 2, 3]))
})

test('existing saves remain compatible and malformed retry records cannot restore stale questions', () => {
  storage()
  const state = initialState(questions, selected)
  const { favoritePractice: ignored, ...oldSave } = state
  assert.equal(parseState(oldSave, questions, selected).favoritePractice, null)
  state.favorites = [1]
  state.favoritePractice = { order: [1, 2, 999, 1], index: 99, answers: { 1: 'B', 2: 'A', 999: 'A' } }
  assert.deepEqual(parseState(state, questions, selected).favoritePractice, { order: [1], index: 0, answers: { 1: 'B' } })
  state.favoritePractice = { order: 'invalid', index: -1, answers: {} }
  assert.equal(parseState(state, questions, selected).favoritePractice, null)
  state.favoritePractice = { order: [1], index: 1, answers: { 1: 'C' } }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  assert.deepEqual(loadMigratedState(questions, selected).state.favoritePractice, { order: [1], index: 1, answers: {} })
  state.page = 'favorites'
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  assert.equal(loadMigratedState(questions, selected).state.favoritePractice.index, 0)
})
