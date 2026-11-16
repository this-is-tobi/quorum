import { own } from '../config/profiles.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { isProvider } from '../config/schema.ts'
import type { EventSink, Provider } from '../core/ports.ts'
import { inertLine } from '../core/sanitize.ts'
import type { Estimate, Flag, LeftOutFile, QuorumEvent } from '../core/types.ts'
import { isClaudeCode } from '../providers/build.ts'
import { originOf } from '../providers/http.ts'
import { presetOf } from '../providers/presets.ts'

/**
 * The progress line of an event, or undefined for the events the CLI keeps quiet about. These lines
 * are the CLI's progress output on stderr, so a person follows a run without the full event stream.
 * Each line passes through `inertLine` whole: the reasons, details and file names it carries come
 * from the finder or the diff, and nothing in them can act on a terminal or a CI log. When `prefixed`,
 * a line of an event that names a profile starts with `[<profile>] `: the `left out:`, `flag:` and totals
 * lines belong to the whole review and never do.
 */
export function renderEvent(event: QuorumEvent, prefixed = false): string | undefined {
  const line = progressLine(event, prefixed)
  return line === undefined
    ? undefined
    : inertLine(line)
}

const profilePrefix = (profile: string): string => `[${profile}] `

/** How many of the files left out the progress line names; the JSON result lists every one. */
const LISTED_FILES = 5

function progressLine(event: QuorumEvent, prefixed: boolean): string | undefined {
  const of = (profile: string, line: string): string => prefixed
    ? `${profilePrefix(profile)}${line}`
    : line
  switch (event.type) {
    case 'stage:end':
      return event.stage === 'dedup'
        ? of(event.profile, `${event.count} candidate(s) after dedup`)
        : undefined
    case 'finding:invalid':
      return of(event.profile, `invalid finding dropped: ${event.reason}`)
    case 'incomplete':
      return of(event.entry.profile, `incomplete: ${event.entry.reason} (${event.entry.detail})`)
    case 'left-out':
      return leftOutLine(event.files)
    case 'flag':
      return `flag: ${event.flag.code}${where(event.flag)} (${event.flag.detail})`
    case 'run:end':
      return `${event.kept} kept, ${event.discarded} discarded, ${event.unreviewed} unreviewed by panel`
    default:
      return undefined
  }
}

/**
 * The line that names the files a review left out: their count, the first `LISTED_FILES` of them as
 * `<file> (<reason>)`, a skipped or a held one as `<file> (<reason>: <rule>)`, then how many more. A file is
 * a JSON string, as a flag's is; the empty name, which stands for a part of the diff no header names, is
 * `<no path>`.
 */
function leftOutLine(files: readonly LeftOutFile[]): string {
  const named = (file: string): string => file === ''
    ? '<no path>'
    : JSON.stringify(file)
  const reasonOf = (entry: LeftOutFile): string => 'rule' in entry
    ? `${entry.reason}: ${entry.rule}`
    : entry.reason
  const entries = files.slice(0, LISTED_FILES).map(entry => `${named(entry.file)} (${reasonOf(entry)})`)
  const more = files.length > LISTED_FILES
    ? ` and ${files.length - LISTED_FILES} more`
    : ''
  return `left out: ${files.length} file(s): ${entries.join(', ')}${more}`
}

/** Where a flag points: the file as a JSON string, with the line when it has one, else the line alone. */
function where({ file, line }: Flag): string {
  if (file !== undefined && line !== undefined) return ` at ${JSON.stringify(file)}:${line}`
  if (file !== undefined) return ` at ${JSON.stringify(file)}`
  if (line !== undefined) return ` at line ${line}`
  return ''
}

/**
 * The sink that writes the progress lines of a review: each event rendered by `renderEvent`, each line
 * that is defined handed to `write`. `run:start` says whether several profiles run, and then every
 * profile's line is prefixed. Rendering never throws, so the sink adds no failure of its own to a review.
 */
export function progressSink(write: (line: string) => void): EventSink {
  let prefixed = false
  return (event) => {
    if (event.type === 'run:start') prefixed = event.profiles.length > 1
    const line = renderEvent(event, prefixed)
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
 * shares it, else each lens's. The labels are not yet inert: the caller makes each line it writes inert.
 */
export function profileProviders(config: ResolvedConfig): Array<{ readonly profile: string, readonly research: string, readonly panel: string }> {
  const label = (name: string): string => providerLabel(config.providers, name)
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
 * profiles run, and is inert.
 */
export function bannerLines(config: ResolvedConfig): string[] {
  const prefixed = config.profiles.length > 1
  return profileProviders(config).flatMap(({ profile, research, panel }) => {
    const prefix = prefixed
      ? profilePrefix(profile)
      : ''
    return [`Research (${research})...`, `Panel will use ${panel}`].map(line => inertLine(`${prefix}${line}`))
  })
}
