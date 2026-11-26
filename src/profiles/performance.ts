import type { Profile } from '../core/types.ts'
import { REFUTATION_VOTE } from './vote.ts'

/**
 * A second opinion on a few known cost patterns, as an advisory review: six review rules describe them, and a finding stands only
 * when the changed lines show both halves of one, the repetition or blocking context and the costly operation inside it. It
 * requires a rule (`requireRule`), so a finding that cites none is dropped. It fails nothing (`failOn: none`), asks for 20
 * findings a request and keeps a finding only near a line the change adds or removes. It is data beside `securityProfile`,
 * deep-frozen as it is, and no labelled set measures it yet: it is design intent, not measured precision.
 */
export const performanceProfile: Profile = Object.freeze({
  id: 'performance',
  prompts: Object.freeze({
    research: 'Review this diff for the cost patterns that the review rules this request carries describe, and for no other. Report one only when the changed lines show both of its halves: the repetition or the blocking context (a loop, a request handler, an async function or a structure that grows) and the costly operation inside it. A finding\'s quote holds both halves, and its category is `perf`.',
    vote: REFUTATION_VOTE,
  }),
  lenses: Object.freeze([
    Object.freeze({
      id: 'visible',
      question: 'Do the changed lines show both halves: the loop, handler or growing structure, and the costly operation inside it? Keep=false when either half is inferred rather than shown.',
    }),
    Object.freeze({
      id: 'hot',
      question: 'Does this run often or on input that can grow: per request, per item or per message, on data a user or the outside world controls? Keep=false for code that runs once or on small fixed input.',
    }),
    Object.freeze({
      id: 'unmitigated',
      question: 'Is the cost left in place: does no batching, cache, index, limit, pagination or early exit, in the diff or the other blocks, already bound it?',
    }),
  ]),
  rules: Object.freeze([
    Object.freeze({
      id: 'query-in-loop',
      text: 'A database query, an HTTP or RPC call, or another remote call made once per iteration of a loop over data, where one batched call could serve the loop.',
    }),
    Object.freeze({
      id: 'nested-loops',
      text: 'A loop over a collection inside a loop over the same or a related collection, or a linear search inside a loop, so the work grows with the square of the input.',
    }),
    Object.freeze({
      id: 'work-in-loop',
      text: 'Work that gives the same result on every iteration, such as compiling a pattern, parsing a document or building a large object, repeated inside a loop.',
    }),
    Object.freeze({
      id: 'sync-io-in-async',
      text: 'A synchronous, blocking call (file or network I/O, a subprocess, a sleep) inside an async function, a request handler or an event-loop callback.',
    }),
    Object.freeze({
      id: 'unbounded-list',
      text: 'An endpoint or a query that returns a list with no limit, page size or cap, so the caller or the data decides how much is read and sent.',
    }),
    Object.freeze({
      id: 'unbounded-cache',
      text: 'A cache, map, list or buffer that entries are added to and never evicted, expired or capped, in code that lives as long as its process.',
    }),
  ]),
  requireRule: true,
  policy: Object.freeze({ high: 'unanimous', medium: 'majority', low: 'off' }),
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
