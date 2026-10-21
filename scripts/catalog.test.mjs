import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { deduplicateCatalog, makeRefs } from '../src/catalog.ts'
import { initialState, movePractice, recordAnswer, resumePractice } from '../src/practice.ts'
import { excludedFullIds, parseQuestions, parseSelectedQuestions } from './prepare-data.mjs'

const full = [{ id: 10, question: '原题', chapter: '原题', sourceUrl: '', options: [{ key: 'A' }, { key: 'B' }], answer: 'B', explanation: '原解析', images: [] }]
const selected = [{ id: 10, chapter: 'C1/C2 精选' }]

test('selected refs reuse the source explanation and answer record', () => {
  const refs = makeRefs(full, selected)
  assert.equal(refs.full[0].id, refs.compact[0].id)
  assert.equal(refs.compact[0].question.question, '原题')
  assert.equal(refs.compact[0].question.chapter, 'C1/C2 精选')
  assert.equal(refs.compact[0].question.explanation, '原解析')
  assert.equal(refs.full[0].question.explanation, '原解析')
  assert.equal(full[0].chapter, '原题')
  const state = recordAnswer(initialState(full, selected), 10, 'A', 'B')
  assert.equal(state.answers[refs.full[0].id], 'A')
  assert.equal(state.answers[refs.compact[0].id], 'A')
  assert.deepEqual(state.favorites, [10])
})

test('all 300 selected questions retain their original website explanations', () => {
  const root = new URL('..', import.meta.url)
  const questions = parseQuestions(readFileSync(new URL('data/题库.md', root), 'utf8')).questions
    .filter((question) => !excludedFullIds.has(question.id))
  const selectedQuestions = parseSelectedQuestions(
    readFileSync(new URL('data/科目一_C1C2_原题精选300.md', root), 'utf8'), questions,
  )
  const refs = makeRefs(questions, selectedQuestions)
  const sourceById = new Map(questions.map((question) => [question.id, question]))
  assert.equal(refs.compact.length, 300)
  for (const ref of refs.compact) {
    assert.ok(ref.question.explanation.trim(), `精选题 ${ref.id} 缺少解析`)
    assert.equal(ref.question.explanation, sourceById.get(ref.id).explanation)
    assert.equal(ref.question.sourceUrl, sourceById.get(ref.id).sourceUrl)
  }
})


test('completing 300 selected originals leaves exactly 1350 unique unanswered full-bank questions', () => {
  const raw = JSON.parse(readFileSync(new URL('../public/data/catalog.json', import.meta.url), 'utf8'))
  const catalog = deduplicateCatalog(raw.questions, raw.selected)
  let state = initialState(catalog.questions, catalog.selected)
  state.page = 'compact'
  const byId = new Map(catalog.questions.map((question) => [question.id, question]))
  for (const id of state.compact.order) state = recordAnswer(state, id, byId.get(id).answer, byId.get(id).answer)
  state = movePractice(state, 1)
  assert.equal(state.compact.index, 300)
  state = resumePractice(state, 'full')
  const remaining = []
  while (state.full.index < state.full.order.length) {
    const id = state.full.order[state.full.index]
    assert.ok(!state.answers[id], `already answered original ${id} was shown again`)
    remaining.push(id)
    state = movePractice(recordAnswer(state, id, byId.get(id).answer, byId.get(id).answer), 1)
  }
  assert.equal(remaining.length, 1350)
  assert.equal(new Set(remaining).size, 1350)
  assert.equal(Object.keys(state.answers).length, 1650)
})
