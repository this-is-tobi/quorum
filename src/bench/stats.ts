/**
 * The statistics of the report, written by hand and held to reference values: the Wilson score
 * interval of a rate, the exact two-sided sign test, nearest-rank percentiles, the plain mean, the phi
 * coefficient of two lenses' errors and the effective number of votes. Pure code, with no package behind it; each
 * function throws a `RangeError` for an argument outside its domain.
 */

/** The two-sided 95% quantile of the standard normal distribution. */
export const Z95 = 1.959963984540054

/** A comparison is resolved when its p is below this. */
export const ALPHA = 0.05

/** A confidence interval of a rate, inside 0 and 1. */
export interface Interval {
  readonly low: number
  readonly high: number
}

/**
 * The Wilson score interval of a rate over `n` cases, at the confidence `z` names (95% by default).
 * With `d = 1 + z^2/n`, the center is `(rate + z^2/(2n)) / d` and the half-width
 * `(z/d) * sqrt(rate(1 - rate)/n + z^2/(4n^2))`; the bounds are clamped to [0, 1]. A rate of 0 has a
 * lower bound of exactly 0, and a rate of 1 an upper bound of exactly 1, which the sums above only
 * reach to within a rounding error.
 *
 * `rate` is a mean of case scores, over `n` cases, not a count of successes over trials: for a
 * fractional score the interval is conservative, since it is as wide as one for a count of `n` cases.
 *
 * Reference values at 95%: a rate of 0.5 over 10 cases gives [0.2366, 0.7634], 0 gives [0, 0.2775]
 * and 1 gives [0.7225, 1].
 *
 * `z` is a number from 0 to 100, which keeps `z * z` finite: no confidence level a double can tell from 1
 * needs a larger one.
 *
 * @throws {RangeError} when `n` is not a positive integer, `rate` is outside [0, 1], or `z` is outside
 * [0, 100].
 */
export function wilson(rate: number, n: number, z = Z95): Interval {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('the number of cases must be a positive integer')
  if (!(rate >= 0 && rate <= 1)) throw new RangeError('the rate must be between 0 and 1')
  if (!(z >= 0 && z <= 100)) throw new RangeError('z must be a number from 0 to 100')
  const d = 1 + z * z / n
  const center = (rate + z * z / (2 * n)) / d
  const halfWidth = z / d * Math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n))
  const low = rate === 0
    ? 0
    : Math.max(0, center - halfWidth)
  const high = rate === 1
    ? 1
    : Math.min(1, center + halfWidth)
  return { low, high }
}

/**
 * The most cases that differ `signTest` takes: ten times `MAX_CASES`, the most cases a suite holds. It
 * also makes both counts safe integers, and keeps one call to milliseconds under Node and Bun.
 */
const MAX_SIGN_TEST_CASES = 10_000

/**
 * The two-sided p of a sign test: `better` and `worse` cases that differ, ties left out. With
 * `n = better + worse` and `k = min(better, worse)`, p is `2 * sum(C(n, i), i = 0..k) / 2^n`, at most 1,
 * and 1 when `n` is 0. The coefficients are summed exactly in `BigInt`, each from the previous one
 * (`C(n, i) = C(n, i - 1) * (n - i + 1) / i`), then both terms are shifted right by the same
 * `max(0, n + 1 - 1000)` bits before the division, so each stays finite as a `Number`.
 *
 * While `n` is at most 1000, as `MAX_CASES` keeps it, the shift drops nothing and p is the exact value
 * rounded once to a double. Past 1000 it drops low bits, so p is the exact value truncated to a multiple
 * of 2^-999, then rounded to a double, which can land above the exact value by up to half a step; any p
 * below 2^-999 (about 1.9e-301) reads 0. `n` is capped at `MAX_SIGN_TEST_CASES`.
 *
 * Reference values: 1 better of 10 gives 0.021484375, 5 of 20 gives 0.04138946533203125, 0 of 6 gives
 * 0.03125, 0 of 5 gives 0.0625, and 0 of 0 gives 1.
 *
 * @throws {RangeError} when a count is not an integer of at least 0, or the counts add up to more than
 * `MAX_SIGN_TEST_CASES`.
 */
