/** `ms` in whole seconds, never below 0. */
const wholeSeconds = (ms: number): number => Math.max(0, Math.round(ms / 1000))

const twoDigits = (count: number): string => String(count).padStart(2, '0')

/** A duration in words, with whole seconds throughout: `4s`, `42s`, `2m14s`, `1h02m09s`, each unit after the first two digits. */
export function elapsedWords(ms: number): string {
  const seconds = wholeSeconds(ms)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${twoDigits(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h${twoDigits(minutes % 60)}m${twoDigits(seconds % 60)}s`
}
