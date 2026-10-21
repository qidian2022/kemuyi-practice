export type OptionKey = 'A' | 'B' | 'C' | 'D'
export type Page = 'full' | 'compact' | 'favorites'
export type Question = {
  id: number
  question: string
  chapter: string
  sourceUrl: string
  options: { key: OptionKey; text: string }[]
  answer: OptionKey
  explanation: string
  images: string[]
}
export type SelectedQuestion = { id: number; chapter: string }
export type PracticeData = {
  version: 3
  answers: Record<number, OptionKey>
  favorites: number[]
  page: Page
  full: { order: number[]; index: number }
  compact: { order: number[]; index: number }
  favoriteIndex: number
}

export const STORAGE_KEY = 'kemuyi-practice-v3'
export const LEGACY_STORAGE_KEY = 'kemuyi-practice-v1'
export const OLD_STORAGE_KEY = 'kemuyi-practice-v2'
export const COMPACT_STORAGE_KEY = 'kemuyi-compact-practice-v1'
export const COMPACT_ORDER_STORAGE_KEY = 'kemuyi-selected-order-v1'
export const FULL_ORDER_KEY = 'kemuyi-full-order-v2'
export const ACTIVE_PAGE_KEY = 'kemuyi-active-page-v2'
export const FAVORITE_INDEX_KEY = 'kemuyi-favorite-index-v2'

export function shuffled(ids: number[]): number[] {
  const result = [...ids]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

export function initialState(questions: Question[], selected: SelectedQuestion[]): PracticeData {
  return {
    version: 3,
    answers: {},
    favorites: [],
    page: 'full',
    full: { order: shuffled(questions.map(({ id }) => id)), index: 0 },
    compact: { order: shuffled(selected.map(({ id }) => id)), index: 0 },
    favoriteIndex: 0,
  }
}

function read(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
}

function readText(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function validIds(value: unknown, valid: Set<number>): number[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is number => typeof id === 'number' && valid.has(id)))]
    : []
}

function validAnswers(value: unknown, byId: Map<number, Question>): Record<number, OptionKey> {
  const result: Record<number, OptionKey> = {}
  for (const [rawId, answer] of Object.entries(object(value))) {
    const question = byId.get(Number(rawId))
    if (question?.options.some((option) => option.key === answer)) result[question.id] = answer as OptionKey
  }
  return result
}

function safeIndex(value: unknown, length: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, 0), Math.max(length - 1, 0)) : 0
}

function validOrder(value: unknown, valid: number[], prefix = ''): number[] {
  const fresh = shuffled(valid)
  if (!Array.isArray(value)) return fresh
  const allowed = new Set(valid)
  const parsed = value.map((item) => prefix && typeof item === 'string' && item.startsWith(prefix)
    ? Number(item.slice(prefix.length)) : item)
  const kept = parsed.filter((id): id is number => typeof id === 'number' && allowed.has(id))
  return kept.length === valid.length && new Set(kept).size === valid.length ? kept : fresh
}

export function parseState(value: unknown, questions: Question[], selected: SelectedQuestion[]): PracticeData | null {
  const root = object(value)
  if (root.version !== 3 || !root.full || !root.compact) return null
  const byId = new Map(questions.map((question) => [question.id, question]))
  const full = object(root.full)
  const compact = object(root.compact)
  const fullOrder = validOrder(full.order, questions.map(({ id }) => id))
  const compactOrder = validOrder(compact.order, selected.map(({ id }) => id))
  const favorites = validIds(root.favorites, new Set(byId.keys()))
  return {
    version: 3,
    answers: validAnswers(root.answers, byId),
    favorites,
    page: root.page === 'compact' || root.page === 'favorites' ? root.page : 'full',
    full: { order: fullOrder, index: full.index === fullOrder.length ? fullOrder.length : safeIndex(full.index, fullOrder.length) },
    compact: { order: compactOrder, index: compact.index === compactOrder.length ? compactOrder.length : safeIndex(compact.index, compactOrder.length) },
    favoriteIndex: safeIndex(root.favoriteIndex, favorites.length),
  }
}