export function signTest(better: number, worse: number): number {
  if (!Number.isInteger(better) || better < 0 || !Number.isInteger(worse) || worse < 0) throw new RangeError('a count must be a whole number of at least 0')
  const n = better + worse
  if (n > MAX_SIGN_TEST_CASES) throw new RangeError(`the counts must add up to at most ${MAX_SIGN_TEST_CASES}`)
  if (n === 0) return 1
  const k = Math.min(better, worse)
  let coefficient = 1n
  let sum = 1n
  for (let i = 1; i <= k; i++) {
    coefficient = coefficient * BigInt(n - i + 1) / BigInt(i)
    sum += coefficient
  }
  const shift = BigInt(Math.max(0, n + 1 - 1000))
  return Math.min(1, Number((2n * sum) >> shift) / Number((1n << BigInt(n)) >> shift))
}

/**
 * The nearest-rank percentile: the value at rank `ceil(percent * n / 100)` of the `n` values sorted
 * ascending, the product taken first so the rank stays an integer. The values are not changed.
 *
 * Reference values: the 50th of 1 to 5 is 3, the 95th of 1 to 20 is 19, the 100th of 1 to 3 is 3.
 *
 * @throws {RangeError} when there is no value, or `percent` is outside (0, 100].
 */
export function nearestRank(values: readonly number[], percent: number): number {
  if (values.length === 0) throw new RangeError('there must be at least one value')
  if (!(percent > 0 && percent <= 100)) throw new RangeError('the percent must be above 0 and at most 100')
  const rank = Math.max(1, Math.ceil(percent * values.length / 100))
  return [...values].sort((a, b) => a - b)[rank - 1]
}

/**
 * The plain mean: the sum over the count, so values that are all 1 give exactly 1 and all 0 exactly 0.
 *
 * @throws {RangeError} when there is no value.
 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('there must be at least one value')
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** How two lenses' errors fell over the findings both voted on: each cell counts findings. */
export interface ErrorTable {
  /** Both lenses erred. */
  readonly both: number
  /** Only the first lens erred. */
  readonly onlyFirst: number
  /** Only the second lens erred. */
  readonly onlySecond: number
  /** Neither erred. */
  readonly neither: number
}

/**
 * The phi coefficient of a 2x2 table, the correlation of two lenses' errors: with
 * `product = (both + onlyFirst) * (onlySecond + neither) * (both + onlySecond) * (onlyFirst + neither)`,
 * `(both * neither - onlyFirst * onlySecond) / sqrt(product)`, from -1 to 1. It is undefined, and this
 * returns `undefined`, when `product` is 0: a lens whose errors never vary (or always do), or no
 * finding at all, has no correlation with anything.
 *
 * Reference values: [10, 5, 5, 30] (both, only first, only second, neither) gives 0.5238095238095238,
 * [5, 5, 5, 5] gives 0, [0, 10, 10, 0] gives -1, [7, 0, 0, 3] gives 1 and [0, 0, 4, 6] is undefined.
 *
 * @throws {RangeError} when a count is not a whole number of at least 0.
 */
export function phi(table: ErrorTable): number | undefined {
  const { both, onlyFirst, onlySecond, neither } = table
  for (const count of [both, onlyFirst, onlySecond, neither]) {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('a count must be a whole number of at least 0')
  }
  const product = (both + onlyFirst) * (onlySecond + neither) * (both + onlySecond) * (onlyFirst + neither)
  if (product === 0) return undefined
  return (both * neither - onlyFirst * onlySecond) / Math.sqrt(product)
}

/**
 * The effective number of independent votes that `lenses` lenses are worth when their errors correlate
 * by `meanPhi` on average: with `d = 1 + (lenses - 1) * meanPhi`, `lenses / d`, which is `lenses` for
 * errors that do not correlate, 1 for errors that always go together, and `undefined` when `d` is not
 * above 0: a negative mean that strong has no effective number of votes.
 *
 * Reference values: 3 lenses at 0 gives 3, at 1 gives 1 and at 0.5 gives 1.5; 1 lens gives 1 at any
 * mean; 3 lenses at -0.5 is undefined.
 *
 * @throws {RangeError} when `lenses` is not a positive integer, or `meanPhi` is not from -1 to 1.
 */
export function effectiveVotes(lenses: number, meanPhi: number): number | undefined {
  if (!Number.isInteger(lenses) || lenses < 1) throw new RangeError('the lenses must be a positive integer')
  if (!(meanPhi >= -1 && meanPhi <= 1)) throw new RangeError('the mean phi must be from -1 to 1')
  const d = 1 + (lenses - 1) * meanPhi
  return d > 0
    ? lenses / d
    : undefined
}
