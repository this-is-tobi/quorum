import { own } from '../config/profiles.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { isProvider } from '../config/schema.ts'
import { providerOrigin } from '../config/settings.ts'
import type { ProfileBudgets } from '../core/budgets.ts'
import { DEFAULT_MAX_REVIEW_TOKENS, DEFAULT_REVIEW_TIMEOUT_MS } from '../core/limits.ts'
import type { Provider } from '../core/ports.ts'
import { DEFAULT_MAX_FINDINGS } from '../core/prompts.ts'
import { inertLine } from '../core/sanitize.ts'
import type { Estimate } from '../core/types.ts'
import { isClaudeCode } from '../providers/build.ts'
import { durationText, tokenWords } from '../report/lines.ts'
import type { ReportView } from '../report/view.ts'
import { profilePrefix } from './view/lines.ts'
import type { CapOrigin, ViewFacts } from './view/model.ts'

/**
 * Where a path review's token cap, deadline and finding cap came from, which the estimate's bounds line says: the token cap
 * is the estimate's own worst case (`estimate`), the default floor that holds it (`floor`), or the config's `maxReviewTokens`
 * (`config`); the deadline is the longest allowed (`longest`) or the config's `reviewTimeoutMs` (`config`); the finding cap is
 * the config's `findingsCap` (`findingsCap`), its `maxFindings` (`maxFindings`), four per research part (`parts`), or the default, which holds four per research part (`floor`).
 */
export interface Bounds {
  readonly cap: 'estimate' | 'floor' | 'config'
  readonly deadline: 'longest' | 'config'
  readonly findings: 'findingsCap' | 'maxFindings' | 'parts' | 'floor'
}

/** The findings a path review's panel reads for each research part when its config sets no cap: a finder lists 1.9 a part on average and up to 18 in one, so one a part left most of them unread. */
export const PATH_FINDINGS_PER_PART = 4

/**
 * The finding cap of a path review whose config sets no `findingsCap` and no `maxFindings`: the larger of the default, 50, and
 * `PATH_FINDINGS_PER_PART` times each profile's research part count, so its panel can read four findings per part. `estimate` is made under the quorum's own limits.
 */
export function findingsCapOf(estimate: Estimate): number {
  return Math.max(DEFAULT_MAX_FINDINGS, ...Object.values(estimate.profiles).map(profile => PATH_FINDINGS_PER_PART * profile.parts.length))
}

/** How the estimate writes a token count and a duration: for a person, or as the exact integers a program parses. */
export interface NumberWords {
  readonly tokens: (count: number) => string
  readonly duration: (ms: number) => string
}

/** What a person reads: a count scaled as the live view scales it (`1.85M`), a duration as every line writes one (`1.5s`, `42s`, `24h00m00s`), so a deadline under a minute is never rounded to a whole second. */
export const PERSON_WORDS: NumberWords = { tokens: tokenWords, duration: durationText }

/** What a program parses, under `--progress json`: a count as its integer, a duration in milliseconds. */
export const EXACT_WORDS: NumberWords = {
  tokens: String,
  duration: ms => `${ms} ms`,
}

/**
 * The lines a path review prints once its estimate is made, before any call: one per profile, starting with
 * `[<id>] ` when several run, and ending with what the profile's documents add to each research request and each vote when
 * they add anything, then the whole review's two lines, never prefixed: its cost (the research's expected
 * spend, the worst case with every vote and every part recovered, and what its calls in flight reserve) and its
 * bounds (the review's token cap, deadline and finding cap, where each came from, and that the config sets none of
 * them when it sets none). The expected figure is the research's alone, as the votes are in the worst case only, and
 * the worst counts every part recovered. When research alone expects over half of the token cap, one line follows that
 * says what cap the review needs (`needed`, always exact, as it is the value to set), and then one for each research
 * provider whose reply asks for fewer findings than its profile's `maxFindings`, since the parts with more split. Each count and
 * duration is written by `words`, scaled for a person unless a program is to parse it. Each line is inert.
 */
