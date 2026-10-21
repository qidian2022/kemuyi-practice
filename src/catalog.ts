import type { Question, SelectedQuestion } from './practice'
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
