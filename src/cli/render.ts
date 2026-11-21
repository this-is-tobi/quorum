import { own } from '../config/profiles.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { isProvider } from '../config/schema.ts'
import type { EventSink, Provider } from '../core/ports.ts'
import { downWords, lackWords } from '../core/errors.ts'
import { inertLine } from '../core/sanitize.ts'
import type { Estimate, LeftOutFile, QuorumEvent } from '../core/types.ts'
import { isClaudeCode } from '../providers/build.ts'
import { originOf } from '../providers/http.ts'
import { presetOf } from '../providers/presets.ts'
import { flagWhere, leftOutEntry } from '../report/lines.ts'
import type { ReportView } from '../report/view.ts'

/**
 * The progress line of an event, or undefined for the events the CLI keeps quiet about. These lines
 * are the CLI's progress output on stderr, so a person follows a run without the full event stream.
 * Each line passes through `inertLine` whole: the reasons, details and file names it carries come
 * from the finder or the diff, and nothing in them can act on a terminal or a CI log. When `prefixed`,
 * a line of an event that names a profile starts with `[<profile>] `: the `left out:`, `flag:` and totals
 * lines belong to the whole review and never do.
 *
 * Under the public view, whose log a stranger may read, two lines leave out the text of a finder or a server: a
 * gap is `incomplete: <reason>`, then ` at <file as a JSON string>` when it has a file, with no detail, and a
 * dropped finding is `invalid finding dropped`, with no reason, since the reason quotes the file name and the text
 * of a finding the harness dropped, the oracle a discarded finding would be. Every other line is the full view's.
 */
export function renderEvent(event: QuorumEvent, prefixed = false, view: ReportView = 'full'): string | undefined {
  const line = progressLine(event, prefixed, view)
  return line === undefined
    ? undefined
    : inertLine(line)
}

const profilePrefix = (profile: string): string => `[${profile}] `

/** How many of the files left out the progress line names; the JSON result lists every one. */
const LISTED_FILES = 5

function progressLine(event: QuorumEvent, prefixed: boolean, view: ReportView): string | undefined {
  const of = (profile: string, line: string): string => prefixed
    ? `${profilePrefix(profile)}${line}`
    : line
  switch (event.type) {
    case 'stage:end':
      return event.stage === 'dedup'
        ? of(event.profile, `${event.count} candidate(s) after dedup`)
        : undefined
    case 'finding:invalid':
      return of(event.profile, view === 'public'
        ? 'invalid finding dropped'
        : `invalid finding dropped: ${event.reason}`)
    case 'incomplete':
      return of(event.entry.profile, view === 'public'
        ? `incomplete: ${event.entry.reason}${event.entry.file === undefined
          ? ''
          : ` at ${JSON.stringify(event.entry.file)}`}`
        : `incomplete: ${event.entry.reason} (${event.entry.detail})`)
    case 'provider-down':
      return downWords({
        providerId: event.provider,
        kind: event.kind,
        status: event.status,
        count: event.calls,
        streak: true,
        noAnswer: event.noAnswer,
      })
    case 'reply-lacked':
      return `${event.provider}: ${lackWords(event.kind, event)}`
    case 'left-out':
      return leftOutLine(event.files)
    case 'flag':
      return `flag: ${event.flag.code}${flagWhere(event.flag)} (${event.flag.detail})`
    case 'run:end':
      return `${event.kept} kept, ${event.discarded} discarded, ${event.unreviewed} unreviewed by panel`
    default:
      return undefined
  }
}

/**
 * The line that names the files a review left out: their count, then the first `LISTED_FILES` of them as
 * `leftOutEntry` writes them, then how many more.
 */
function leftOutLine(files: readonly LeftOutFile[]): string {
  const entries = files.slice(0, LISTED_FILES).map(leftOutEntry)
  const more = files.length > LISTED_FILES
    ? ` and ${files.length - LISTED_FILES} more`
    : ''
  return `left out: ${files.length} file(s): ${entries.join(', ')}${more}`
}

/**
 * The sink that writes the progress lines of a review: each event rendered by `renderEvent`, each line
 * that is defined handed to `write`. `run:start` says whether several profiles run, and then every
 * profile's line is prefixed. Rendering never throws, so the sink adds no failure of its own to a review. `view`
 * is the one `renderEvent` takes.
 */
export function progressSink(write: (line: string) => void, view: ReportView = 'full'): EventSink {
  let prefixed = false
  return (event) => {
    if (event.type === 'run:start') prefixed = event.profiles.length > 1
    const line = renderEvent(event, prefixed, view)
    if (line !== undefined) write(line)
  }
}

/**
 * The lines a path review prints once its estimate is made, before any call: one per profile, starting with
 * `[<id>] ` when several run, then the total, which belongs to the whole review and is never prefixed. The
 * expected figure is the research's alone, as the votes are in the worst case only. Each line is inert.
 */
export function estimateLines(estimate: Estimate): string[] {
  const entries = Object.entries(estimate.profiles)
  const prefixed = entries.length > 1
  return [
    ...entries.map(([id, { parts, expected, votes, worst }]) => {
      const prefix = prefixed
        ? profilePrefix(id)
        : ''
      return `${prefix}estimate: ${parts.length} research part(s), about ${expected} tokens expected for them; then up to ${votes} vote(s), at most ${worst} tokens in all`
    }),
    `estimate: research about ${estimate.expected} tokens expected, at most ${estimate.worst} with every vote, ${estimate.inFlight} of them reserved at once; the review's token cap is ${estimate.maxReviewTokens} and its deadline ${estimate.reviewTimeoutMs} ms`,
  ].map(inertLine)
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