export function loadMigratedState(questions: Question[], selected: SelectedQuestion[]): { state: PracticeData; needsSave: boolean } {
  const current = parseState(read(STORAGE_KEY), questions, selected)
  if (current) {
    const resumed = resumePractice(current)
    return { state: resumed, needsSave: resumed !== current }
  }

  const state = initialState(questions, selected)
  const old = object(read(OLD_STORAGE_KEY))
  const legacy = object(read(LEGACY_STORAGE_KEY))
  const source = Object.keys(old).length ? old : legacy
  const byId = new Map(questions.map((question) => [question.id, question]))
  state.answers = validAnswers(old.answers, byId)
  state.favorites = validIds(source.favorites, new Set(byId.keys()))

  const savedFull = object(read(FULL_ORDER_KEY))
  const savedFullOrder = savedFull.order ?? old.order
  state.full.order = validOrder(savedFullOrder, questions.map(({ id }) => id), 'full:')
  if (Array.isArray(savedFullOrder) && typeof savedFull.index === 'number') {
    const valid = new Set(state.full.order)
    state.full.index = safeIndex(
      savedFullOrder.slice(0, savedFull.index).filter((key) => valid.has(Number(String(key).replace(/^full:/, '')))).length,
      state.full.order.length,
    )
  } else {
    state.full.index = safeIndex(old.allIndex, state.full.order.length)
  }

  const savedCompact = object(read(COMPACT_ORDER_STORAGE_KEY))
  state.compact.order = validOrder(savedCompact.order, selected.map(({ id }) => id))
  state.compact.index = safeIndex(savedCompact.allIndex, state.compact.order.length)
  const page = readText(ACTIVE_PAGE_KEY)
  const oldBank = readText('kemuyi-active-bank-v1')
  state.page = page === 'full' || page === 'compact' || page === 'favorites' ? page
    : source.mode === 'favorites' ? 'favorites' : oldBank === 'compact' ? 'compact' : 'full'
  const favoriteIndex = Number(readText(FAVORITE_INDEX_KEY))
  state.favoriteIndex = safeIndex(favoriteIndex, state.favorites.length)
  return { state: resumePractice(state), needsSave: true }
}

export function saveState(state: PracticeData, hasWriteLock: boolean): boolean {
  if (!hasWriteLock) return false
  try {
    const serialized = JSON.stringify(state)
    localStorage.setItem(STORAGE_KEY, serialized)
    return localStorage.getItem(STORAGE_KEY) === serialized
  } catch { return false }
}

export function clearLegacyState(): void {
  const keys = [
    OLD_STORAGE_KEY, LEGACY_STORAGE_KEY, COMPACT_STORAGE_KEY, COMPACT_ORDER_STORAGE_KEY,
    FULL_ORDER_KEY, ACTIVE_PAGE_KEY, FAVORITE_INDEX_KEY,
    'kemuyi-full-order-v1', 'kemuyi-favorite-index-v1', 'kemuyi-active-bank-v1',
  ]
  for (const key of keys) {
    try { localStorage.removeItem(key) } catch { /* The confirmed new save remains available. */ }
  }
}

export function recordAnswer(previous: PracticeData, questionId: number, answer: OptionKey, correctAnswer: OptionKey): PracticeData {
  if (previous.answers[questionId]) return previous
  return {
    ...previous,
    answers: { ...previous.answers, [questionId]: answer },
    favorites: answer !== correctAnswer && !previous.favorites.includes(questionId)
      ? [...previous.favorites, questionId] : previous.favorites,
  }
}

// A bank-length index means that every question in this bank has been answered.
export function findUnansweredIndex(
  order: number[], answers: PracticeData['answers'], start: number,
  direction: 1 | -1 = 1, wrap = true,
): number {
  for (let offset = 0; offset < order.length; offset += 1) {
    const position = start + offset * direction
    if (!wrap && (position < 0 || position >= order.length)) break
    const index = ((position % order.length) + order.length) % order.length
    if (!answers[order[index]]) return index
  }
  return order.length
}

export function resumePractice(previous: PracticeData, page: Page = previous.page): PracticeData {
  if (page === 'favorites') return previous.page === page ? previous : { ...previous, page }
  const bank = previous[page]
  const index = findUnansweredIndex(bank.order, previous.answers, bank.index)
  return previous.page === page && bank.index === index ? previous
    : { ...previous, page, [page]: { ...bank, index } }
}

export function movePractice(previous: PracticeData, direction: 1 | -1): PracticeData {
  if (previous.page === 'favorites') {
    const index = safeIndex(previous.favoriteIndex + direction, previous.favorites.length)
    return index === previous.favoriteIndex ? previous : { ...previous, favoriteIndex: index }
  }
  const bank = previous[previous.page]
  const index = findUnansweredIndex(bank.order, previous.answers, bank.index + direction, direction, direction === 1)
  if (index === bank.index || (direction === -1 && index === bank.order.length)) return previous
  return { ...previous, [previous.page]: { ...bank, index } }
}

export function restartState(previous: PracticeData, bank: 'full' | 'compact', selectedIds: Set<number>): PracticeData {
  return {
    ...previous,
    answers: bank === 'full' ? {} : Object.fromEntries(
      Object.entries(previous.answers).filter(([id]) => !selectedIds.has(Number(id))),
    ),
    full: bank === 'full' ? { order: shuffled(previous.full.order), index: 0 } : previous.full,
    compact: { order: shuffled(previous.compact.order), index: 0 },
    favoriteIndex: bank === 'full' ? 0 : previous.favoriteIndex,
  }
}
