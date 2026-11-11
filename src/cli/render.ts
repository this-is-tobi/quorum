import { own } from '../config/profiles.ts'
import type { ResolvedProfile } from '../config/profiles.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { isProvider } from '../config/schema.ts'
import type { EventSink, Provider } from '../core/ports.ts'
import { inertLine } from '../core/sanitize.ts'
import type { Flag, QuorumEvent } from '../core/types.ts'
import { isClaudeCode } from '../providers/build.ts'
import { originOf } from '../providers/http.ts'
import { presetOf } from '../providers/presets.ts'

/**
 * The progress line of an event, or undefined for the events the CLI keeps quiet about. These lines
 * are the CLI's progress output on stderr, so a person follows a run without the full event stream.
 * Each line passes through `inertLine` whole: the reasons, details and file names it carries come
 * from the finder or the diff, and nothing in them can act on a terminal or a CI log. When `prefixed`,
 * a line of an event that names a profile starts with `[<profile>] `: the `flag:` and totals lines
 * belong to the whole review and never do.
 */
export function renderEvent(event: QuorumEvent, prefixed = false): string | undefined {
  const line = progressLine(event, prefixed)
  return line === undefined ? undefined : inertLine(line)
}

const profilePrefix = (profile: string): string => `[${profile}] `

function progressLine(event: QuorumEvent, prefixed: boolean): string | undefined {
  const of = (profile: string, line: string): string => prefixed ? `${profilePrefix(profile)}${line}` : line
  switch (event.type) {
    case 'stage:end':
      return event.stage === 'dedup' ? of(event.profile, `${event.count} candidate(s) after dedup`) : undefined
    case 'finding:invalid':
      return of(event.profile, `invalid finding dropped: ${event.reason}`)
    case 'incomplete':
      return of(event.entry.profile, `incomplete: ${event.entry.reason} (${event.entry.detail})`)
    case 'flag':
      return `flag: ${event.flag.code}${where(event.flag)} (${event.flag.detail})`
    case 'run:end':
      return `${event.kept} kept, ${event.discarded} discarded, ${event.unreviewed} unreviewed by panel`
    default:
      return undefined
  }
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
 * The origin of a provider defined as data, as the banner and `--print-config` name its endpoint: the
 * scheme, host and port of its own base URL, else of its preset's. Both are read as own fields, so a
 * polluted `Object.prototype` fills neither.
 */
export function providerOrigin(spec: Exclude<ResolvedProvider, Provider>): string {
  return originOf(own(spec, 'baseUrl') ?? presetOf(own(spec, 'preset'))?.baseUrl ?? '')
}

/** Where a provider defined as data is reached, as the banner names it: its origin, or `claude-code` for the CLI, which has none. */
function endpointOf(spec: Exclude<ResolvedProvider, Provider>): string {
  return isClaudeCode(own(spec, 'protocol')) ? 'claude-code' : providerOrigin(spec)
}

/** What a provider reads as in the banner: its model and where it is reached, a provider object by its config key. */
function providerLabel(providers: ResolvedConfig['providers'], name: string): string {
  // Resolution bound every profile to providers it kept, so each name is found.
  const entry = own(providers, name) as ResolvedProvider
  return isProvider(entry) ? `${entry.model} @ the provider object ${name}` : `${own(entry, 'model')} @ ${endpointOf(entry)}`
}

/** The banner of one profile: its research provider, then its panel, one provider for every lens when they share it. */
function profileBanner({ research, voters }: ResolvedProfile, providers: ResolvedConfig['providers']): string[] {
  const label = (name: string): string => providerLabel(providers, name)
  const lenses = Object.entries(voters)
  const panel = new Set(lenses.map(([, name]) => name)).size === 1
    ? label(lenses[0][1])
    : lenses.map(([lens, name]) => `${lens} (${label(name)})`).join(', ')
  return [`Research (${label(research)})...`, `Panel will use ${panel}`]
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
  return config.profiles.flatMap((resolved) => {
    const prefix = prefixed ? profilePrefix(resolved.profile.id) : ''
    return profileBanner(resolved, config.providers).map(line => inertLine(`${prefix}${line}`))
  })
}
