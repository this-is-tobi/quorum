import { describe, expect, it } from 'vitest'
import type { ContextDocument, LensVote, Verdict, VoteFailure } from '../core/types.ts'
import { cast, contextDocument, reportResult, SQL } from '../testing/report.ts'
import { contextSummary, documentLine, documentLineParts, durationText, tokenWords, voteFailureWords, votesWords } from './lines.ts'
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

describe('tokenWords', () => {
  it.each<[number, string]>([
    [999, '999'],
    [1234, '1.23k'],
    [12_345, '12.3k'],
    [812_000, '812k'],
    [9_864_619, '9.86M'],
  ])('writes %s tokens as %s', (tokens, words) => {
    expect(tokenWords(tokens)).toBe(words)
  })
})

describe('durationText', () => {
  it.each<[number, string]>([
    [-5, '0.0s'],
    [0, '0.0s'],
    [850, '0.9s'],
    [999, '1.0s'],
    [4300, '4.3s'],
    [9949, '9.9s'],
    [9950, '10s'],
    [42_400, '42s'],
    [59_500, '1m00s'],
    [59_950, '1m00s'],
    [60_000, '1m00s'],
    [134_000, '2m14s'],
    [468_000, '7m48s'],
    [3_729_000, '1h02m09s'],
    [86_400_000, '24h00m00s'],
  ])('writes %i ms as %s, one form for every line a person reads', (ms, words) => {
    expect(durationText(ms)).toBe(words)
  })
})

/** The commit a review reads documents from, in the full form a record holds: its short id is `1f3a9c2`. */
const COMMIT = '1f3a9c2'.padEnd(40, 'a')

/** The hash of a file's text, in the full form a record holds: its first 12 digits are `3f2a9c1d0b7e`. */
const HASH = '3f2a9c1d0b7e'.padEnd(64, '0')

/** A repository document `changes` replaces fields of: the guidelines of `security` at `docs/threat-model.md`, read at `COMMIT`. */
function repositoryDocument(changes: Partial<ContextDocument> = {}): ContextDocument {
  return contextDocument({
    origin: 'repository',
    path: 'docs/threat-model.md',
    commit: COMMIT,
    sha256: HASH,
    ...changes,
  })
}

describe('documentLine', () => {
  it.each<[string, string, ContextDocument]>([
    [
      'the profile\'s own text',
      'context: security guidelines of the profile, 1830 bytes',
      contextDocument(),
    ],
    [
      'a file, with the first 12 digits of its hash',
      'context: naming guidelines from a file, sha256 3f2a9c1d0b7e, 4100 bytes',
      contextDocument({
        profile: 'naming',
        origin: 'config',
        sha256: HASH,
        bytes: 4100,
      }),
    ],
    [
      'a config\'s text, with no hash',
      'context: naming do-not-report text written in the config, 12 bytes',
      contextDocument({
        profile: 'naming',
        kind: 'do-not-report',
        origin: 'config',
        bytes: 12,
      }),
    ],
    [
      'the repository, with its path and the commit\'s first 7 characters',
      'context: security guidelines "docs/threat-model.md" at 1f3a9c2, 1830 bytes',
      repositoryDocument(),
    ],
    [
      'the repository, a do-not-report text',
      'context: naming do-not-report text ".github/skip.md" at 1f3a9c2, 40 bytes',
      repositoryDocument({
        profile: 'naming',
        kind: 'do-not-report',
        path: '.github/skip.md',
        bytes: 40,
      }),
    ],
    [
      'the repository, optional and not found',
      'context: naming do-not-report text "REVIEW-skip.md" at 1f3a9c2: missing, and optional',
      repositoryDocument({
        profile: 'naming',
        kind: 'do-not-report',
        path: 'REVIEW-skip.md',
        sha256: undefined,
        status: 'missing',
        bytes: 0,
      }),
    ],
    [
      'a text that held nothing once cleaned',
      'context: security guidelines of the profile, 0 bytes',
      contextDocument({ bytes: 0 }),
    ],
    [
      'a file the cleaner removed hidden characters and a comment from',
      'context: naming guidelines from a file, sha256 3f2a9c1d0b7e, 4100 bytes; the cleaner removed 3 hidden character(s) and 1 comment(s)',
      contextDocument({
        profile: 'naming',
        origin: 'config',
        sha256: HASH,
        bytes: 4100,
        removed: { characters: 3, comments: 1, entities: 0 },
      }),
    ],
    [
      'a text the cleaner removed all three kinds from',
      'context: security guidelines of the profile, 1830 bytes; the cleaner removed 2 hidden character(s), 1 comment(s) and 4 character reference(s)',
      contextDocument({
        removed: { characters: 2, comments: 1, entities: 4 },
      }),
    ],
    [
      'a text the cleaner removed hidden characters alone from',
      'context: security guidelines of the profile, 1830 bytes; the cleaner removed 1 hidden character(s)',
      contextDocument({
        removed: { characters: 1, comments: 0, entities: 0 },
      }),
    ],
    [
      'a text the cleaner removed comments alone from',
      'context: security guidelines of the profile, 1830 bytes; the cleaner removed 5 comment(s)',
      contextDocument({
        removed: { characters: 0, comments: 5, entities: 0 },
      }),
    ],
    [
      'a text the cleaner removed character references alone from',
      'context: security guidelines of the profile, 1830 bytes; the cleaner removed 7 character reference(s)',
      contextDocument({
        removed: { characters: 0, comments: 0, entities: 7 },
      }),
    ],
    [
      'a text the cleaner removed comments and character references from',
      'context: security guidelines of the profile, 1830 bytes; the cleaner removed 1 comment(s) and 2 character reference(s)',
      contextDocument({
        removed: { characters: 0, comments: 1, entities: 2 },
      }),
    ],
  ])('writes a document of %s as %j', (_name, line, record) => {
    expect(documentLine(record)).toBe(line)
  })

  it('writes a repository path as JSON, cut at 100 code points, and a path with a quote or a space whole', () => {
    expect(documentLine(repositoryDocument({ path: `${'d/'.repeat(60)}x.md` }))).toBe(`context: security guidelines "${'d/'.repeat(50)}…" at 1f3a9c2, 1830 bytes`)
    expect(documentLine(repositoryDocument({ path: 'my "rules" file.md' }))).toBe('context: security guidelines "my \\"rules\\" file.md" at 1f3a9c2, 1830 bytes')
  })
})

