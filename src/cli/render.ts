import { own } from '../config/profiles.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { isProvider } from '../config/schema.ts'
import { DEFAULT_CONCURRENCY } from '../core/concurrency.ts'
import { DEFAULT_MAX_REVIEW_TOKENS, DEFAULT_REVIEW_TIMEOUT_MS } from '../core/limits.ts'
import type { Provider } from '../core/ports.ts'
import { DEFAULT_MAX_FINDINGS } from '../core/prompts.ts'
import { inertLine } from '../core/sanitize.ts'
import type { Estimate } from '../core/types.ts'
import { isClaudeCode } from '../providers/build.ts'
import { originOf } from '../providers/http.ts'
import { presetOf } from '../providers/presets.ts'
import type { ReportView } from '../report/view.ts'
import { profilePrefix } from './view/lines.ts'
import type { ViewFacts } from './view/model.ts'

/**
 * Where a path review's token cap and deadline came from, which the estimate's last line says: the cap is the
 * estimate's own worst case (`estimate`), the default floor that holds it (`floor`), or the config's `maxReviewTokens`
 * (`config`); the deadline is the longest allowed (`longest`) or the config's `reviewTimeoutMs` (`config`).
 */
export interface Bounds {
  readonly cap: 'estimate' | 'floor' | 'config'
  readonly deadline: 'longest' | 'config'
}

/**
 * The lines a path review prints once its estimate is made, before any call: one per profile, starting with
 * `[<id>] ` when several run, then the total, which belongs to the whole review and is never prefixed and ends with
 * the review's token cap and deadline and where each came from (`bounds`). The expected figure is the research's
 * alone, as the votes are in the worst case only, and the worst counts every part recovered. When research alone
 * expects over half of the token cap, one line follows that says what cap the review needs (`needed`), and then one
 * for each research provider whose reply asks for fewer findings than `maxFindings`, since the parts with more
 * split. Each line is inert.
 */
export function estimateLines(estimate: Estimate, bounds: Bounds): string[] {
  const entries = Object.entries(estimate.profiles)
  const prefixed = entries.length > 1
  return [
    ...entries.map(([id, { parts, expected, votes, worst }]) => {
      const prefix = prefixed
        ? profilePrefix(id)
        : ''
      return `${prefix}estimate: ${parts.length} research part(s), about ${expected} tokens expected for them; then up to ${votes} vote(s), at most ${worst} tokens in all`
    }),
    `estimate: research about ${estimate.expected} tokens expected, at most ${estimate.worst} with every vote and every part recovered, ${estimate.inFlight} of them reserved at once; the review's token cap is ${capWords(estimate, bounds)}, and its deadline ${deadlineWords(estimate, bounds)}${bounds.cap !== 'config' && bounds.deadline === 'longest'
      ? ': the config sets neither'
      : ''}`,
    ...capLine(estimate),
    ...findingsLines(estimate),
  ].map(inertLine)
}

function capWords({ maxReviewTokens: cap }: Estimate, { cap: origin }: Bounds): string {
  if (origin === 'config') return `${cap} (maxReviewTokens)`
  return origin === 'estimate'
    ? `${cap}, this estimate's worst case`
    : `${cap}, the default, which holds this estimate's worst case`
}

function deadlineWords({ reviewTimeoutMs: ms }: Estimate, { deadline }: Bounds): string {
  return deadline === 'config'
    ? `${ms} ms (reviewTimeoutMs)`
    : `${ms} ms, the longest allowed`
}

/**
 * The warnings a path review's bounds call for, each inert: for a cap that follows the estimate (the config sets none), a
 * large review when its research's expected spend and what its calls in flight reserve pass the default cap, the review
 * that 0.8.0 held at exit 2, which Ctrl-C stops and keeps what it read; a small review says nothing, though recovery's
 * bound puts its worst case past the default too. For a cap the config sets that the estimate does not fit under, the
 * research parts it holds, since the review runs to the cap and the rest is a `token-cap` gap.
 */
