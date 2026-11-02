// Structural schema shared by browser archives and the API. Catalog-specific IDs are normalized by practice.ts.
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function ids(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 5000 && new Set(value).size === value.length && value.every((id) => Number.isInteger(id) && id > 0 && id <= 100000)
}
function answers(value: unknown): boolean {
  return object(value) && Object.keys(value).length <= 5000 && Object.entries(value).every(([id, answer]) => /^[1-9][0-9]{0,5}$/.test(id) && Number(id) <= 100000 && typeof answer === 'string' && ['A', 'B', 'C', 'D'].includes(answer))
}
function bank(value: unknown): boolean {
  return object(value) && ids(value.order) && Number.isInteger(value.index) && (value.index as number) >= 0 && (value.index as number) <= value.order.length
}
export function validProgress(value: unknown): boolean {
  return object(value) && value.version === 3 && answers(value.answers) && ids(value.favorites) &&
    typeof value.page === 'string' && ['full', 'compact', 'favorites'].includes(value.page) && bank(value.full) && bank(value.compact) &&
    Number.isInteger(value.favoriteIndex) && (value.favoriteIndex as number) >= 0 && (value.favoriteIndex as number) <= value.favorites.length &&
    (value.favoritePractice === null || (bank(value.favoritePractice) && object(value.favoritePractice) && answers(value.favoritePractice.answers)))
}
