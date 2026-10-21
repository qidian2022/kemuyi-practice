import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { deduplicateCatalog, makeRefs } from '../src/catalog.ts'
import { initialState, loadMigratedState, recordAnswer, resumePractice, saveState, STORAGE_KEY } from '../src/practice.ts'

const raw = JSON.parse(readFileSync(new URL('../public/data/catalog.json', import.meta.url), 'utf8'))
const catalog = deduplicateCatalog(raw.questions, raw.selected)
function storage(state, fail = false) {
  const memory = new Map([[STORAGE_KEY, JSON.stringify(state)]])
  globalThis.localStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => { if (fail) throw new Error('Quota exceeded'); memory.set(key, value) },
    removeItem: (key) => memory.delete(key),
  }
  return memory
}

test('the reported queueing question has one full-bank copy and one shared selected reference', () => {
  assert.equal(catalog.questions.length, 1650)
  assert.equal(catalog.selected.length, 300)
  assert.equal(Object.keys(catalog.aliases).length, 191)
  assert.equal(catalog.aliases[3525], 158)
  const refs = makeRefs(catalog.questions, catalog.selected)
  const stem = raw.questions.find(({ id }) => id === 158).question
  assert.deepEqual(refs.full.filter(({ question }) => question.question === stem).map(({ id }) => id), [158])
  assert.deepEqual(refs.compact.filter(({ question }) => question.question === stem).map(({ id }) => id), [158])
  const keys = catalog.questions.map((q) => JSON.stringify([q.question, q.options, q.answer, q.images]))
  assert.equal(new Set(keys).size, keys.length)
})

test('content deduplication keeps image differences, answer differences and selected original IDs', () => {
  const base = raw.questions.find(({ id }) => id === 158)
  const result = deduplicateCatalog([
    { ...base, id: 1 }, { ...base, id: 2 },
    { ...base, id: 3, images: ['different.jpg'] }, { ...base, id: 4, answer: 'A' },
  ], [{ id: 2, chapter: 'selected' }])
  assert.deepEqual(result.questions.map(({ id }) => id), [2, 3, 4])
  assert.deepEqual(result.aliases, { 1: 2 })
  assert.equal(result.selected[0].id, 2)
})

test('an answer and favorite saved under #3525 migrate to #158 and are skipped in selected practice', () => {
  const old = initialState(raw.questions, raw.selected)
  old.page = 'compact'
  old.answers = { 3525: 'D' }
  old.favorites = [3525]
  old.compact.index = old.compact.order.indexOf(158)
  const originalOrder = [...old.compact.order]
  const memory = storage(old)
  const loaded = loadMigratedState(catalog.questions, catalog.selected, catalog.aliases)
  assert.equal(loaded.needsSave, true)
  assert.deepEqual(loaded.state.answers, { 158: 'D' })
  assert.deepEqual(loaded.state.favorites, [158])
  assert.deepEqual(loaded.state.compact.order, originalOrder)
  assert.notEqual(loaded.state.compact.order[loaded.state.compact.index], 158)
  assert.equal(loaded.state.full.order.length, 1650)
  assert.equal(new Set(loaded.state.full.order).size, 1650)
  assert.ok(loaded.state.full.order.includes(158))
  assert.ok(!loaded.state.full.order.includes(3525))
  assert.equal(saveState(loaded.state, true), true)
  const reloaded = loadMigratedState(catalog.questions, catalog.selected, catalog.aliases)
  assert.equal(reloaded.needsSave, false)
  assert.deepEqual(reloaded.state, loaded.state)
  assert.equal(JSON.parse(memory.get(STORAGE_KEY)).answers[158], 'D')
})

test('merged records retain canonical answers, union favorites and preserve the current full-bank target', () => {
  const old = initialState(raw.questions, raw.selected)
  old.answers = { 158: 'A', 3525: 'D', 10: 'B' }
  old.favorites = [158, 3525, 10]
  old.full.index = old.full.order.indexOf(11)
  storage(old)
  const loaded = loadMigratedState(catalog.questions, catalog.selected, catalog.aliases).state
  assert.deepEqual(loaded.answers, { 10: 'B', 158: 'A' })
  assert.deepEqual(loaded.favorites, [158, 10])
  assert.equal(loaded.full.order[loaded.full.index], 11)
})

test('failed migration saves do not erase original answers or favorites', () => {
  const old = initialState(raw.questions, raw.selected)
  old.answers = { 3525: 'D' }
  old.favorites = [3525]
  const memory = storage(old, true)
  const loaded = loadMigratedState(catalog.questions, catalog.selected, catalog.aliases)
  assert.equal(saveState(loaded.state, true), false)
  assert.deepEqual(JSON.parse(memory.get(STORAGE_KEY)).answers, { 3525: 'D' })
  assert.deepEqual(JSON.parse(memory.get(STORAGE_KEY)).favorites, [3525])
})

test('answering #158 persists once and is skipped after refreshing or switching banks', () => {
  let state = initialState(catalog.questions, catalog.selected)
  state.page = 'compact'
  state.compact.index = state.compact.order.indexOf(158)
  storage(state)
  state = recordAnswer(state, 158, 'D', 'D')
  assert.equal(saveState(state, true), true)
  const reloaded = loadMigratedState(catalog.questions, catalog.selected, catalog.aliases).state
  assert.notEqual(reloaded.compact.order[reloaded.compact.index], 158)
  const full = resumePractice(reloaded, 'full')
  assert.notEqual(full.full.order[full.full.index], 158)
  assert.equal(full.full.order.includes(3525), false)
  assert.deepEqual(full.answers, { 158: 'D' })
})