describe('documentLineParts', () => {
  it('splits a document\'s line into a head that holds its place whole and a tail, which read back as the line', () => {
    const cleaned = { characters: 3, comments: 1, entities: 0 }
    const missing = repositoryDocument({
      path: 'REVIEW-skip.md',
      sha256: undefined,
      status: 'missing',
      bytes: 0,
    })
    expect(documentLineParts(repositoryDocument({ removed: cleaned }))).toEqual({
      head: 'context: security guidelines "docs/threat-model.md" at 1f3a9c2,',
      tail: '1830 bytes; the cleaner removed 3 hidden character(s) and 1 comment(s)',
    })
    expect(documentLineParts(missing)).toEqual({
      head: 'context: security guidelines "REVIEW-skip.md" at 1f3a9c2:',
      tail: 'missing, and optional',
    })
    expect(documentLineParts(contextDocument({ origin: 'config', sha256: HASH }))).toEqual({
      head: 'context: security guidelines from a file, sha256 3f2a9c1d0b7e,',
      tail: '1830 bytes',
    })
    for (const record of [
      contextDocument(),
      repositoryDocument({ removed: cleaned }),
      missing,
    ]) {
      const { head, tail } = documentLineParts(record)
      expect(`${head} ${tail}`).toBe(documentLine(record))
    }
  })
})

describe('contextSummary', () => {
  it('writes one summary line per profile, the kinds it read, the missing and the cleaned', () => {
    const security = contextDocument({ bytes: 1830 })
    const naming = contextDocument({
      profile: 'naming',
      origin: 'config',
      sha256: HASH,
      bytes: 4100,
      removed: { characters: 3, comments: 1, entities: 0 },
    })
    const skipped = repositoryDocument({
      profile: 'naming',
      kind: 'do-not-report',
      path: 'REVIEW-skip.md',
      sha256: undefined,
      status: 'missing',
      bytes: 0,
    })
    expect(contextSummary({
      documents: [security, naming, skipped],
    })).toEqual([
      'context: security: guidelines 1830 bytes',
      'context: naming: guidelines 4100 bytes, 1 optional document(s) missing, hidden text removed from 1',
    ])
    // The bytes of a kind add up, the kinds come guidelines first, and each document the cleaner touched counts once.
    expect(contextSummary({
      documents: [
        contextDocument({
          bytes: 100,
          removed: { characters: 2, comments: 2, entities: 2 },
        }),
        repositoryDocument({
          bytes: 250,
          removed: { characters: 1, comments: 0, entities: 0 },
        }),
        contextDocument({ kind: 'do-not-report', bytes: 40 }),
        repositoryDocument({ kind: 'do-not-report', bytes: 60 }),
        repositoryDocument({
          kind: 'do-not-report',
          path: 'b.md',
          status: 'missing',
          bytes: 0,
          sha256: undefined,
        }),
        repositoryDocument({
          kind: 'do-not-report',
          path: 'c.md',
          status: 'missing',
          bytes: 0,
          sha256: undefined,
        }),
      ],
    })).toEqual(['context: security: guidelines 350 bytes, do-not-report text 100 bytes, 2 optional document(s) missing, hidden text removed from 2'])
    // A profile whose documents were all missing has its missing count alone, and the profiles come in the order their documents do.
    expect(contextSummary({
      documents: [
        skipped,
        security,
      ],
    })).toEqual([
      'context: naming: 1 optional document(s) missing',
      'context: security: guidelines 1830 bytes',
    ])
    // A document that held nothing once cleaned is still a document read.
    expect(contextSummary({
      documents: [
        contextDocument({ bytes: 0 }),
      ],
    })).toEqual(['context: security: guidelines 0 bytes'])
    expect(contextSummary({ documents: [] })).toEqual([])
  })
})
