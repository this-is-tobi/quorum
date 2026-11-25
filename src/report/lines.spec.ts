import { describe, expect, it } from 'vitest'
import type { ContextDocument, LensVote, QuorumMeta, Verdict, VoteFailure } from '../core/types.ts'
import { cast, contextDocument, reportResult, SQL } from '../testing/report.ts'
import { contextSummary, documentLine, documentLineParts, durationText, modelLines, ruleCountWords, ruleWords, tokenWords, voteFailureWords, votesWords } from './lines.ts'
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

describe('ruleWords', () => {
  it('words a finding\'s rule, and none for a finding that cites none', () => {
    expect(ruleWords({ rule: 'tests-for-new-code' })).toBe('rule tests-for-new-code')
    expect(ruleWords({ ...SQL, rule: 'no-any' })).toBe('rule no-any')
    expect(ruleWords(SQL)).toBe('')
    expect(ruleWords({})).toBe('')
    expect(ruleWords({ rule: '' })).toBe('')
    // A report that writes the id another way, in a code span, passes its writer.
    expect(ruleWords({ rule: 'no-any' }, id => `\`${id}\``)).toBe('rule `no-any`')
    expect(ruleWords({}, id => `\`${id}\``)).toBe('')
  })
})

describe('ruleCountWords', () => {
  it('words the rules a review sent of those a profile lists, and that its research asks nothing when it did', () => {
    expect(ruleCountWords({ listed: 5, sent: 3 })).toBe('3 of 5 sent')
    expect(ruleCountWords({ listed: 5, sent: 3 }, false)).toBe('3 of 5 sent')
    expect(ruleCountWords({ listed: 5, sent: 0 }, true)).toBe('0 of 5 sent, so its research asks nothing')
    expect(ruleCountWords({ listed: 0, sent: 0 }, true)).toBe('0 of 0 sent, so its research asks nothing')
  })
})

