import type { Question, QuestionAliases, SelectedQuestion } from './practice'
export type Bank = 'full' | 'compact'
export type QuestionRef = { bank: Bank; id: number; question: Question }
export function makeRefs(questions: Question[], selected: SelectedQuestion[]): { full: QuestionRef[]; compact: QuestionRef[] } {
  const byId = new Map(questions.map((question) => [question.id, question]))
  return {
    full: questions.map((question) => ({ bank: 'full', id: question.id, question })),
    compact: selected.map(({ id, chapter }) => {
      const source = byId.get(id)
      if (!source) throw new Error(`精选题 ${id} 不在原题库中`)
      return { bank: 'compact', id, question: { ...source, chapter } }
    }),
  }
}


export function deduplicateCatalog(questions: Question[], selected: SelectedQuestion[]): {
  questions: Question[]; selected: SelectedQuestion[]; aliases: QuestionAliases
} {
  const groups = new Map<string, Question[]>()
  const selectedIds = new Set(selected.map(({ id }) => id))
  for (const question of questions) {
    // Image and answer differences matter even when a generic image-question stem is identical.
    const key = JSON.stringify([question.question, question.options.map(({ key, text }) => [key, text]), question.answer, question.images])
    const group = groups.get(key)
    if (group) group.push(question)
    else groups.set(key, [question])
  }
  const aliases: QuestionAliases = {}
  const unique = [...groups.values()].map((group) => {
    const canonical = group.find(({ id }) => selectedIds.has(id)) ?? group[0]
    for (const { id } of group) if (id !== canonical.id) aliases[id] = canonical.id
    return canonical
  })
  const seen = new Set<number>()
  const uniqueSelected = selected.flatMap((entry) => {
    const id = aliases[entry.id] ?? entry.id
    if (seen.has(id)) return []
    seen.add(id)
    return [{ ...entry, id }]
  })
  return { questions: unique, selected: uniqueSelected, aliases }
}
