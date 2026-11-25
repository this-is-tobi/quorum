/**
 * The one schema of a result, which the bench's records and `readResult` share, and the schema of the public
 * view beside it, made of the same parts. A saved result is untrusted: another run, a person or an attacker may
 * have written it, so it is parsed with `JSON.parse` and a schema that is strict at every level, and anything
 * the schema does not describe is refused: an unknown key anywhere, a value outside a closed list, a number
 * that is no count. Each shape lists its keys in the order the core writes them, which a parse keeps, so a result
 * read back is written as it was.
 *
 * It is stricter than the types where a reporter writes a value as code, bare, and an attacker could
 * otherwise choose its bytes: every profile id, as a key of `meta.profiles` and as a verdict's or a gap's
 * `profile`, matches the core's pattern and names a profile of the result, and there is at least one; a
 * finding's `id` is 12 hexadecimal digits and its `fingerprint` is the core's, its `rule`, when it cites one, matches the
 * pattern of a rule id, and its summary, category and evidence keep the core's caps; and a kept finding has a `confidence` while a discarded or an unreviewed one has
 * none, which the panel guarantees (`verdictStatus`: a finding reaches a level exactly when it is kept). The
 * core writes all of it, so a result a review wrote passes.
 *
 * One thing is dropped, not refused: a `__proto__` key of the result's `profiles` or of a profile's `lenses`,
 * which zod's records skip, its value unread. A result is read, never merged into another object, so the key
 * changes nothing, and refusing it as the config loader does would walk every line again on each resume of a
 * bench run. A repeated key is not looked for: the tree that finds one costs ten times the parse on a line of
 * 16 MiB.
 */

import { z } from 'zod'
import { COMMIT_ID, MAX_DOCUMENT_PATH, SHA256 } from './documents.ts'
import { NO_ANSWERS } from './errors.ts'
import { SKIP_RULES, sourceIssues } from './inputs.ts'
import { FAIL_ON_LEVELS, PROFILE_ID_PATTERN } from './profile.ts'
import { RULE_ID } from './rules.ts'
import { SECRET_RULES } from './secrets.ts'
import { FINGERPRINT_PATTERN } from './stages/research.ts'
import { MAX_CATEGORY, MAX_EVIDENCE, MAX_MODEL, MAX_SUMMARY } from './verify.ts'

/** The most models a provider's record lists in `served`: the calls of any further model are counted in `servedOthers`. */
export const MAX_SERVED = 8

const count = z.int().min(0)
const amount = z.number().min(0)
const confidence = z.enum(['high', 'medium', 'low'])
const profileId = z.string().regex(PROFILE_ID_PATTERN)