export function estimateLines(estimate: Estimate, bounds: Bounds, words: NumberWords = PERSON_WORDS): string[] {
  const entries = Object.entries(estimate.profiles)
  const prefixed = entries.length > 1
  const noneSet = bounds.cap !== 'config' && bounds.deadline === 'longest' && (bounds.findings === 'parts' || bounds.findings === 'floor')
  return [
    ...entries.map(([id, { parts, expected, votes, worst, documents }]) => {
      const prefix = prefixed
        ? profilePrefix(id)
        : ''
      const added = documents.research > 0 || documents.vote > 0
        ? `; its documents add ${words.tokens(documents.research)} tokens to each research request and ${words.tokens(documents.vote)} to each vote`
        : ''
      return `${prefix}estimate: ${parts.length} research part(s), about ${words.tokens(expected)} tokens expected for them; then up to ${votes} vote(s), at most ${words.tokens(worst)} tokens in all${added}`
    }),
    `estimate: research about ${words.tokens(estimate.expected)} tokens expected, at most ${words.tokens(estimate.worst)} with every vote and every part recovered, ${words.tokens(estimate.inFlight)} of them reserved at once`,
    `bounds: the token cap ${capWords(estimate, bounds, words)}; the deadline ${deadlineWords(estimate, bounds, words)}; the finding cap ${findingsWords(estimate, bounds)}${noneSet
      ? '; the config sets none of them'
      : ''}`,
    ...capLine(estimate, words),
    ...findingsLines(estimate),
  ].map(inertLine)
}

function capWords({ maxReviewTokens: cap }: Estimate, { cap: origin }: Bounds, words: NumberWords): string {
  if (origin === 'config') return `${words.tokens(cap)} (maxReviewTokens)`
  return origin === 'estimate'
    ? `${words.tokens(cap)}, this estimate's worst case`
    : `${words.tokens(cap)}, the default, which holds this estimate's worst case`
}

function deadlineWords({ reviewTimeoutMs: ms }: Estimate, { deadline }: Bounds, words: NumberWords): string {
  return deadline === 'config'
    ? `${words.duration(ms)} (reviewTimeoutMs)`
    : `${words.duration(ms)}, the longest allowed`
}

function findingsWords({ findingsCap: cap }: Estimate, { findings: origin }: Bounds): string {
  if (origin === 'findingsCap' || origin === 'maxFindings') return `${cap} (${origin})`
  return origin === 'parts'
    ? `${cap}, four per research part`
    : `${cap}, the default, which holds four per research part`
}

/**
 * The warnings a path review's bounds call for, each inert and its counts written by `words`: for a cap that follows the
 * estimate (the config sets none), a large review when its research's expected spend and what its calls in flight reserve
 * pass the default cap, the review that 0.8.0 held at exit 2, which Ctrl-C stops and keeps what it read; a small review says
 * nothing, though recovery's bound puts its worst case past the default too. For a cap the config sets that the estimate does
 * not fit under, the research parts it holds, since the review runs to the cap and the rest is a `token-cap` gap.
 */
export function boundWarnings(estimate: Estimate, bounds: Bounds, words: NumberWords = PERSON_WORDS): string[] {
  const profiles = Object.values(estimate.profiles)
  const parts = profiles.reduce((total, profile) => total + profile.parts.length, 0)
  const votes = profiles.reduce((total, profile) => total + profile.votes, 0)
  if (bounds.cap !== 'config' && estimate.expected + estimate.inFlight > DEFAULT_MAX_REVIEW_TOKENS) {
    return [
      inertLine(`warning: a large review: ${parts} research part(s) and up to ${votes} vote(s), about ${words.tokens(estimate.expected)} tokens expected and at most ${words.tokens(estimate.worst)}: Ctrl-C stops it and keeps what it read`),
    ]
  }
  if (bounds.cap === 'config' && !estimate.fits) {
    return [
      inertLine(`warning: the token cap of ${words.tokens(estimate.maxReviewTokens)} (maxReviewTokens) holds about ${estimate.held} of the ${parts} research parts this estimate expects: the review runs to the cap, and what it cannot pay for is a token-cap gap; unset maxReviewTokens to let a path review's cap follow its estimate`),
    ]
  }
  return []
}

