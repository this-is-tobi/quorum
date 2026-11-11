import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { EventSink, ProfilePorts, Provider } from '../core/ports.ts'
import { createQuorum } from '../core/quorum.ts'
import type { Quorum } from '../core/types.ts'
import { buildProvider } from '../providers/build.ts'
import type { Env } from './env.ts'
import { checkCodeValue, thrownName } from './load.ts'
import { isResolvedConfig, resolveConfig } from './resolve.ts'
import type { ResolvedConfig, ResolvedProvider } from './resolve.ts'
import { configInputSchema, configPath, isProvider } from './schema.ts'
import type { ConfigInput } from './schema.ts'

/** A provider the config defines as data, built by the builder: its issues name the provider where the config defines it. */
function fromSpec(name: string, spec: Exclude<ResolvedProvider, Provider>): { readonly provider?: Provider, readonly issues: readonly ConfigIssue[] } {
  try {
    return { provider: buildProvider({ ...spec, id: name }), issues: [] }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return { issues: error.issues.map(({ path, message }) => ({ path: `providers.${path}`, message })) }
  }
}

/**
 * A provider object of the config under the name the config gives it: `model` and `complete` are read once,
 * so what is checked is what is used, and a throw while reading them is reported by the error's name alone.
 */
function fromObject(name: string, object: Provider): { readonly provider?: Provider, readonly issues: readonly ConfigIssue[] } {
  let model: unknown
  let complete: Provider['complete']
  try {
    ({ model, complete } = object)
  } catch (error) {
    return { issues: [{ path: configPath(['providers', name]), message: `could not be read (${thrownName(error)})` }] }
  }
  // The schema checked that `complete` is a function, and nothing has checked `model` yet.
  if (typeof model !== 'string') return { issues: [{ path: configPath(['providers', name, 'model']), message: 'must be a string' }] }
  return { provider: { id: name, model, complete: request => complete.call(object, request) }, issues: [] }
}

/** Each provider of a resolved config as a `Provider`, by name, or every issue of the providers that cannot be built. */
function buildProviders(providers: ResolvedConfig['providers']): ReadonlyMap<string, Provider> {
  const built = new Map<string, Provider>()
  const issues: ConfigIssue[] = []
  for (const [name, entry] of Object.entries(providers)) {
    const result = isProvider(entry) ? fromObject(name, entry) : fromSpec(name, entry)
    issues.push(...result.issues)
    if (result.provider !== undefined) built.set(name, result.provider)
  }
  if (issues.length > 0) throw new ConfigError(issues)
  return built
}

/**
 * Build a quorum from a config: the providers it defines, the profiles it runs and the environment over
 * them. A `ConfigInput` is checked as a code config is (so a program gets issues, never a `TypeError`, and
 * nothing its objects throw is printed) and resolved with `options.env`, which defaults to `process.env`; a
 * `ResolvedConfig` is used as it is, and the environment is not read again. Each provider defined as data
 * is built by the builder, and each provider object is wrapped under the name the config gives it. Every
 * issue is thrown at once, before anything is sent. `warnings` lists the config's, then the core's.
 *
 * @throws ConfigError listing every issue of the config, the environment, the providers and the profiles
 *
 * @example
 * const quorum = await fromConfig({}, { env: process.env })
 * const { kept } = await quorum.review({ diff: diffText })
 */
export async function fromConfig(config: ConfigInput | ResolvedConfig, options: { readonly env?: Env, readonly events?: EventSink } = {}): Promise<Quorum> {
  const resolved = isResolvedConfig(config)
    ? config
    : resolveConfig(checkCodeValue(configInputSchema, () => config, { notAnObject: 'must be an object', threw: 'could not be read' }), { env: options.env ?? process.env })
  const providers = buildProviders(resolved.providers)
  // Resolution bound every profile to providers it kept, so each name is found.
  const provider = (name: string): Provider => providers.get(name) as Provider
  const ports: Readonly<Record<string, ProfilePorts>> = Object.fromEntries(resolved.profiles.map(({ profile, research, voters }) => [
    profile.id,
    { research: provider(research), voters: Object.fromEntries(Object.entries(voters).map(([lens, name]) => [lens, provider(name)])) },
  ]))
  const quorum = createQuorum({ profiles: resolved.profiles.map(({ profile }) => profile), concurrency: resolved.concurrency, maxFindings: resolved.maxFindings }, { profiles: ports, events: options.events })
  return Object.freeze({ review: quorum.review, warnings: Object.freeze([...resolved.warnings, ...quorum.warnings]) })
}
