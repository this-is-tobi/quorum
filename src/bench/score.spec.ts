import { describe, expect, it } from 'vitest'
import { resultWith, verdict } from '../testing/bench.ts'
import { catches, scoreReview } from './score.ts'
import type { BugCase, ControlCase } from './suite.ts'

const location = { file: 'a.js', start: 10, end: 12 }
const bug: BugCase = {
  id: 'exec',
  kind: 'bug',
  patch: 'exec.patch',
  locations: [
    location,
    { file: 'b.js', start: 1, end: 1 },
  ],
}
const control: ControlCase = { id: 'docs', kind: 'control', patch: 'docs.patch' }

describe('catches', () => {
  it.each<[number, boolean]>([
    [6, false],
    [7, true],
    [11, true],
    [15, true],
    [16, false],
  ])('a finding at line %i of a.js, for lines 10 to 12 and a window of 3: %s', (line, caught) => {
    expect(catches({ file: 'a.js', line }, location, 3)).toBe(caught)
  })

  it('compares the file exactly, as the diff keys it, and takes the window as it is', () => {
    expect(catches({ file: 'b/a.js', line: 11 }, location, 3)).toBe(false)
    expect(catches({ file: './a.js', line: 11 }, location, 3)).toBe(false)
    expect(catches({ file: 'a.js', line: 12 }, location, 0)).toBe(true)
    expect(catches({ file: 'a.js', line: 13 }, location, 0)).toBe(false)
  })
})

describe('scoreReview', () => {
  it('catches a bug by a kept finding at any confidence, which is a proposed finding too', () => {
    expect(scoreReview(resultWith({
      kept: [
        verdict('b.js', 1, 'medium'),
      ],
    }), bug, 3)).toEqual({
      keptCatch: true,
      proposedCatch: true,
      unmatchedKept: 0,
      incomplete: false,
    })
  })

  it('catches it by a proposed finding only when the panel discarded it or left it unreviewed', () => {
    expect(scoreReview(resultWith({
      discarded: [
        verdict('a.js', 10),
      ],
    }), bug, 3)).toMatchObject({ keptCatch: false, proposedCatch: true })
    expect(scoreReview(resultWith({
      unreviewed: [
        verdict('a.js', 12),
      ],
    }), bug, 3)).toMatchObject({ keptCatch: false, proposedCatch: true, incomplete: true })
  })

  it('counts the kept findings that catch nothing, and misses a bug no finding is near', () => {
    const result = resultWith({
      kept: [
        verdict('a.js', 30, 'high'),
        verdict('c.js', 1, 'high'),
      ],
      discarded: [
        verdict('a.js', 40),
      ],
    })
    expect(scoreReview(result, bug, 3)).toEqual({
      keptCatch: false,
      proposedCatch: false,
      unmatchedKept: 2,
      incomplete: false,
    })
  })

  it('counts only the kept findings that miss when a kept finding catches the bug', () => {
    expect(scoreReview(resultWith({
      kept: [
        verdict('a.js', 11, 'high'),
        verdict('c.js', 1, 'high'),
      ],
    }), bug, 3)).toMatchObject({ keptCatch: true, unmatchedKept: 1 })
  })

  it('scores a control: no catch, and every kept finding unmatched', () => {
    expect(scoreReview(resultWith({
      kept: [
        verdict('README.md', 1, 'high'),
      ],
    }), control, 3)).toEqual({
      keptCatch: false,
      proposedCatch: false,
      unmatchedKept: 1,
      incomplete: false,
    })
  })

  it('marks a review incomplete for a gap of any profile', () => {
    expect(scoreReview(resultWith({
      incomplete: [
        { profile: 'team', reason: 'findings-capped', detail: '1 of 51' },
      ],
    }), control, 3).incomplete).toBe(true)
  })
})
