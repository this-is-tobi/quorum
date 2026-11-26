import { describe, expect, it } from 'vitest'
import { performanceProfile } from './performance.ts'
import { REFUTATION_VOTE } from './vote.ts'

describe('performanceProfile', () => {
  it('holds the template, lenses, rules, do-not-report text and settings of the plan', () => {
    expect(performanceProfile).toEqual({
      id: 'performance',
      prompts: {
        research: 'Review this diff for the cost patterns that the review rules this request carries describe, and for no other. Report one only when the changed lines show both of its halves: the repetition or the blocking context (a loop, a request handler, an async function or a structure that grows) and the costly operation inside it. A finding\'s quote holds both halves, and its category is `perf`.',
        vote: REFUTATION_VOTE,
      },
      lenses: [
        { id: 'visible', question: 'Do the changed lines show both halves: the loop, handler or growing structure, and the costly operation inside it? Keep=false when either half is inferred rather than shown.' },
        { id: 'hot', question: 'Does this run often or on input that can grow: per request, per item or per message, on data a user or the outside world controls? Keep=false for code that runs once or on small fixed input.' },
        { id: 'unmitigated', question: 'Is the cost left in place: does no batching, cache, index, limit, pagination or early exit, in the diff or the other blocks, already bound it?' },
      ],
      rules: [
        { id: 'query-in-loop', text: 'A database query, an HTTP or RPC call, or another remote call made once per iteration of a loop over data, where one batched call could serve the loop.' },
        { id: 'nested-loops', text: 'A loop over a collection inside a loop over the same or a related collection, or a linear search inside a loop, so the work grows with the square of the input.' },
        { id: 'work-in-loop', text: 'Work that gives the same result on every iteration, such as compiling a pattern, parsing a document or building a large object, repeated inside a loop.' },
        { id: 'sync-io-in-async', text: 'A synchronous, blocking call (file or network I/O, a subprocess, a sleep) inside an async function, a request handler or an event-loop callback.' },
        { id: 'unbounded-list', text: 'An endpoint or a query that returns a list with no limit, page size or cap, so the caller or the data decides how much is read and sent.' },
        { id: 'unbounded-cache', text: 'A cache, map, list or buffer that entries are added to and never evicted, expired or capped, in code that lives as long as its process.' },
      ],
      requireRule: true,
      policy: { high: 'unanimous', medium: 'majority', low: 'off' },
      failOn: 'none',
      maxFindings: 20,
      changedLinesOnly: true,
      doNotReport: [
        '- micro-optimizations: a faster idiom for the same work, string building, the style of a loop',
        '- costs bounded by a small fixed input',
        '- code that runs once, such as startup, migrations, scripts and tests',
        '- a pattern whose two halves the diff does not both show',
      ].join('\n'),
    })
  })

  it('says what its quote and its category hold, and leaves the fields to quorum\'s request', () => {
    expect(performanceProfile.prompts.research).toMatch(/its category is `perf`/)
    expect(performanceProfile.prompts.research).not.toContain('`summary`')
    expect(performanceProfile.prompts.research).not.toContain('verbatim')
    expect(performanceProfile.prompts.research).not.toContain('{{')
  })
})
