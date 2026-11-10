import { z } from 'zod'
import { ConfigError } from '../core/errors.ts'
import type { ConfigIssue } from '../core/errors.ts'
import type { Provider } from '../core/ports.ts'
import { securityProfile } from '../profiles/security.ts'
import { wordList } from '../providers/options.ts'
import type { StructuredOutput } from '../providers/options.ts'
import { presets } from '../providers/presets.ts'
import type { PresetName, Protocol } from '../providers/presets.ts'

/** A provider name, a profile id or a lens id: the pattern of every id the core takes. */
const NAME = /^[a-z][a-z0-9_-]*$/
/** An environment variable name, as a POSIX shell takes one. A JSON Schema pattern takes no flags, and messages print it as written. */
// eslint-disable-next-line regexp/use-ignore-case, regexp/prefer-w
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A path segment a message may print: a record key is the user's text, and a pasted secret could be one. */
const SAFE_SEGMENT = /^[\w$-]{1,64}$/

/** Every protocol, as a record, so the type checker reports a protocol this list misses. */
const PROTOCOLS: Readonly<Record<Protocol, true>> = { 'openai-compatible': true, anthropic: true, gemini: true, ollama: true }
const STRUCTURED_OUTPUTS: Readonly<Record<StructuredOutput, true>> = { prompt: true, json: true, schema: true }

const VERSION = 'must be 1, the only config version this quorum reads: upgrade quorum to read a later one'

const name = z.string().regex(NAME)

const roles = z.strictObject({
  research: name.optional().describe('The provider that looks for candidate findings'),
  voter: name.optional().describe('The provider every lens votes with, unless the lens names its own'),
})

const auth = z.union([
  z.enum(['bearer', 'x-api-key', 'none']),
  z.strictObject({
    header: z.string().describe('The header that carries the key'),
    prefix: z.string().optional().describe('The text sent before the key in that header'),
  }),
], { error: 'must be bearer, x-api-key, none or { header, prefix }' })

const providerShape = {
  preset: z.enum(Object.keys(presets) as [PresetName, ...PresetName[]]).optional().describe('A preset: the defaults of a vendor\'s documented endpoint, which the fields set here override'),
  protocol: z.enum(Object.keys(PROTOCOLS) as [Protocol, ...Protocol[]]).optional().describe('The wire protocol; required without a preset, and the preset\'s own when both are set'),
  baseUrl: z.string().optional().describe('The http(s) URL of the endpoint, with no credentials, query or fragment; required without a preset, or with one that has none'),
  model: z.string().optional().describe('The model id sent with every request'),
  apiKeyEnv: z.string().regex(ENV_NAME).optional().describe('The environment variable that holds the key; a preset names its vendor\'s own'),
  auth: auth.optional().describe('How the key is sent: bearer, x-api-key, none, or in a header of its own after an optional prefix'),
  headers: z.record(z.string(), z.string()).optional().describe('Extra request headers; their values are redacted from error messages, as the key is'),
  query: z.record(z.string(), z.string()).optional().describe('Query parameters added to every request URL; they are not redacted, so never put a key here'),
  extraBody: z.record(z.string(), z.json()).optional().describe('JSON values deep-merged into the request body last'),
  structuredOutput: z.enum(Object.keys(STRUCTURED_OUTPUTS) as [StructuredOutput, ...StructuredOutput[]]).optional().describe('How the reply shape reaches the endpoint: described in the prompt, as a JSON object, or as a strict schema'),
  temperature: z.number().nullable().optional().describe('The sampling temperature; null leaves the field out'),
  maxTokens: z.int().min(1).optional().describe('The most tokens the reply may hold'),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional().describe('The body field that carries maxTokens, on the openai-compatible protocol'),
  systemPrompt: z.enum(['native', 'inline']).optional().describe('Where the instructions go: the protocol\'s system field, or inline in the first message'),
}

const prompt = z.union([
  z.string(),
  z.strictObject({ file: z.string().describe('The file that holds the template, relative to the directory of the config file') }),
], { error: 'must be a string or { file }' })

const rule = z.union([
  z.enum(['unanimous', 'majority', 'any', 'off']),
  z.literal(false),
  z.strictObject({ minVotes: z.int().min(1).describe('The kept votes the level needs') }),
  z.strictObject({ minRatio: z.number().gt(0).lte(1).describe('The share of the lenses whose kept votes the level needs, above 0 and at most 1') }),
], { error: 'must be unanimous, majority, any, off, false, { minVotes } or { minRatio }' })