/** The next hundred thousand tokens at or above `tokens`. */
const roundedUp = (tokens: number): number => Math.ceil(tokens / 100_000) * 100_000

/**
 * The line that says research alone takes most of the token cap, and what cap the review needs: what its research
 * expects and its calls in flight reserve, and every vote at a third of its bound (the research's `expected`
 * counts each reply at a third as well), rounded up to the next 100 000. The needed cap is the value to set, so it stays
 * the exact integer whatever `words` write. None when research expects half the cap or less.
 */
function capLine(estimate: Estimate, words: NumberWords): string[] {
  const { expected, inFlight, findingsCap, maxReviewTokens: cap } = estimate
  if (expected * 2 <= cap) return []
  const votes = Object.values(estimate.profiles).reduce((total, profile) => total + findingsCap * Object.values(profile.vote).reduce((bounds, bound) => bounds + bound, 0), 0)
  const needed = roundedUp(expected + inFlight + votes / 3)
  return [
    `estimate: research alone expects about ${words.tokens(expected)} of the review's token cap of ${words.tokens(cap)} (${Math.round(expected * 100 / cap)}%): a review of this size needs a cap of about ${needed}: raise maxReviewTokens, or narrow the path`,
  ]
}

/**
 * One line for each research provider whose request asks for fewer findings than its profile's `maxFindings`, in profile order,
 * once however many profiles share the provider and the ceiling: a reply with more findings than it was asked for splits its part,
 * so the review makes more calls than the estimate counts. A profile whose research makes no call asks nothing, and one that asks
 * its own `maxFindings` in full is at its ceiling.
 */
function findingsLines(estimate: Estimate): string[] {
  const named = new Set<string>()
  const lines: string[] = []
  for (const { parts, findings, maxFindings, provider } of Object.values(estimate.profiles)) {
    const key = JSON.stringify([provider, maxFindings])
    if (parts.length === 0 || findings >= maxFindings || named.has(key)) continue
    named.add(key)
    lines.push(`estimate: on ${provider} a research reply asks for at most ${findings} of maxFindings ${maxFindings} findings: parts with more split, so expect more calls than this estimate; a larger window, or thinking: off, raises N`)
  }
  return lines
}

/** Where a provider defined as data is reached, as the banner names it: its origin, or `claude-code` for the CLI, which has none. */
function endpointOf(spec: Exclude<ResolvedProvider, Provider>): string {
  return isClaudeCode(own(spec, 'protocol'))
    ? 'claude-code'
    : providerOrigin(spec)
}

/** What a provider reads as in the banner: its model and where it is reached, a provider object by its config key. */
function providerLabel(providers: ResolvedConfig['providers'], name: string): string {
  // Resolution bound every profile to providers it kept, so each name is found.
  const entry = own(providers, name) as ResolvedProvider
  return isProvider(entry)
    ? `${entry.model} @ the provider object ${name}`
    : `${own(entry, 'model')} @ ${endpointOf(entry)}`
}

/**
 * Who researches and who votes in each profile of a config, by profile in run order, as the banner names
 * them: `<model> @ <origin>` for a provider (see `bannerLines`), the panel as one provider when every lens
 * shares it, else each lens's. Under the public view a provider is its config key alone, no model and no origin.
 * The labels are not yet inert: the caller makes each line it writes inert.
 */
export function profileProviders(config: ResolvedConfig, view: ReportView = 'full'): Array<{ readonly profile: string, readonly research: string, readonly panel: string }> {
  const label = (name: string): string => view === 'public'
    ? name
    : providerLabel(config.providers, name)
  return config.profiles.map(({ profile, research, voters }) => {
    const lenses = Object.entries(voters)
    return {
      profile: profile.id,
      research: label(research),
      panel: new Set(lenses.map(([, name]) => name)).size === 1
        ? label(lenses[0][1])
        : lenses.map(([lens, name]) => `${lens} (${label(name)})`).join(', '),
    }
  })
}