const vote = z.strictObject({
  keep: z.boolean(),
  reasoning: z.string(),
})
const voteFailure = z.strictObject({
  kind: z.enum([
    'http',
    'network',
    'process',
    'timeout',
    'aborted',
    'refusal',
    'truncated',
    'no-answer',
    'invalid-response',
    'unsupported',
    'too-large',
    'token-cap',
    'review-deadline',
    'interrupted',
    'provider-down',
    'unusable-reply',
    'unknown',
  ]),
  status: z.int().min(100).max(599).optional(),
  noAnswer: z.enum(NO_ANSWERS).optional(),
})
const lensVote = z.strictObject({
  angle: z.string(),
  vote: vote.nullable(),
  error: z.string().nullable(),
  failure: voteFailure.nullable(),
})
/** A vote as the public view keeps it: no reasoning and no error. */
const publicVote = z.strictObject({
  angle: z.string(),
  keep: z.boolean().nullable(),
  failure: voteFailure.nullable(),
})
/** A verdict whose votes are `votes`: one shape for the full result and the public view. */
function verdictOf<Votes extends z.ZodType>(votes: Votes) {
  return z.strictObject({
    id: z.string().regex(/^[0-9a-f]{12}$/),
    fingerprint: z.string().regex(FINGERPRINT_PATTERN),
    profile: profileId,
    file: z.string(),
    line: count,
    citedLine: count.optional(),
    category: z.string().max(MAX_CATEGORY),
    rule: z.string().regex(RULE_ID).optional(),
    summary: z.string().max(MAX_SUMMARY),
    evidence: z.string().max(MAX_EVIDENCE),
    evidenceRow: z.int().min(0).max(2).optional(),
    quoteMatched: z.boolean(),
    keptVotes: count,
    totalVotes: count,
    confidence: confidence.optional(),
    votes: z.array(votes),
  })
}
const providerRef = z.strictObject({
  id: z.string(),
  model: z.string(),
})
const thresholds = z.strictObject({
  high: count.nullable(),
  medium: count.nullable(),
  low: count.nullable(),
})
/** The tokens a review, or a bench record, spent. */
export const usageSchema = z.strictObject({
  inputTokens: amount,
  outputTokens: amount,
  costUsd: amount.optional(),
})
/** What a provider's replies named as the model that answered (`ProviderCalls`): the served models, at most `MAX_SERVED` of them, each cut at `MAX_MODEL` characters, and the calls of the rest. */
const providerCalls = z.strictObject({
  model: z.string(),
  served: z.array(z.strictObject({
    model: z.string().max(MAX_MODEL),
    calls: z.int().min(1),
  })).max(MAX_SERVED),
  servedOthers: z.int().min(1).optional(),
})
/** How many research calls and votes a review reused from its store. */
const reused = z.strictObject({
  research: count,
  votes: count,
})
/** What each provider's lane did in a review, by provider id (`ConcurrencyRecord`). */
const concurrency = z.record(z.string(), z.strictObject({
  limit: z.union([
    z.literal('auto'),
    z.int().min(1),
  ]),
  start: z.int().min(1),
  lowest: z.int().min(1),
  highest: z.int().min(1),
  cuts: count,
  headers: z.boolean(),
}))
const coverageReason = z.enum([
  'binary',
  'submodule',
  'secret',
  'deleted-secret',
  'too-large',
  'request-too-large',
  'token-cap',
  'review-deadline',
  'interrupted',
  'research-failed',
  'provider-down',
  'reply-cut-off',
  'findings-capped',
])
const leftRange = z.strictObject({
  start: count,
  end: count,
  reason: coverageReason,
})
const coverageEntry = z.strictObject({
  file: z.string(),
  status: z.enum([
    'reviewed',
    'partial',
    'unreviewed',
    'excluded',
  ]),
  reason: coverageReason.optional(),
  left: z.array(leftRange).optional(),
})
const failOn = z.enum(FAIL_ON_LEVELS)
/** What recovery did for a profile's research, which its meta holds only when it split a part. */
const recovery = z.strictObject({
  parts: count,
  pieces: count,
  saturated: count,
  unreadHunks: count,
})
/** How many review rules a profile lists and how many its review sent. */
const ruleCounts = z.strictObject({
  listed: count,
  sent: count,
})
/** What a profile's research came to: the counts `ResearchRecord` holds, in the order the core writes them. */
const researchRecord = z.strictObject({
  parts: count,
  listed: count,
  panel: count,
  capped: count,
  saturated: count,
})
/** What a profile's meta records of a review. The keys of each shape are in the order the core writes them, so a result read back is written as it was. */
const profileMeta = z.strictObject({
  providers: z.strictObject({
    research: providerRef,
    lenses: z.record(z.string(), providerRef),
  }),
  policy: thresholds,
  failOn,
  gating: z.boolean(),
  invalidFindings: count,
  rules: ruleCounts,
  invalidRules: count,
  research: researchRecord,
  asksNothing: z.literal(true).optional(),
  coverage: z.array(coverageEntry),
  recovery: recovery.optional(),
})
/** A profile's meta in the public view: no providers, no research counts, and the count of its discarded findings. */
const publicProfileMeta = z.strictObject({
  policy: thresholds,
  failOn,
  gating: z.boolean(),
  discarded: count,
  invalidFindings: count,
  rules: ruleCounts,
  invalidRules: count,
  asksNothing: z.literal(true).optional(),
  coverage: z.array(coverageEntry),
  recovery: recovery.optional(),
})
/** Why part of a review is missing: the closed list of `IncompleteReason`. */
export const gapReason = z.enum([
  'research-unusable',
  'research-failed',
  'provider-down',
  'findings-capped',
  'finding-unreadable',
  'vote-failed',
  'request-too-large',
  'too-large',
  'token-cap',
  'review-deadline',
  'interrupted',
  'reply-cut-off',
  'binary',
  'submodule',
  'secret',
])
const incompleteEntry = z.strictObject({
  profile: profileId,
  reason: gapReason,
  file: z.string().optional(),
  detail: z.string(),
})
/** A gap in the public view: no detail. */
const publicGap = z.strictObject({
  profile: profileId,
  reason: gapReason,
  file: z.string().optional(),
})
/** A file left out: a rule belongs to a skipped or a held file, and to none else. */
export const leftOutFile = z.discriminatedUnion('reason', [
  z.strictObject({
    file: z.string(),
    reason: z.enum(['excluded', 'binary', 'submodule']),
  }),
  z.strictObject({
    file: z.string(),
    reason: z.literal('skipped'),
    rule: z.enum(SKIP_RULES),
  }),
  z.strictObject({
    file: z.string(),
    reason: z.enum(['secret', 'deleted-secret']),
    rule: z.enum(SECRET_RULES),
  }),
])
const objectFormat = z.enum(['sha1', 'sha256'])
/**
 * Where a review's diff came from. The shapes are strict, one object per kind; the ids are checked as a
 * review checks its input's, by `sourceIssues`, so a record holds a full commit id of its object format.
 */
