export const isNumber = (v: unknown): v is number => typeof v === 'number'
export const isString = (v: unknown): v is string => typeof v === 'string'
// A document that does not parse reads as nothing rather than throwing.
export const readJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