describe('modelLines', () => {
  const served = (...models: Array<[string, number]>): Array<{ model: string, calls: number }> => models.map(([model, calls]) => ({ model, calls }))

  it.each<[string, string[], QuorumMeta['calls']]>([
    ['no call', [], {}],
    [
      'a provider that answered as the configured model',
      [],
      {
        local: {
          model: 'local-model',
          served: served(['local-model', 6]),
        },
      },
    ],
    [
      'a provider whose replies named none',
      [],
      {
        local: { model: 'local-model', served: [] },
      },
    ],
    [
      'a provider that answered as another model',
      ['models: local answered as local-model-2026, its config names local-model'],
      {
        local: {
          model: 'local-model',
          served: served(['local-model-2026', 6]),
        },
      },
    ],
    [
      'two providers, one that answered as another model and one as its own',
      ['models: research answered as gateway-alias-3, its config names gateway-alias'],
      {
        local: {
          model: 'local-model',
          served: served(['local-model', 4]),
        },
        research: {
          model: 'gateway-alias',
          served: served(['gateway-alias-3', 2]),
        },
      },
    ],
    [
      'two providers that each answered as another model',
      ['models: local answered as local-model-2026, its config names local-model; research answered as gateway-alias-3, its config names gateway-alias'],
      {
        local: {
          model: 'local-model',
          served: served(['local-model-2026', 6]),
        },
        research: {
          model: 'gateway-alias',
          served: served(['gateway-alias-3', 2]),
        },
      },
    ],
    [
      'a provider that answered as two models',
      ['warning: local answered as 2 models in this review: local-model-a in 3 call(s), local-model-b in 3'],
      {
        local: {
          model: 'local-model',
          served: served(['local-model-a', 3], ['local-model-b', 3]),
        },
      },
    ],
    [
      'a provider that answered as two models, one its own',
      ['warning: local answered as 2 models in this review: local-model in 4 call(s), local-model-b in 2'],
      {
        local: {
          model: 'local-model',
          served: served(['local-model', 4], ['local-model-b', 2]),
        },
      },
    ],
    [
      'a provider that answered as three models',
      ['warning: local answered as 3 models in this review: local-model-a in 3 call(s), local-model-b in 2, local-model-c in 1'],
      {
        local: {
          model: 'local-model',
          served: served(['local-model-a', 3], ['local-model-b', 2], ['local-model-c', 1]),
        },
      },
    ],
    [
      'a provider that answered as two models and calls by others',
      ['warning: local answered as 2 models in this review: local-model-a in 3 call(s), local-model-b in 3, and 2 call(s) by other models'],
      {
        local: {
          model: 'local-model',
          served: served(['local-model-a', 3], ['local-model-b', 3]),
          servedOthers: 2,
        },
      },
    ],
    [
      'a provider that answered as another model, and one as two',
      [
        'models: local answered as local-model-2026, its config names local-model',
        'warning: research answered as 2 models in this review: gateway-alias-3 in 2 call(s), gateway-alias-4 in 1',
      ],
      {
        local: {
          model: 'local-model',
          served: served(['local-model-2026', 6]),
        },
        research: {
          model: 'gateway-alias',
          served: served(['gateway-alias-3', 2], ['gateway-alias-4', 1]),
        },
      },
    ],
    [
      'two providers that answered as two models',
      [
        'warning: local answered as 2 models in this review: local-model-a in 3 call(s), local-model-b in 3',
        'warning: research answered as 2 models in this review: gateway-alias-3 in 2 call(s), gateway-alias-4 in 1',
      ],
      {
        local: {
          model: 'local-model',
          served: served(['local-model-a', 3], ['local-model-b', 3]),
        },
        research: {
          model: 'gateway-alias',
          served: served(['gateway-alias-3', 2], ['gateway-alias-4', 1]),
        },
      },
    ],
  ])('writes the models of %s as %j', (_label, expected, calls) => {
    expect(modelLines(calls)).toEqual(expected)
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
    [
      'a rules document of the profile',
      'context: naming rules of the profile, 2 rule(s)',
      contextDocument({
        profile: 'naming',
        kind: 'rules',
        bytes: 120,
        rules: 2,
      }),
    ],
    [
      'a rule written in the config, with no hash',
      'context: naming rules written in the config, 1 rule(s)',
      contextDocument({
        profile: 'naming',
        kind: 'rules',
        origin: 'config',
        bytes: 60,
        rules: 1,
      }),
    ],
    [
      'a rules file, with the first 12 digits of its hash',
      'context: naming rules from a file, sha256 3f2a9c1d0b7e, 3 rule(s)',
      contextDocument({
        profile: 'naming',
        kind: 'rules',
        origin: 'config',
        sha256: HASH,
        bytes: 400,
        rules: 3,
      }),
    ],
    [
      'a rules file of the repository, with its path and the commit\'s first 7 characters',
      'context: naming rules ".quorum/rules.yaml" at 1f3a9c2, 4 rule(s)',
      repositoryDocument({
        profile: 'naming',
        kind: 'rules',
        path: '.quorum/rules.yaml',
        bytes: 500,
        rules: 4,
      }),
    ],
    [
      'a rules file that holds no rule',
      'context: naming rules from a file, sha256 3f2a9c1d0b7e, 0 rule(s)',
      contextDocument({
        profile: 'naming',
        kind: 'rules',
        origin: 'config',
        sha256: HASH,
        bytes: 0,
        rules: 0,
      }),
    ],
    [
      'a rules file of the repository, optional and not found',
      'context: naming rules ".quorum/rules.yaml" at 1f3a9c2: missing, and optional',
      repositoryDocument({
        profile: 'naming',
        kind: 'rules',
        path: '.quorum/rules.yaml',
        sha256: undefined,
        status: 'missing',
        bytes: 0,
        rules: 0,
      }),
    ],
    [
      'a rules file the cleaner removed a comment from',
      'context: naming rules from a file, sha256 3f2a9c1d0b7e, 3 rule(s); the cleaner removed 1 comment(s)',
      contextDocument({
        profile: 'naming',
        kind: 'rules',
        origin: 'config',
        sha256: HASH,
        bytes: 400,
        rules: 3,
        removed: { characters: 0, comments: 1, entities: 0 },
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
    expect(documentLineParts(contextDocument({
      profile: 'naming',
      kind: 'rules',
      origin: 'config',
      sha256: HASH,
      rules: 3,
    }))).toEqual({
      head: 'context: naming rules from a file, sha256 3f2a9c1d0b7e,',
      tail: '3 rule(s)',
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

  /** A rules document of `profile`: its entries as the rules block holds them. */
  function rulesDocument(profile: string, changes: Partial<ContextDocument> = {}): ContextDocument {
    return contextDocument({
      profile,
      kind: 'rules',
      origin: 'config',
      bytes: 120,
      rules: 2,
      ...changes,
    })
  }

  it('names the rules a profile sent of those it lists, after the kinds of text it read and before the missing and the cleaned', () => {
    const naming = contextDocument({ profile: 'naming', bytes: 4100 })
    expect(contextSummary({
      documents: [
        naming,
        rulesDocument('naming'),
        rulesDocument('naming', { rules: 3 }),
      ],
    }, {
      naming: {
        rules: { listed: 5, sent: 3 },
      },
    })).toEqual(['context: naming: guidelines 4100 bytes, rules 3 of 5 sent'])
    // The kinds come guidelines, do-not-report text, then rules, whatever order the documents are in.
    expect(contextSummary({
      documents: [
        rulesDocument('naming'),
        contextDocument({ profile: 'naming', kind: 'do-not-report', bytes: 40 }),
        naming,
        repositoryDocument({
          profile: 'naming',
          kind: 'rules',
          path: '.quorum/rules.yaml',
          status: 'missing',
          sha256: undefined,
          bytes: 0,
          rules: 0,
        }),
        contextDocument({
          profile: 'naming',
          bytes: 9,
          removed: { characters: 1, comments: 0, entities: 0 },
        }),
      ],
    }, {
      naming: {
        rules: { listed: 2, sent: 2 },
      },
    })).toEqual(['context: naming: guidelines 4109 bytes, do-not-report text 40 bytes, rules 2 of 2 sent, 1 optional document(s) missing, hidden text removed from 1'])
    // Each profile has its own counts, and a profile that sent none of its rules says so.
    expect(contextSummary({
      documents: [
        naming,
        rulesDocument('naming'),
        contextDocument(),
        rulesDocument('security'),
      ],
    }, {
      naming: {
        rules: { listed: 2, sent: 0 },
      },
      security: {
        rules: { listed: 1, sent: 1 },
      },
    })).toEqual([
      'context: naming: guidelines 4100 bytes, rules 0 of 2 sent',
      'context: security: guidelines 1830 bytes, rules 1 of 1 sent',
    ])
  })

  it('joins the rules of a profile with no text read as it joins any first part, with no leading comma', () => {
    expect(contextSummary({
      documents: [
        rulesDocument('naming'),
      ],
    }, {
      naming: {
        rules: { listed: 5, sent: 3 },
      },
    })).toEqual(['context: naming: rules 3 of 5 sent'])
    expect(contextSummary({
      documents: [
        rulesDocument('naming', {
          removed: { characters: 0, comments: 2, entities: 0 },
        }),
        repositoryDocument({
          profile: 'naming',
          kind: 'do-not-report',
          path: 'REVIEW-skip.md',
          status: 'missing',
          sha256: undefined,
          bytes: 0,
        }),
      ],
    }, {
      naming: {
        rules: { listed: 5, sent: 3 },
      },
    })).toEqual(['context: naming: rules 3 of 5 sent, 1 optional document(s) missing, hidden text removed from 1'])
  })

  it('says that a profile\'s research asks nothing in its rules part, whether it lists rules or none, with a line of its own when it has no document', () => {
    const naming = contextDocument({ profile: 'naming', bytes: 4100 })
    const asks = (listed: number, sent = 0): { rules: { listed: number, sent: number }, asksNothing: true } => ({
      rules: { listed, sent },
      asksNothing: true,
    })
    // It lists rules and none applies, beside the text it read.
    expect(contextSummary({
      documents: [
        naming,
        rulesDocument('naming'),
      ],
    }, {
      naming: asks(5),
    })).toEqual(['context: naming: guidelines 4100 bytes, rules 0 of 5 sent, so its research asks nothing'])
    // The clause ends the rules part, which the missing and the cleaned follow.
    expect(contextSummary({
      documents: [
        rulesDocument('naming', {
          removed: { characters: 0, comments: 1, entities: 0 },
        }),
        repositoryDocument({
          profile: 'naming',
          kind: 'do-not-report',
          path: 'REVIEW-skip.md',
          status: 'missing',
          sha256: undefined,
          bytes: 0,
        }),
      ],
    }, {
      naming: asks(2),
    })).toEqual(['context: naming: rules 0 of 2 sent, so its research asks nothing, 1 optional document(s) missing, hidden text removed from 1'])
    // It requires a rule and lists none, with no document at all: a line of its own, after the lines of the profiles that have a document.
    expect(contextSummary({ documents: [] }, {
      naming: asks(0),
    })).toEqual(['context: naming: rules 0 of 0 sent, so its research asks nothing'])
    expect(contextSummary({
      documents: [
        contextDocument(),
      ],
    }, {
      strict: asks(0),
      security: {
        rules: { listed: 0, sent: 0 },
      },
      naming: asks(0),
    })).toEqual([
      'context: security: guidelines 1830 bytes',
      'context: strict: rules 0 of 0 sent, so its research asks nothing',
      'context: naming: rules 0 of 0 sent, so its research asks nothing',
    ])
    // A profile that lists no rule and requires none, and one with no entry, has no line of its own, and a name the object inherits reads as none.
    expect(contextSummary({ documents: [] }, {
      naming: {
        rules: { listed: 0, sent: 0 },
      },
    })).toEqual([])
    expect(contextSummary({ documents: [] }, {})).toEqual([])
    expect(contextSummary({
      documents: [
        contextDocument({ profile: 'constructor' }),
      ],
    }, {})).toEqual(['context: constructor: guidelines 1830 bytes'])
  })

  it('writes no rules words for a profile that lists no rule, whatever it holds, and no line for a profile with nothing to say', () => {
    const naming = contextDocument({ profile: 'naming', bytes: 4100 })
    const empty = rulesDocument('naming', { bytes: 0, rules: 0 })
    // The profile's counts say it lists none: a rules file that held none, beside text.
    expect(contextSummary({
      documents: [naming, empty],
    }, {
      naming: {
        rules: { listed: 0, sent: 0 },
      },
    })).toEqual(['context: naming: guidelines 4100 bytes'])
    // No counts at all, as a caller that has none passes, say nothing of rules.
    expect(contextSummary({
      documents: [
        naming,
        rulesDocument('naming'),
      ],
    })).toEqual(['context: naming: guidelines 4100 bytes'])
    // A profile whose only record is a rules file with no rule has nothing to summarize.
    expect(contextSummary({
      documents: [
        empty,
        contextDocument(),
      ],
    }, {
      naming: {
        rules: { listed: 0, sent: 0 },
      },
    })).toEqual(['context: security: guidelines 1830 bytes'])
    // A name that is no profile of the counts, and one the object inherits, read as no counts.
    expect(contextSummary({
      documents: [
        contextDocument({ profile: 'constructor' }),
        rulesDocument('constructor'),
      ],
    }, {})).toEqual(['context: constructor: guidelines 1830 bytes'])
  })
})