const reviewSource = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('diff'),
  }),
  z.strictObject({
    kind: z.literal('range'),
    base: z.string(),
    mergeBase: z.string(),
    head: z.string(),
    objectFormat,
  }),
  z.strictObject({
    kind: z.enum(['local', 'staged']),
    head: z.string().nullable(),
    objectFormat,
  }),
  z.strictObject({
    kind: z.literal('paths'),
    commit: z.string(),
    paths: z.array(z.string()),
    skips: z.boolean(),
    objectFormat,
  }),
]).refine(source => sourceIssues(source).length === 0)
/** What an advisory flag points at: the closed list of `FlagCode`. */
export const flagCode = z.enum([
  'hidden-characters',
  'ai-addressed-text',
  'secret-file',
  'guideline-edited',
])
const flag = z.strictObject({
  code: flagCode,
  profile: profileId.optional(),
  file: z.string().optional(),
  line: count.optional(),
  detail: z.string(),
})

/**
 * What a review recorded of one document it read as policy (`ContextDocument`): the closed lists of its kind, its origin and
 * its status, its hash and its commit as the digits quorum writes them, a path, and what the cleaner removed. A repository document
 * has a path and a commit and no other has, a missing one has no bytes and no hash, and a rules document holds its count of rules
 * (none when it is missing) and no other kind does, so no record of another shape is one a reporter writes. It never holds a text.
 */
const contextDocument = z.strictObject({
  profile: profileId,
  kind: z.enum(['guidelines', 'do-not-report', 'rules']),
  origin: z.enum(['profile', 'config', 'repository']),
  path: z.string().min(1).max(MAX_DOCUMENT_PATH).optional(),
  commit: z.string().regex(COMMIT_ID).optional(),
  sha256: z.string().regex(SHA256).optional(),
  status: z.enum(['read', 'missing']),
  bytes: count,
  rules: count.optional(),
  removed: z.strictObject({
    characters: count,
    comments: count,
    entities: count,
  }),
}).refine(document => (document.origin === 'repository') === (document.path !== undefined && document.commit !== undefined)
  && (document.origin === 'repository' || (document.path === undefined && document.commit === undefined))
  && (document.status === 'read' || (document.bytes === 0 && document.sha256 === undefined && (document.rules ?? 0) === 0))
  && (document.kind === 'rules') === (document.rules !== undefined))

/** What a review read as policy: every document it sent, in the order it sent them. */
const contextRecord = z.strictObject({
  documents: z.array(contextDocument),
})

/**
 * What a review moved by itself: a provider's id, the setting, what it moved from and to, and the cause, each setting
 * and cause one of the closed lists of `Adaptation`, the ones a later release moves included.
 */
const adaptation = z.strictObject({
  provider: z.string(),
  setting: z.enum([
    'thinking',
    'structuredOutput',
    'stream',
    'replyTokens',
    'tokenCount',
    'window',
  ]),
  from: z.string(),
  to: z.string(),
  cause: z.enum([
    'cut-off-thinking',
    'no-answer-thinking',
    'empty-reply',
    'format-refused',
    'stream-refused',
    'stream-answered-whole',
    'cut-on-the-way',
    'byte-bound-refused',
    'loaded-window',
    'lowering-refused',
  ]),
})

