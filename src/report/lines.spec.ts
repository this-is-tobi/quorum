import { describe, expect, it } from 'vitest'
import type { LensVote, Verdict, VoteFailure } from '../core/types.ts'
import { cast, reportResult, SQL } from '../testing/report.ts'
import { voteFailureWords, votesWords } from './lines.ts'
import { publicView } from './view.ts'

/** A failed vote of the lens `angle`, which failed with `failure`. */
function failed(failure: VoteFailure | null, angle = 'b'): LensVote {
  return {
    angle,
    vote: null,
    error: 'x',
    failure,
  }
}

/** A verdict of `votes`, `keptVotes` of them kept. */
function verdictOf(keptVotes: number, votes: LensVote[]): Verdict {
  return {
    ...SQL,
    keptVotes,
    totalVotes: votes.length,
    votes,
  }
}

describe('voteFailureWords', () => {
  it.each<[VoteFailure | null, string]>([
    [
      { kind: 'http', status: 503 },
      'an http 503 error',
    ],
    [
      { kind: 'http' },
      'an http error',
    ],
    [
      { kind: 'network' },
      'a network error',
    ],
    [
      { kind: 'process' },
      'a process error',
    ],
    [
      { kind: 'timeout' },
      'a timeout',
    ],
    [
      { kind: 'aborted' },
      'aborted',
    ],
    [
      { kind: 'refusal' },
      'a refusal by the model',
    ],
    [
      { kind: 'invalid-response' },
      'an invalid response',
    ],
    [
      { kind: 'unsupported' },
      'unsupported by its provider',
    ],
    [
      { kind: 'too-large' },
      'too large for its model',
    ],
    [
      { kind: 'truncated', noAnswer: 'thinking' },
      'cut off while reasoning',
    ],
    [
      { kind: 'truncated', noAnswer: 'window' },
      'cut off at the server\'s window',
    ],
    [
      { kind: 'truncated', noAnswer: 'reply' },
      'cut off',
    ],
    [
      { kind: 'truncated', noAnswer: 'empty' },
      'cut off',
    ],
    [
      { kind: 'truncated' },
      'cut off',
    ],
    [
      { kind: 'no-answer', noAnswer: 'thinking' },
      'only reasoning',
    ],
    [
      { kind: 'no-answer', noAnswer: 'empty' },
      'an empty reply',
    ],
    [
      { kind: 'no-answer', noAnswer: 'reply' },
      'no answer',
    ],
    [
      { kind: 'no-answer', noAnswer: 'window' },
      'no answer',
    ],
    [
      { kind: 'no-answer' },
      'no answer',
    ],
    [
      { kind: 'token-cap' },
      'stopped by the token cap',
    ],
    [
      { kind: 'review-deadline' },
      'stopped by the deadline',
    ],
    [
      { kind: 'interrupted' },
      'stopped by the interrupt',
    ],
    [
      { kind: 'provider-down' },
      'its provider down',
    ],
    [
      { kind: 'unusable-reply' },
      'an unreadable reply',
    ],
    [
      { kind: 'unknown' },
      'an unknown error',
    ],
    [null, 'an unknown error'],
  ])('words a vote failed with %j as %s', (failure, words) => {
    expect(voteFailureWords(failure)).toBe(words)
  })

  it('reads own data alone, and never writes a word the failure holds', () => {
    const forged = (value: unknown): string => voteFailureWords(value as VoteFailure)
    expect(forged({ kind: 'a server said so' })).toBe('an unknown error')
    expect(forged({ kind: 'constructor' })).toBe('an unknown error')
    expect(forged({ kind: '__proto__' })).toBe('an unknown error')
    expect(forged(Object.create({ kind: 'timeout' }))).toBe('an unknown error')
    expect(forged({ kind: 'http', status: '503 <b>' })).toBe('an http error')
    expect(forged({ kind: 'http', status: 5030 })).toBe('an http error')
    expect(forged({ kind: 'http', status: 503.5 })).toBe('an http error')
    expect(forged({ kind: 'truncated', noAnswer: 'a model said so' })).toBe('cut off')
    expect(forged({ kind: 'no-answer', noAnswer: 'a model said so' })).toBe('no answer')
    expect(forged(undefined)).toBe('an unknown error')
    expect(forged('timeout')).toBe('an unknown error')
  })
})

describe('votesWords', () => {
  it('writes a finding\'s failed votes after its count, each distinct word once, in lens order', () => {
    expect(votesWords(verdictOf(1, [
      cast(true),
      failed({ kind: 'truncated', noAnswer: 'thinking' }),
      cast(false),
    ]))).toBe('kept by 1 of 3 lenses, 1 vote failed: cut off while reasoning')
    expect(votesWords(verdictOf(0, [
      failed({ kind: 'timeout' }, 'a'),
      failed({ kind: 'no-answer', noAnswer: 'thinking' }, 'b'),
      failed({ kind: 'timeout' }, 'c'),
    ]))).toBe('kept by 0 of 3 lenses, 3 votes failed: a timeout, only reasoning')
    expect(votesWords(verdictOf(1, [
      failed({ kind: 'network' }),
      cast(true),
      failed({ kind: 'http', status: 503 }),
    ]))).toBe('kept by 1 of 3 lenses, 2 votes failed: a network error, an http 503 error')
  })

  it('writes the count alone when no vote failed, and an unknown error for a failed vote that records none', () => {
    expect(votesWords(verdictOf(3, [
      cast(true),
      cast(true),
      cast(true),
    ]))).toBe('kept by 3 of 3 lenses')
    expect(votesWords(verdictOf(1, [
      cast(true),
      failed(null),
      cast(false),
    ]))).toBe('kept by 1 of 3 lenses, 1 vote failed: an unknown error')
  })

  it('gives a public view\'s votes the same words', () => {
    const lacking: Verdict = {
      ...verdictOf(1, [
        cast(true),
        failed({ kind: 'truncated', noAnswer: 'window' }),
        failed({ kind: 'unusable-reply' }, 'c'),
      ]),
      confidence: undefined,
    }
    const view = publicView(reportResult({
      kept: [],
      unreviewed: [lacking],
      discarded: [],
    }))
    expect(votesWords(view.unreviewed[0])).toBe(votesWords(lacking))
    expect(votesWords(view.unreviewed[0])).toBe('kept by 1 of 3 lenses, 2 votes failed: cut off at the server\'s window, an unreadable reply')
  })
})