const profile = z.strictObject({
  extends: z.enum([securityProfile.id]).optional().describe('The built-in profile this one starts from'),
  gating: z.boolean().optional().describe('Whether its kept high findings set exit code 1'),
  roles: roles.optional().describe('The providers of this profile, over the top-level roles'),
  prompts: z.strictObject({
    research: prompt.optional().describe('The research instructions: a template, or { file }'),
    vote: prompt.optional().describe('The vote instructions, which take {{lens.id}}, {{lens.question}} and {{panel.size}}: a template, or { file }'),
  }).optional().describe('The instruction templates of the profile'),
  lenses: z.array(z.strictObject({
    id: name.describe('Names the lens'),
    question: z.string().describe('What the voter judging from this lens is asked'),
    provider: name.optional().describe('The provider of this lens, over the roles'),
  })).min(1).optional().describe('The angles of the panel: at least one'),
  policy: z.strictObject({
    high: rule.optional().describe('The kept votes a high finding needs'),
    medium: rule.optional().describe('The kept votes a medium finding needs'),
    low: rule.optional().describe('The kept votes a low finding needs'),
  }).optional().describe('How many kept votes each confidence level needs: unanimous, majority, any, off or false, { minVotes } or { minRatio }'),
})

/** A config of either variant, around the schema of one provider entry, in the order editors show the fields. */
function configSchema<P extends z.ZodType>(provider: P) {
  return z.strictObject({
    $schema: z.string().optional().describe('The JSON Schema of this file, for editors; quorum does not read it'),
    version: z.literal(1, { error: VERSION }).optional().describe('The version of the config format: 1'),
    providers: z.record(name, provider).optional().describe('The model endpoints, by name'),
    roles: roles.optional().describe('The providers every profile uses, unless it names its own'),
    concurrency: z.int().min(1).optional().describe('The most provider calls in flight at once in one review, shared by every profile'),
    maxFindings: z.int().min(1).optional().describe('The most findings of a research reply each profile reads, the only ones that can reach its panel'),
    profiles: z.record(name, profile).optional().describe('The review profiles, by id: a built-in profile, one that extends it, or one of your own'),
  })
}

/** Whether `value` implements `Provider` as a code config can hand one over: an object whose `complete` is a function. */
export function isProvider(value: unknown): value is Provider {
  return typeof value === 'object' && value !== null && typeof (value as { complete?: unknown }).complete === 'function'
}

/**
 * A YAML or JSON config: data only, so a provider names the variable that holds its key and never holds
 * one. Every object is strict, so a typo is an issue. It checks shapes only: a field a later layer can
 * fill is optional, and the references between fields are checked once the layers are merged.
 */
export const configFileSchema = configSchema(z.strictObject(providerShape))

/** A TS or JS config: the file variant, where a provider may also hold its key, or be an object implementing `Provider`. */
export const configCodeSchema = configSchema(z.union([
  z.custom<Provider>(isProvider),
  z.strictObject({ ...providerShape, apiKey: z.string().optional().describe('The key itself, which only a code config may hold') }),
], { error: 'must be the settings of a provider, or an object whose complete is a function' }))

/** What a TS or JS config exports as its default. */
export type QuorumConfig = z.input<typeof configCodeSchema>
/** What a YAML or JSON config holds. */
export type QuorumConfigFile = z.input<typeof configFileSchema>

/** What each type zod expects is called in a message. */
const TYPE_WORDS: Readonly<Record<string, string>> = { string: 'a string', number: 'a number', int: 'an integer', boolean: 'true or false', object: 'an object', record: 'an object', array: 'an array' }

/**
 * The project's wording of a zod issue, as `safeParse` takes it in its `error` option. A schema's own
 * message (the version, a union) comes first, since zod applies it before this one. Unknown keys are
 * worded by `configIssues`. Nothing here repeats the value: zod hands it over, and only its type is read.
 */
