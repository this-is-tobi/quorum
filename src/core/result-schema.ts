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
import { LEVEL_ORDER, REPORT_PROBLEMS } from './candidates.ts'
import { COMMIT_ID, MAX_DOCUMENT_PATH, SHA256 } from './documents.ts'
import { NO_ANSWERS, PROVIDER_ERROR_KINDS } from './errors.ts'
import { SKIP_RULES, sourceIssues } from './inputs.ts'
import { FAIL_ON_LEVELS, PROFILE_ID_PATTERN } from './profile.ts'
import { RULE_ID } from './rules.ts'
import { SECRET_RULES } from './secrets.ts'
import { FINGERPRINT_PATTERN } from './stages/research.ts'
import { MAX_CATEGORY, MAX_EVIDENCE, MAX_MODEL, MAX_RULE_ID, MAX_SCANNER, MAX_SUMMARY } from './verify.ts'

/** The most models a provider's record lists in `served`: the calls of any further model are counted in `servedOthers`. */
export const MAX_SERVED = 8

/** What a record writes for an `extraBody` value that the rule of `config/settings.ts` cannot show safe. */
export const REDACTED = '[redacted]'
/** The most code points a string of an `extraBody` value has to be written: a longer one is `REDACTED`. */
export const EXTRA_BODY_STRING = 64
/** The most levels of objects and arrays an `extraBody` entry nests to be written (`{ a: { b: { c: { d: 1 } } } }` is four): a fifth makes the entry `REDACTED` whole. */
export const EXTRA_BODY_DEPTH = 4
/** The most values, each object and array counted as one, an `extraBody` entry holds to be written: past it the entry is `REDACTED` whole. */
export const EXTRA_BODY_VALUES = 64

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
/** What proposed a finding: the model's finder, or a scanner's report, whose texts are within the caps the harness keeps. */
const foundBy = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('model'),
  }),
  z.strictObject({
    kind: z.literal('scanner'),
    report: count,
    scanner: z.string().max(MAX_SCANNER),
    ruleId: z.string().max(MAX_RULE_ID),
    level: z.enum(LEVEL_ORDER),
    fileLevel: z.literal(true).optional(),
    suppressed: z.literal(true).optional(),
  }),
])
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
    foundBy,
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
/** What a provider did in one role of a review (`RoleCalls`): its calls, the failed ones by kind (a provider failure's, or `unusable-reply`), and the stopped, retried and reused ones, its usage and its time. */
const roleCalls = z.strictObject({
  calls: count,
  failed: z.partialRecord(z.enum([...PROVIDER_ERROR_KINDS, 'unusable-reply']), count),
  stopped: count,
  retried: count,
  reused: count,
  usage: usageSchema,
  callMs: z.strictObject({
    total: count,
    longest: count,
  }),
})
/** What a provider's calls came to (`ProviderCalls`): the models its replies named, at most `MAX_SERVED` of them, each cut at `MAX_MODEL` characters, and the calls of the rest, then what it did in each role. */
const providerCalls = z.strictObject({
  model: z.string(),
  served: z.array(z.strictObject({
    model: z.string().max(MAX_MODEL),
    calls: z.int().min(1),
  })).max(MAX_SERVED),
  servedOthers: z.int().min(1).optional(),
  research: roleCalls.optional(),
  vote: roleCalls.optional(),
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
/** How long each stage of a profile took, in whole milliseconds, for the stages that ended. */
const stages = z.partialRecord(z.enum(['research', 'dedup', 'panel']), count)
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
  awayFromChange: count.optional(),
  research: researchRecord,
  stages,
  asksNothing: z.literal(true).optional(),
  coverage: z.array(coverageEntry),
  recovery: recovery.optional(),
})
/** A profile's meta in the public view: no providers, no research counts, and the count of its discarded findings; its stage times are kept. */
const publicProfileMeta = z.strictObject({
  policy: thresholds,
  failOn,
  gating: z.boolean(),
  discarded: count,
  invalidFindings: count,
  rules: ruleCounts,
  invalidRules: count,
  awayFromChange: count.optional(),
  stages,
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
  'report-unreadable',
  'report-partial',
  'issues-capped',
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

/** The commit a report states, as its record holds it: a lowercase hexadecimal prefix of 7 to 64 digits. */
const REPORT_COMMIT = /^[0-9a-f]{7,64}$/

/** Each outcome of a scanner report's issues, and the counts beside them, which a report's record holds: nine outcomes, `listed` and `fileLevel`, and `notRead` when above 0, in the order the core writes them. */
const reportIssues = z.strictObject({
  listed: count,
  used: count,
  fileLevel: count,
  held: count,
  unmapped: count,
  notInChange: count,
  leftOut: count,
  unchanged: count,
  capped: count,
  skipped: count,
  unreadable: count,
  notRead: count.optional(),
})

/**
 * What a review recorded of one scanner report (`ContextReport`): its format, the profile it is read for, a scanner's name within the
 * cap the core keeps, the commit it states as a prefix of 7 to 64 lower-case digits, the hash of its bytes, its status and problems from
 * the closed lists, and the counts of its issues' outcomes. It never holds a path, a file name or a text of the report.
 */
const contextReport = z.strictObject({
  format: z.enum(['sarif', 'sonarqube']),
  profile: profileId.optional(),
  scanner: z.string().max(MAX_SCANNER).optional(),
  commit: z.string().regex(REPORT_COMMIT).optional(),
  sha256: z.string().regex(SHA256).optional(),
  status: z.enum(['read', 'partial', 'unreadable']),
  problems: z.array(z.enum(REPORT_PROBLEMS)),
  issues: reportIssues.optional(),
})

/** What a review read as policy and as scanner reports: every document it sent, in the order it sent them, and every report it read, in the order it was given. */
const contextRecord = z.strictObject({
  documents: z.array(contextDocument),
  reports: z.array(contextReport),
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

/** The most characters of a string, and the most entries of a record or a list, a settings record holds. */
const SETTINGS_STRING = 4096
const SETTINGS_ENTRIES = 256

const text = z.string().max(SETTINGS_STRING)
/** A record of at most `SETTINGS_ENTRIES` entries, its keys no more than `SETTINGS_STRING` characters. */
function table<Value extends z.ZodType>(value: Value) {
  return z.record(text, value).refine(record => Object.keys(record).length <= SETTINGS_ENTRIES)
}
/** A list of at most `SETTINGS_ENTRIES` entries. */
function list<Item extends z.ZodType>(item: Item) {
  return z.array(item).max(SETTINGS_ENTRIES)
}

/** A bound of a review with where it came from: a whole number of 1 or more, and one of the three origins `SettingOrigin` lists. */
const settingValue = z.strictObject({
  value: z.int().min(1),
  origin: z.enum(['config', 'default', 'derived']),
})
/** A prompt or a lens's question as a record holds it: its SHA-256, never its text. */
const textHash = z.string().regex(/^sha256:[0-9a-f]{64}$/)

/** A string of an `extraBody` value, or a key of one, as the rule writes it: at most `EXTRA_BODY_STRING` code points, a surrogate pair one. A string over twice that in UTF-16 units is refused before its code points are counted. */
const extraString = z.string().refine(value => value.length <= 2 * EXTRA_BODY_STRING && Array.from(value).length <= EXTRA_BODY_STRING)
const extraScalar = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  extraString,
])

/** A record of at most `SETTINGS_ENTRIES` entries whose keys are strings of the rule's size: an object of an `extraBody`, or the `extraBody` itself. */
function bodyTable<Value extends z.ZodType>(value: Value) {
  return z.record(extraString, value).refine(record => Object.keys(record).length <= SETTINGS_ENTRIES)
}

/** An `extraBody` value that nests at most `levels` more levels of objects and arrays, each a list or record of at most `SETTINGS_ENTRIES` entries: the rule's own bound on the entries of one value is counted by `extraBodyValues`. */
function extraLevel(levels: number): z.ZodType<unknown> {
  if (levels === 0) return extraScalar
  const inner = extraLevel(levels - 1)
  return z.union([
    extraScalar,
    list(inner),
    bodyTable(inner),
  ])
}

/** How many values an `extraBody` entry holds, each object and array one and each member another, which the rule bounds by `EXTRA_BODY_VALUES`. The entry has passed `extraLevel`, so it is at most `EXTRA_BODY_DEPTH` levels deep and its lists and records hold at most 256 entries each. */
function extraBodyValues(entry: unknown): number {
  if (typeof entry !== 'object' || entry === null) return 1
  const members: readonly unknown[] = Array.isArray(entry)
    ? entry
    : Object.values(entry)
  return members.reduce<number>((total, member) => total + extraBodyValues(member), 1)
}

/** The `extraBody` of a provider as a record holds it: each entry the rule's shape (a scalar, or objects and arrays nested at most `EXTRA_BODY_DEPTH` deep) and at most `EXTRA_BODY_VALUES` values with the containers counted, as the rule counts them. The redacted word is a key and a value like any other. */
const extraBody = bodyTable(extraLevel(EXTRA_BODY_DEPTH).refine(entry => extraBodyValues(entry) <= EXTRA_BODY_VALUES))

/**
 * The fields of a provider's record and the shape of each, which `providerView` writes for the result's sink: the provider as
 * `--print-config` prints it, less its `origin`, `command`, `args` and `apiKey`. A field outside this list is refused, so a record
 * a program builds can hold no base URL and no key, and a header's or query's value is the redacted word alone.
 */
const PROVIDER_FIELDS: Readonly<Record<string, z.ZodType>> = {
  implements: z.literal('Provider'),
  preset: text,
  protocol: text,
  model: text,
  contextTokens: z.number(),
  auth: z.union([
    text,
    z.strictObject({
      header: text,
      prefix: text.optional(),
    }),
  ]),
  headers: table(z.literal(REDACTED)),
  query: table(z.literal(REDACTED)),
  extraBody,
  structuredOutput: text,
  temperature: z.number().nullable(),
  maxTokens: z.number(),
  maxTokensField: text,
  thinking: text,
  systemPrompt: text,
  stream: z.boolean(),
  timeoutMs: z.number(),
  stallTimeoutMs: z.number(),
  retries: z.number(),
}

/**
 * One provider's record: the fields of `PROVIDER_FIELDS` each in its shape. A field's issue is placed at the field, never at a key
 * or a value of it, and an unknown field's at the provider, so a refusal's path never repeats a key a person wrote.
 */
const providerSettings = table(z.unknown()).superRefine((fields, context) => {
  for (const [name, value] of Object.entries(fields)) {
    const shape = Object.hasOwn(PROVIDER_FIELDS, name)
      ? PROVIDER_FIELDS[name]
      : undefined
    if (shape === undefined) {
      context.addIssue({ code: 'custom', path: [], message: 'is no field a provider\'s record holds' })
    } else if (!shape.safeParse(value).success) {
      context.addIssue({
        code: 'custom',
        path: [name],
        message: 'is not the shape a provider\'s record writes it in',
      })
    }
  }
})

/** What one profile ran with (`ProfileSettings`): its providers by config key, each prompt and lens question as a hash, and the reply budgets. */
const profileSettings = z.strictObject({
  research: text,
  lenses: table(z.strictObject({
    provider: text,
    question: textHash,
  })),
  prompts: z.strictObject({
    research: textHash,
    vote: textHash,
  }),
  findings: count,
  replyTokens: z.strictObject({
    research: count.optional(),
    votes: table(count.nullable()),
  }),
})

/**
 * The schema of the settings record of a review (`ReviewSettings`), which a caller gives with its review (`ReviewInput.settings`)
 * and `meta.settings` holds: strict at every level, every string at most 4096 characters, every record and list at most 256 entries.
 * A bound is a whole number with one of three origins, a prompt and a lens's question a hash, and a provider only the fields
 * `providerView` writes for a result: no base URL, origin, command, args or key, a header's and a query's value the redacted
 * word, and `extraBody` as the rule of `config/settings.ts` writes it, each value a scalar, a string of at most 64 code points, or objects and
 * arrays nested at most 4 deep, an entry of at most 64 values. A refusal names a path, never a value.
 */
export const settingsSchema = z.strictObject({
  runtime: z.strictObject({
    name: text,
    version: text,
    platform: text,
    arch: text,
  }),
  strict: z.boolean(),
  concurrency: z.union([
    z.literal('auto'),
    z.int().min(1),
  ]),
  exclude: list(text),
  partTokens: settingValue,
  maxFindings: settingValue,
  findingsCap: settingValue,
  maxScannerIssues: settingValue,
  maxReviewTokens: settingValue,
  reviewTimeoutMs: settingValue,
  providers: table(providerSettings),
  profiles: z.record(profileId, profileSettings).refine(profiles => Object.keys(profiles).length <= SETTINGS_ENTRIES),
})

/** The profiles of a result, keyed by id: at least one, since a review runs at least one. */
function profilesOf<Meta extends z.ZodType>(meta: Meta) {
  return z.record(profileId, meta).refine(profiles => Object.keys(profiles).length > 0)
}

/** A verdict, as the cross-checks read it. */
interface CheckedVerdict {
  readonly profile: string
  readonly confidence?: unknown
  readonly foundBy: { readonly kind: string, readonly report?: number }
}

/** What the cross-checks read of a result or of a public view. */
interface Checked {
  readonly kept: readonly CheckedVerdict[]
  readonly discarded: readonly CheckedVerdict[]
  readonly unreviewed: readonly CheckedVerdict[]
  readonly meta: {
    readonly profiles: Readonly<Record<string, unknown>>
    readonly incomplete: ReadonlyArray<{ readonly profile: string }>
    readonly context: { readonly reports: ReadonlyArray<{ readonly profile?: string }> }
  }
}

/**
 * What no single field says: every verdict and every gap names a profile of `meta.profiles`, a kept verdict has
 * a confidence, and a discarded or an unreviewed one has none, and a verdict a scanner found names, as its `foundBy.report`, a record of
 * `meta.context.reports` that was read for the verdict's own profile. The messages are fixed words, never the input.
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
      const { report } = verdict.foundBy
      // A place that is no count is refused by the field's own check, and not twice.
      if (verdict.foundBy.kind === 'scanner' && typeof report === 'number' && Number.isInteger(report) && report >= 0 && result.meta.context.reports[report]?.profile !== verdict.profile) {
        context.addIssue({
          code: 'custom',
          path: [list, index, 'foundBy', 'report'],
          message: 'must name a report of the finding\'s profile in meta.context.reports',
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
    settings: settingsSchema.nullable(),
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
 * What only the public view says: a discarded verdict it lists is one a scanner found, since the finder's are withheld and counted
 * (`publicView`). The message is a fixed word, never the input.
 */
function checkDiscarded(view: { readonly discarded: ReadonlyArray<{ readonly foundBy: { readonly kind: string } }> }, context: z.RefinementCtx): void {
  view.discarded.forEach((verdict, index) => {
    if (verdict.foundBy.kind !== 'scanner') {
      context.addIssue({
        code: 'custom',
        path: ['discarded', index, 'foundBy', 'kind'],
        message: 'is a scanner\'s alone: the finder\'s discarded findings are withheld',
      })
    }
  })
}

/**
 * The schema of the public view (`publicView`): the same parts, less what the view withholds. `meta.view` is
 * the literal `public`, `discarded` lists the verdicts a scanner found and no other, and a vote, a profile's meta and a gap hold no field
 * the view drops, so a result forged to look like a view, with a vote's reasoning, a usage, the calls, the providers or a
 * gap's detail, or the finder's discarded finding, is refused. `result-schema.spec.ts` holds its output type equal to `PublicView`.
 */
export const publicViewSchema = z.strictObject({
  kept: z.array(verdictOf(publicVote)),
  discarded: z.array(verdictOf(publicVote)),
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
}).superRefine(checkResult).superRefine(checkDiscarded)