/** The profiles of a result, keyed by id: at least one, since a review runs at least one. */
function profilesOf<Meta extends z.ZodType>(meta: Meta) {
  return z.record(profileId, meta).refine(profiles => Object.keys(profiles).length > 0)
}

/** What the cross-checks read of a result or of a public view. */
interface Checked {
  readonly kept: ReadonlyArray<{ readonly profile: string, readonly confidence?: unknown }>
  readonly discarded: ReadonlyArray<{ readonly profile: string, readonly confidence?: unknown }>
  readonly unreviewed: ReadonlyArray<{ readonly profile: string, readonly confidence?: unknown }>
  readonly meta: {
    readonly profiles: Readonly<Record<string, unknown>>
    readonly incomplete: ReadonlyArray<{ readonly profile: string }>
  }
}

/**
 * What no single field says: every verdict and every gap names a profile of `meta.profiles`, a kept verdict has
 * a confidence, and a discarded or an unreviewed one has none. The messages are fixed words, never the input.
 */
function checkResult(result: Checked, context: z.RefinementCtx): void {
  const lists = [
    ['kept', result.kept],
    ['discarded', result.discarded],
    ['unreviewed', result.unreviewed],
  ] as const
  for (const [list, verdicts] of lists) {
    verdicts.forEach((verdict, index) => {
      if (!Object.hasOwn(result.meta.profiles, verdict.profile)) {
        context.addIssue({
          code: 'custom',
          path: [list, index, 'profile'],
          message: 'must be a profile of the result',
        })
      }
      if ((verdict.confidence !== undefined) !== (list === 'kept')) {
        context.addIssue({
          code: 'custom',
          path: [list, index, 'confidence'],
          message: 'is held by a kept finding alone',
        })
      }
    })
  }
  result.meta.incomplete.forEach((gap, index) => {
    if (!Object.hasOwn(result.meta.profiles, gap.profile)) {
      context.addIssue({
        code: 'custom',
        path: ['meta', 'incomplete', index, 'profile'],
        message: 'must be a profile of the result',
      })
    }
  })
}

/**
 * The schema of a result, strict at every level. `result-schema.spec.ts` holds its output type equal to
 * `QuorumResult`, `readonly` aside, so a field the core adds, drops or retypes, optional or not, fails the
 * typecheck.
 */
export const resultSchema = z.strictObject({
  kept: z.array(verdictOf(lensVote)),
  discarded: z.array(verdictOf(lensVote)),
  unreviewed: z.array(verdictOf(lensVote)),
  meta: z.strictObject({
    version: z.string(),
    startedAt: z.string(),
    durationMs: count,
    source: reviewSource,
    profiles: profilesOf(profileMeta),
    usage: usageSchema.optional(),
    calls: z.record(z.string(), providerCalls),
    incomplete: z.array(incompleteEntry),
    leftOut: z.array(leftOutFile),
    flags: z.array(flag),
    context: contextRecord,
    adaptations: z.array(adaptation),
    reused: reused.optional(),
    concurrency: concurrency.optional(),
  }),
}).superRefine(checkResult)

/**
 * The schema of the public view (`publicView`): the same parts, less what the view withholds. `meta.view` is
 * the literal `public`, `discarded` is an empty tuple, and a vote, a profile's meta and a gap hold no field
 * the view drops, so a result forged to look like a view, with a vote's reasoning, a usage, the calls, the providers or a
 * gap's detail, is refused. `result-schema.spec.ts` holds its output type equal to `PublicView`.
 */
export const publicViewSchema = z.strictObject({
  kept: z.array(verdictOf(publicVote)),
  discarded: z.tuple([]),
  unreviewed: z.array(verdictOf(publicVote)),
  meta: z.strictObject({
    version: z.string(),
    view: z.literal('public'),
    startedAt: z.string(),
    durationMs: count,
    source: reviewSource,
    profiles: profilesOf(publicProfileMeta),
    incomplete: z.array(publicGap),
    leftOut: z.array(leftOutFile),
    flags: z.array(flag),
    context: contextRecord,
    adaptations: z.array(adaptation),
    reused: reused.optional(),
    concurrency: concurrency.optional(),
  }),
}).superRefine(checkResult)