function wording(issue: z.core.$ZodRawIssue): string | undefined {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined) return 'is required'
      if (issue.expected === 'number' && typeof issue.input === 'number') return 'must be a finite number'
      return Object.hasOwn(TYPE_WORDS, issue.expected) ? `must be ${TYPE_WORDS[issue.expected]}` : undefined
    case 'invalid_value':
      return `must be ${issue.values.length > 1 ? 'one of ' : ''}${wordList(issue.values.map(String))}`
    case 'too_small':
      // The one bound on a list is the lenses' one entry.
      if (issue.origin === 'array') return 'must not be empty'
      return issue.inclusive ? `must be at least ${issue.minimum}` : `must be greater than ${issue.minimum}`
    case 'too_big':
      return issue.inclusive ? `must be at most ${issue.maximum}` : `must be less than ${issue.maximum}`
    case 'invalid_format':
      // No pattern of the schema has flags, so the pattern is the text between its slashes.
      return issue.format === 'regex' && typeof issue.pattern === 'string' ? `must match ${issue.pattern.slice(1, -1)}` : undefined
    case 'invalid_key':
      return `is a key that ${issue.issues[0]?.message ?? 'is not allowed'}`
    case 'invalid_union':
      return 'matches none of the forms it can take'
    default:
      return undefined
  }
}

/** A path as an issue names it: its segments joined with `.`, each one that is not a safe name or an index printed as `*`, after `prefix` and `: `. */
export function configPath(segments: readonly PropertyKey[], prefix?: string): string {
  const path = segments.map(key => typeof key === 'number' || (typeof key === 'string' && SAFE_SEGMENT.test(key)) ? String(key) : '*').join('.')
  if (prefix === undefined) return path
  return path === '' ? prefix : `${prefix}: ${path}`
}

const belowRoot = (issue: z.core.$ZodIssue): boolean => issue.path.length > 0
const belowRootOrUnknown = (issue: z.core.$ZodIssue): boolean => belowRoot(issue) || issue.code === 'unrecognized_keys'

/**
 * The issues of the one option of a failed union that took the value's shape: the one whose issues all
 * lie below its root, or else the one whose only issues at its root are fields it does not know.
 * Undefined when no option, or several, did.
 */
function shapedOption(options: readonly (readonly z.core.$ZodIssue[])[]): readonly z.core.$ZodIssue[] | undefined {
  for (const took of [belowRoot, belowRootOrUnknown]) {
    const shaped = options.filter(issues => issues.every(took))
    if (shaped.length === 1) return shaped[0]
  }
  return undefined
}

function issuesOf(issue: z.core.$ZodIssue, base: readonly PropertyKey[], prefix: string | undefined): ConfigIssue[] {
  const path = [...base, ...issue.path]
  if (issue.code === 'unrecognized_keys') {
    const known = issue.keys.filter(key => SAFE_SEGMENT.test(key)).map(key => ({ path: configPath([...path, key], prefix), message: 'is not a known field' }))
    return known.length < issue.keys.length ? [...known, { path: configPath(path, prefix), message: 'holds a field that is not known' }] : known
  }
  const shaped = issue.code === 'invalid_union' ? shapedOption(issue.errors) : undefined
  if (shaped !== undefined) return shaped.flatMap(nested => issuesOf(nested, path, prefix))
  return [{ path: configPath(path, prefix), message: issue.message }]
}

/**
 * The issues of a failed parse, each at its path after `prefix`. An unknown key is one issue per key at
 * `<path>.<key>`, or one at `<path>` for the keys that are not safe names. A union that no option matched
 * is reported by the one option that took the value's shape, when there is one, so a typo inside
 * `{ file }` is reported at its field. No message repeats a value.
 */
export function configIssues(error: z.ZodError, prefix?: string): ConfigIssue[] {
  return error.issues.flatMap(issue => issuesOf(issue, [], prefix))
}

/**
 * Check `value` against a config schema, with the project's wording, and hand back the checked config or
 * every issue at once, each at its path after `prefix`, without throwing them: a caller that guards the
 * read of a value whose code can throw keeps the issues it builds out of that guard.
 */
export function checkConfig<T>(schema: z.ZodType<T>, value: unknown, prefix?: string): { readonly config: T } | { readonly issues: ConfigIssue[] } {
  const result = schema.safeParse(value, { error: wording })
  return result.success ? { config: result.data } : { issues: configIssues(result.error, prefix) }
}

/**
 * Check `value` against a config schema, with the project's wording.
 *
 * @throws ConfigError with every issue at once, each at its path after `prefix`
 */
export function parseConfig<T>(schema: z.ZodType<T>, value: unknown, prefix?: string): T {
  const checked = checkConfig(schema, value, prefix)
  if ('issues' in checked) throw new ConfigError(checked.issues)
  return checked.config
}