export function boundWarnings(estimate: Estimate, bounds: Bounds): string[] {
  const profiles = Object.values(estimate.profiles)
  const parts = profiles.reduce((total, profile) => total + profile.parts.length, 0)
  const votes = profiles.reduce((total, profile) => total + profile.votes, 0)
  if (bounds.cap !== 'config' && estimate.expected + estimate.inFlight > DEFAULT_MAX_REVIEW_TOKENS) {
    return [
      inertLine(`warning: a large review: ${parts} research part(s) and up to ${votes} vote(s), about ${estimate.expected} tokens expected and at most ${estimate.worst}: Ctrl-C stops it and keeps what it read`),
    ]
  }
  if (bounds.cap === 'config' && !estimate.fits) {
    return [
      inertLine(`warning: the token cap of ${estimate.maxReviewTokens} (maxReviewTokens) holds about ${estimate.held} of the ${parts} research parts this estimate expects: the review runs to the cap, and what it cannot pay for is a token-cap gap; unset maxReviewTokens to let a path review's cap follow its estimate`),
    ]
  }
  return []
}

/** The next hundred thousand tokens at or above `tokens`. */
const roundedUp = (tokens: number): number => Math.ceil(tokens / 100_000) * 100_000

/**
 * The line that says research alone takes most of the token cap, and what cap the review needs: what its research
 * expects and its calls in flight reserve, and every vote at a third of its bound (the research's `expected`
 * counts each reply at a third as well), rounded up to the next 100 000. None when research expects half the cap
 * or less.
 */
function capLine(estimate: Estimate): string[] {
  const { expected, inFlight, maxFindings, maxReviewTokens: cap } = estimate
  if (expected * 2 <= cap) return []
  const votes = Object.values(estimate.profiles).reduce((total, profile) => total + maxFindings * Object.values(profile.vote).reduce((bounds, bound) => bounds + bound, 0), 0)
  const needed = roundedUp(expected + inFlight + votes / 3)
  return [
    `estimate: research alone expects about ${expected} of the review's token cap of ${cap} (${Math.round(expected * 100 / cap)}%): a review of this size needs a cap of about ${needed}: raise maxReviewTokens, or narrow the path`,
  ]
}

/**
 * One line for each research provider whose request asks for fewer findings than `maxFindings`, in profile order,
 * once however many profiles share it: a reply with more findings than it was asked for splits its part, so the
 * review makes more calls than the estimate counts. A profile whose research makes no call asks nothing.
 */
function findingsLines(estimate: Estimate): string[] {
  const named = new Set<string>()
  const lines: string[] = []
  for (const { parts, findings, provider } of Object.values(estimate.profiles)) {
    if (parts.length === 0 || findings >= estimate.maxFindings || named.has(provider)) continue
    named.add(provider)
    lines.push(`estimate: on ${provider} a research reply asks for at most ${findings} of maxFindings ${estimate.maxFindings} findings: parts with more split, so expect more calls than this estimate; a larger window, or thinking: off, raises N`)
  }
  return lines
}

/**
 * The origin of a provider defined as data, as the banner and `--print-config` name its endpoint: the
 * scheme, host and port of its own base URL, else of its preset's. Both are read as own fields, so a
 * polluted `Object.prototype` fills neither.
 */
export function providerOrigin(spec: Exclude<ResolvedProvider, Provider>): string {
  return originOf(own(spec, 'baseUrl') ?? presetOf(own(spec, 'preset'))?.baseUrl ?? '')
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

/**
 * What the view knows of a review before it runs, from its resolved config: the calls at once, the token cap and
 * where it came from, the deadline, `maxFindings`, and for a path review its estimate. A path review's bounds are
 * derived, so it gives them as `bounds`, and they win over the config's. The view reads the config's numbers only
 * through these facts.
 */
export function viewFacts(config: ResolvedConfig, estimate?: Estimate, bounds?: { readonly cap: ViewFacts['cap'], readonly deadlineMs: number }): ViewFacts {
  return {
    concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
    cap: bounds?.cap ?? (config.maxReviewTokens === undefined
      ? { tokens: DEFAULT_MAX_REVIEW_TOKENS, origin: 'default' }
      : { tokens: config.maxReviewTokens, origin: 'config' }),
    deadlineMs: bounds?.deadlineMs ?? config.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    maxFindings: config.maxFindings ?? DEFAULT_MAX_FINDINGS,
    ...estimate === undefined
      ? {}
      : { estimate },
  }
}