/**
 * The lines a run prints before its progress: who researches and who votes, from the resolved config, as
 * `<model> @ <origin>` (a provider object as `<model> @ the provider object <name>`, a `claude-code`
 * provider as `<model> @ claude-code`), never a path, a credential or a query. The panel line names one
 * provider when every lens shares it, else each lens's. Each line starts with `[<profile>] ` when several
 * profiles run, and is inert. Under the public view, which a stranger may read in a CI log, a provider is named
 * by its config key alone, as `Research (default)...` and `Panel will use default`: no model, no origin, and
 * no mention of a provider object or a claude-code one.
 */
export function bannerLines(config: ResolvedConfig, view: ReportView = 'full'): string[] {
  const prefixed = config.profiles.length > 1
  return profileProviders(config, view).flatMap(({ profile, research, panel }) => {
    const prefix = prefixed
      ? profilePrefix(profile)
      : ''
    return [`Research (${research})...`, `Panel will use ${panel}`].map(line => inertLine(`${prefix}${line}`))
  })
}

/** The bounds a path review derived, as the view's facts name them: the cap with where it came from, the deadline and the panel's finding cap. */
export interface BoundFacts {
  readonly cap: { readonly tokens: number, readonly origin: CapOrigin }
  readonly deadlineMs: number
  readonly findingsCap: number
}

/**
 * What the view knows of a review before it runs, from its resolved config: the calls at once, the token cap and
 * where it came from, the deadline and where it came from (`deadline`: the config's, else the longest allowed for a path review's bounds, else the default),
 * whether the review keeps its answered calls (`keeps`, which only a caller that offers `--state` knows: left out when unsaid, and the view then writes no state notice), the panel's finding cap (`maxFindings` in the facts, which sizes the votes to come: the config's
 * `findingsCap`, else its `maxFindings`, else the default), what each research request asks for (`asks`, from the quorum's `budgets`,
 * the config's `maxFindings`, which sizes the requests of every profile that sets none, and the `maxFindings` each profile sets of its own),
 * and for a path review its estimate. A path review's bounds are
 * derived, so it gives them as `bounds`, and they win over the config's. The view reads the config's numbers only
 * through these facts.
 */
export function viewFacts(config: ResolvedConfig, extra: { readonly estimate?: Estimate, readonly bounds?: BoundFacts, readonly budgets?: Readonly<Record<string, ProfileBudgets>>, readonly keeps?: boolean } = {}): ViewFacts {
  const { estimate, bounds, budgets = {}, keeps } = extra
  return {
    concurrency: config.concurrency ?? 'auto',
    cap: bounds?.cap ?? (config.maxReviewTokens === undefined
      ? { tokens: DEFAULT_MAX_REVIEW_TOKENS, origin: 'default' }
      : { tokens: config.maxReviewTokens, origin: 'config' }),
    deadlineMs: bounds?.deadlineMs ?? config.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    deadline: config.reviewTimeoutMs !== undefined
      ? 'config'
      : bounds === undefined
        ? 'default'
        : 'longest',
    ...keeps === undefined
      ? {}
      : { keeps },
    maxFindings: bounds?.findingsCap ?? config.findingsCap ?? config.maxFindings ?? DEFAULT_MAX_FINDINGS,
    asks: {
      maxFindings: config.maxFindings ?? DEFAULT_MAX_FINDINGS,
      findings: Object.fromEntries(Object.entries(budgets).map(([id, { research }]) => [id, research.findings])),
      own: Object.fromEntries(config.profiles.flatMap(({ profile }) => profile.maxFindings === undefined
        ? []
        : [
            [profile.id, profile.maxFindings],
          ])),
    },
    ...estimate === undefined
      ? {}
      : { estimate },
  }
}
