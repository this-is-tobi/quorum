import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RepositoryEntry } from '../config/profiles.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import type { ConfigInput } from '../config/schema.ts'
import type { ProfileBudgets } from '../core/budgets.ts'
import { documentSha256 } from '../core/documents.ts'
import type { Provider } from '../core/ports.ts'
import type { Profile, ReviewDocument, ReviewRule } from '../core/types.ts'
import { securityProfile } from '../profiles/security.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { fakeCredential } from '../testing/credentials.ts'
import { printConfig } from './print-config.ts'

const SPEC = {
  protocol: 'openai-compatible',
  baseUrl: 'https://h.example/v1',
  model: 'm',
  contextTokens: 131072,
} as const

/** A config with the built-in profile, every role of it bound to the first of `providers`. */
function config(providers: Record<string, ResolvedProvider>, rest: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const [name] = Object.keys(providers)
  const voters = Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, name]))
  return {
    providers,
    profiles: [
      {
        profile: securityProfile,
        research: name,
        voters,
        repository: [],
      },
    ],
    warnings: [],
    ...rest,
  } satisfies ResolvedConfig
}

/** The text printed for one provider spec. */
const printed = (spec: ResolvedProvider): string => printConfig(config({ a: spec }), undefined)

describe('printConfig', () => {
  it('prints a provider object by its name and model, never its function', () => {
    const complete: Provider['complete'] = async () => ({ text: '', model: 'm' })
    const named = printConfig(config({
      mine: { id: 'mine', model: 'm', complete },
    }), undefined)
    expect(named).toContain('  mine:\n    implements: Provider\n    model: m\nprofiles:\n')
    expect(named).not.toContain('complete')
    expect(named).not.toContain('=>')
    const unnamed = printConfig(config({
      mine: { id: 'mine', model: 7 as never, complete },
    }), undefined)
    expect(unnamed).toContain('  mine:\n    implements: Provider\nprofiles:\n')
  })

  it('prints a claude-code provider: its command, model, context size, auth mode and args, its key redacted, and no origin', () => {
    const text = printed({
      protocol: 'claude-code',
      command: '/opt/claude/bin/claude',
      model: 'sonnet',
      contextTokens: 1000000,
      auth: 'api-key',
      apiKey: 'sk-SECRET',
      args: ['--effort', 'high'],
    })
    expect(text).toContain('  a:\n    protocol: claude-code\n    command: /opt/claude/bin/claude\n    model: sonnet\n    contextTokens: 1000000\n    apiKey: "[redacted]"\n    auth: api-key\n    args:\n      - --effort\n      - high\nprofiles:\n')
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('origin')
  })

  it('prints the auth mode a claude-code provider runs with when it sets none', () => {
    expect(printed({
      protocol: 'claude-code',
      command: '/c',
      model: 'sonnet',
      contextTokens: 1000000,
    })).toContain('    contextTokens: 1000000\n    auth: inherit\nprofiles:\n')
  })

  it('prints a claude-code provider\'s reply mode when it sets one, and writes its command and args inert', () => {
    const hidden = String.fromCharCode(0x202E)
    const text = printed({
      protocol: 'claude-code',
      command: `/c${hidden}`,
      model: 'sonnet',
      contextTokens: 1000000,
      structuredOutput: 'prompt',
      args: [`--fallback-model=${hidden}`],
    })
    expect(text).toContain('    auth: inherit\n    args:\n      - --fallback-model=<U+202E>\n    structuredOutput: prompt\nprofiles:\n')
    expect(text).toContain('    command: /c<U+202E>\n')
    expect(text).not.toContain(hidden)
  })

  it('breaks a workflow command a key would start', () => {
    const text = printed({
      ...SPEC,
      extraBody: { '::error::x': 'value' },
    })
    expect(text).toContain('\n      <U+003A>:error::x: "[redacted]"\n')
    expect(text).not.toContain('\n      ::')
    expect(text).not.toContain('value')
  })

  it.each(['extraBody', 'query', 'headers'] as const)('prints a %s key that is no safe string as one [redacted] entry, and every value as [redacted]', (field) => {
    const key = fakeCredential('aws-key')
    const text = printed({
      ...SPEC,
      apiKey: 'k3y-secret',
      [field]: {
        before: 'a',
        [key]: 'b',
        after: 'c',
        'k3y-secret': 'd',
      },
    })
    expect(text).toContain(`    ${field}:\n      before: "[redacted]"\n      "[redacted]": "[redacted]"\n      after: "[redacted]"\n`)
    expect(text).not.toContain(key)
    expect(text).not.toContain('k3y-secret')
  })

  it('keeps a value that holds a newline, then a workflow command, inert on every line', () => {
    const hostile = 'a\n::error::forged\n##[group]forged'
    const text = printConfig(config({
      a: { ...SPEC, model: hostile },
    }, {
      warnings: [hostile],
    }), `/work/${hostile}.yaml`)
    expect(text).not.toMatch(/^\s*::/m)
    expect(text).not.toContain('##[')
    expect(text).toContain('<U+003A>:error::forged')
    expect(text).toContain('##<U+005B>group]forged')
  })

  it('prints each profile\'s failOn in place of gating, and the warning of a config that sets gating', () => {
    const voters = Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, 'a']))
    const warning = 'profiles.quiet.gating is deprecated: set failOn instead, high for true and none for false'
    const text = printConfig(config({ a: SPEC }, {
      profiles: [
        {
          profile: securityProfile,
          research: 'a',
          voters,
          repository: [],
        },
        {
          profile: { ...securityProfile, id: 'quiet', failOn: 'none' },
          research: 'a',
          voters,
          repository: [],
        },
        {
          profile: { ...securityProfile, id: 'strict', failOn: 'low' },
          research: 'a',
          voters,
          repository: [],
        },
      ],
      warnings: [warning],
    }), undefined)
    expect(text).toContain('\nprofiles:\n  security:\n    failOn: high\n    research: a\n')
    expect(text).toContain('\n  quiet:\n    failOn: none\n    research: a\n')
    expect(text).toContain('\n  strict:\n    failOn: low\n    research: a\n')
    expect(text).not.toContain('gating:')
    expect(text).toContain(`\nwarnings:\n  - "${warning}"\n`)
  })

  it('prints the values the review applies when the config sets none', () => {
    expect(printed(SPEC)).toContain('\nconcurrency: auto\nmaxFindings: 50\npartTokens: 32768\nmaxReviewTokens: 2000000\nreviewTimeoutMs: 1800000\nstrict: false\nexclude: []\nsend: []\nwarnings: []\n')
    expect(printConfig(config({ a: SPEC }, { concurrency: 2, maxFindings: 5 }), undefined)).toContain('\nconcurrency: 2\nmaxFindings: 5\n')
  })

  it('prints findingsCap after maxFindings when the config sets it, and nothing when it does not', () => {
    expect(printConfig(config({ a: SPEC }, { findingsCap: 300 }), undefined)).toContain('\nconcurrency: auto\nmaxFindings: 50\nfindingsCap: 300\npartTokens: 32768\n')
    expect(printConfig(config({ a: SPEC }, { maxFindings: 5, findingsCap: 300 }), undefined)).toContain('\nmaxFindings: 5\nfindingsCap: 300\npartTokens: 32768\n')
    expect(printed(SPEC)).not.toContain('findingsCap')
  })

  it('prints the review\'s limits as the review applies them', () => {
    expect(printConfig(config({ a: SPEC }, { maxReviewTokens: 500000, reviewTimeoutMs: 600000 }), undefined)).toContain('\nmaxReviewTokens: 500000\nreviewTimeoutMs: 600000\n')
  })

  it('prints strict as the review applies it', () => {
    expect(printConfig(config({ a: SPEC }, { strict: true }), undefined)).toContain('\nreviewTimeoutMs: 1800000\nstrict: true\nexclude: []\n')
  })

  it('prints the config\'s partTokens', () => {
    expect(printConfig(config({ a: SPEC }, { partTokens: 4096 }), undefined)).toContain('\npartTokens: 4096\n')
  })

  it('prints exclude as the config lists it, every pattern as written', () => {
    expect(printConfig(config({ a: SPEC }, {
      exclude: ['*.min.js', 'vendor/**'],
    }), undefined)).toContain('\nexclude:\n  - "*.min.js"\n  - vendor/**\nsend: []\nwarnings: []\n')
  })

  it('prints send after exclude, [] when the config lists none', () => {
    expect(printConfig(config({ a: SPEC }, {
      exclude: ['*.min.js'],
      send: ['src/.env', 'web/.env.production'],
    }), undefined)).toContain('\nexclude:\n  - "*.min.js"\nsend:\n  - src/.env\n  - web/.env.production\nwarnings: []\n')
    expect(printed(SPEC)).toContain('\nexclude: []\nsend: []\nwarnings: []\n')
  })

  it('prints each document as its hash and the base\'s own text as builtIn, never a text', () => {
    const guideline = 'Name things for what they do. PLANTED-GUIDELINE'
    const second = 'Prefer early returns.'
    const skipped = 'Generated files. PLANTED-SKIP'
    const base = 'Style and formatting. PLANTED-BASE'
    const document = (kind: ReviewDocument['kind'], text: string): ReviewDocument => ({
      profile: 'conventions',
      kind,
      // The hash is of the text as read, so a document whose cleaned text differs prints the hash of what its file held.
      origin: {
        kind: 'config',
        sha256: documentSha256(`${text}<!-- hidden -->`),
      },
      text,
    })
    const profile: Profile = {
      ...securityProfile,
      id: 'conventions',
      doNotReport: base,
      documents: [
        document('guidelines', guideline),
        document('guidelines', second),
        document('do-not-report', skipped),
      ],
    }
    const voters = Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, 'a']))
    const text = printConfig(config({ a: SPEC }, {
      profiles: [
        {
          profile,
          research: 'a',
          voters,
          repository: [],
        },
      ],
    }), undefined)
    const hash = (value: string): string => `sha256:${documentSha256(value)}`
    expect(text).toContain([
      '    prompts:',
      `      research: ${hash(securityProfile.prompts.research)}`,
      `      vote: ${hash(securityProfile.prompts.vote)}`,
      '    guidelines:',
      `      - ${hash(`${guideline}<!-- hidden -->`)}`,
      `      - ${hash(`${second}<!-- hidden -->`)}`,
      '    doNotReport:',
      `      - builtIn: ${hash(base)}`,
      `      - ${hash(`${skipped}<!-- hidden -->`)}`,
      'concurrency: auto',
    ].join('\n'))
    expect(text).not.toContain('PLANTED')
    expect(text).not.toContain('Prefer early')
    // A profile with only the base's text prints it alone, and one with only documents prints no builtIn.
    const only = (fields: Partial<Profile>): string => printConfig(config({ a: SPEC }, {
      profiles: [
        {
          profile: {
            ...securityProfile,
            ...fields,
          },
          research: 'a',
          voters,
          repository: [],
        },
      ],
    }), undefined)
    expect(only({ doNotReport: base })).toContain(`    doNotReport:\n      - builtIn: ${hash(base)}\nconcurrency: auto\n`)
    expect(only({ doNotReport: base })).not.toContain('guidelines:')
    expect(only({
      documents: [
        document('guidelines', second),
      ],
    })).not.toContain('doNotReport')
    expect(only({
      documents: [
        document('guidelines', second),
      ],
    })).not.toContain('builtIn')
    // A document whose reader computed no hash prints the hash of its text.
    expect(only({
      documents: [
        {
          profile: 'conventions',
          kind: 'guidelines',
          origin: { kind: 'config' },
          text: second,
        },
      ],
    })).toContain(`    guidelines:\n      - ${hash(second)}\n`)
  })

  it('prints a repository entry as its path and optional, in its place among the hashes', () => {
    const first = 'Name things for what they do.'
    const last = 'Prefer early returns.'
    const base = 'Style and formatting.'
    const document = (text: string): ReviewDocument => ({
      profile: 'conventions',
      kind: 'guidelines',
      origin: {
        kind: 'config',
        sha256: documentSha256(text),
      },
      text,
    })
    const entry = (kind: RepositoryEntry['kind'], path: string, index: number, optional = false): RepositoryEntry => ({
      kind,
      path,
      optional,
      at: `profiles.conventions.${kind === 'guidelines'
        ? 'guidelines'
        : 'doNotReport'}.${index}.repository`,
      index,
    })
    const profile: Profile = {
      ...securityProfile,
      id: 'conventions',
      doNotReport: base,
      documents: [
        document(first),
        document(last),
      ],
    }
    const voters = Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, 'a']))
    const text = printConfig(config({ a: SPEC }, {
      profiles: [
        {
          profile,
          research: 'a',
          voters,
          repository: [
            entry('guidelines', 'REVIEW.md', 1),
            entry('guidelines', 'docs/EXTRA.md', 3, true),
            entry('do-not-report', '.github/SKIP.md', 0, true),
          ],
        },
      ],
    }), undefined)
    const hash = (value: string): string => `sha256:${documentSha256(value)}`
    // Each entry of a field sits where the config wrote it: the documents fill the places the repository entries leave, in order.
    expect(text).toContain([
      '    guidelines:',
      `      - ${hash(first)}`,
      '      - repository: REVIEW.md',
      `      - ${hash(last)}`,
      '      - repository: docs/EXTRA.md',
      '        optional: true',
      '    doNotReport:',
      `      - builtIn: ${hash(base)}`,
      '      - repository: .github/SKIP.md',
      '        optional: true',
      'concurrency: auto',
    ].join('\n'))
    // A profile with a repository entry alone prints it alone, and optional: false prints no optional.
    const alone = printConfig(config({ a: SPEC }, {
      profiles: [
        {
          profile: securityProfile,
          research: 'a',
          voters,
          repository: [
            {
              ...entry('guidelines', 'REVIEW.md', 0),
              optional: false,
            },
          ],
        },
      ],
    }), undefined)
    expect(alone).toContain('    guidelines:\n      - repository: REVIEW.md\nconcurrency: auto\n')
    expect(alone).not.toContain('optional')
    expect(alone).not.toContain('doNotReport')
  })

  it('prints each rule\'s id, a file\'s hash and ids, never a text', () => {
    const planted = 'PLANTED-RULE-TEXT'
    const rule = (id: string, paths?: string[]): ReviewRule => ({
      id,
      text: `${planted} ${id}`,
      ...paths === undefined
        ? {}
        : { paths },
    })
    const document = (rules: ReviewRule[], sha256?: string): ReviewDocument => ({
      profile: 'conventions',
      kind: 'rules',
      origin: sha256 === undefined
        ? { kind: 'config' }
        : { kind: 'config', sha256 },
      rules,
    })
    const read = documentSha256('- id: license\n  text: from the file\n')
    const entry = (path: string, index: number, optional = false): RepositoryEntry => ({
      kind: 'rules',
      path,
      optional,
      at: `profiles.conventions.rules.${index}.repository`,
      index,
    })
    const profile: Profile = {
      ...securityProfile,
      id: 'conventions',
      rules: [
        rule('license'),
        rule('io-errors'),
      ],
      requireRule: true,
      documents: [
        document([
          rule('no-any', ['src/**']),
        ]),
        document([
          rule('shared'),
          rule('naming'),
        ], read),
        document([
          rule('last'),
        ]),
      ],
    }
    const voters = Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, 'a']))
    const print = (fields: Partial<ResolvedConfig['profiles'][number]> & { profile?: Profile }): string => printConfig(config({ a: SPEC }, {
      profiles: [
        {
          profile,
          research: 'a',
          voters,
          repository: [],
          ...fields,
        },
      ],
    }), undefined)
    // Each entry sits where the config wrote it: an inline rule as its id, a file as its hash and the ids it holds, a repository entry as its path; the profile's own rules (the base's) first.
    const text = print({
      repository: [
        entry('.quorum/rules.yaml', 3),
        entry('docs/more.json', 4, true),
      ],
      builtInRules: false,
    })
    expect(text).toContain([
      '    prompts:',
      `      research: sha256:${documentSha256(securityProfile.prompts.research)}`,
      `      vote: sha256:${documentSha256(securityProfile.prompts.vote)}`,
      '    rules:',
      '      - builtIn:',
      '          - license',
      '          - io-errors',
      '      - no-any',
      `      - sha256: ${read}`,
      '        ids:',
      '          - shared',
      '          - naming',
      '      - last',
      '      - repository: .quorum/rules.yaml',
      '      - repository: docs/more.json',
      '        optional: true',
      '    builtInRules: false',
      '    requireRule: true',
      'concurrency: auto',
    ].join('\n'))
    expect(text).not.toContain('PLANTED')
    expect(text).not.toContain('src/**')
    // A profile that requires no rule and keeps the base's prints neither flag; one with no rule prints neither list nor flag, and a repository entry alone prints alone.
    const plain = print({
      profile: { ...profile, requireRule: undefined, documents: undefined },
    })
    expect(plain).toContain('    rules:\n      - builtIn:\n          - license\n          - io-errors\nconcurrency: auto\n')
    expect(plain).not.toContain('requireRule')
    expect(plain).not.toContain('builtInRules')
    const alone = print({
      profile: securityProfile,
      repository: [
        entry('RULES.yaml', 0),
      ],
    })
    expect(alone).toContain('    rules:\n      - repository: RULES.yaml\nconcurrency: auto\n')
    expect(print({ profile: securityProfile })).not.toMatch(/\brules\b|requireRule|builtInRules/)
  })

  it('prints a built-in profile\'s maxFindings, changedLinesOnly and unmeasured, and a profile that extends one unmeasured too', () => {
    const text = printConfig(resolvedConfig({
      providers: { a: SPEC },
      profiles: {
        security: {},
        'code-review': {},
        team: {
          extends: 'best-practices',
          maxFindings: 40,
          changedLinesOnly: false,
          requireRule: false,
          builtInRules: false,
        },
        strict: { extends: 'security', maxFindings: 5, changedLinesOnly: true },
        own: {
          prompts: { research: 'Find style issues.', vote: 'Judge {{lens.id}}: {{lens.question}}' },
          lenses: [
            { id: 'grounded', question: 'Backed by a convention?' },
          ],
        },
      },
    } as ConfigInput), undefined)
    // The lines of one profile: from its key to the next key at the profiles' depth or above.
    const block = (id: string): string => {
      const lines = text.split('\n')
      const from = lines.indexOf(`  ${id}:`)
      const length = lines.slice(from + 1).findIndex(line => /^ {0,2}\S/.test(line))
      return lines.slice(from, from + 1 + length).join('\n')
    }
    expect(block('security')).not.toMatch(/maxFindings|changedLinesOnly|unmeasured/)
    expect(block('code-review')).toMatch(/\n {4}maxFindings: 20\n {4}changedLinesOnly: true\n {4}unmeasured: true$/)
    // The entry's own maxFindings over the base's; changedLinesOnly false is no key; unmeasured follows the base.
    expect(block('team')).toMatch(/\n {4}maxFindings: 40\n {4}unmeasured: true$/)
    expect(block('team')).not.toMatch(/changedLinesOnly|requireRule/)
    // A profile that extends security and sets both prints them, and never unmeasured.
    expect(block('strict')).toMatch(/\n {4}maxFindings: 5\n {4}changedLinesOnly: true$/)
    expect(block('strict')).not.toContain('unmeasured')
    expect(block('own')).not.toMatch(/maxFindings|changedLinesOnly|unmeasured/)
  })

  it('prints unmeasured under a profile whose base is one no labelled set measures, whatever its id', () => {
    const view = (fields: Partial<ResolvedConfig['profiles'][number]>): string => printConfig(config({ a: SPEC }, {
      profiles: [
        {
          profile: { ...securityProfile, id: 'team' },
          research: 'a',
          voters: Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, 'a'])),
          repository: [],
          ...fields,
        },
      ],
    }), undefined)
    expect(view({ base: 'performance' })).toContain('\n    unmeasured: true\nconcurrency: auto\n')
    expect(view({ base: 'security' })).not.toContain('unmeasured')
    expect(view({})).not.toContain('unmeasured')
    expect(view({ base: 'unknown' })).not.toContain('unmeasured')
    // A profile that sets neither field prints neither, a base notwithstanding.
    expect(view({ base: 'performance' })).not.toMatch(/ {4}(maxFindings|changedLinesOnly)/)
  })

  it('prints a config with no document as 0.12.0 did', () => {
    expect(printed(SPEC)).toBe([
      'source: null',
      'providers:',
      '  a:',
      '    protocol: openai-compatible',
      '    origin: https://h.example',
      '    model: m',
      '    contextTokens: 131072',
      'profiles:',
      '  security:',
      '    failOn: high',
      '    research: a',
      '    lenses:',
      '      reachability: a',
      '      impact: a',
      '      defenses: a',
      '    thresholds:',
      '      high: 3',
      '      medium: 2',
      '      low: null',
      '    prompts:',
      `      research: sha256:${createHash('sha256').update(securityProfile.prompts.research).digest('hex')}`,
      `      vote: sha256:${createHash('sha256').update(securityProfile.prompts.vote).digest('hex')}`,
      'concurrency: auto',
      'maxFindings: 50',
      'partTokens: 32768',
      'maxReviewTokens: 2000000',
      'reviewTimeoutMs: 1800000',
      'strict: false',
      'exclude: []',
      'send: []',
      'warnings: []',
      '',
    ].join('\n'))
  })

  it('prints source null when no file was read, and the warnings it lists', () => {
    expect(printed(SPEC).startsWith('source: null\nproviders:\n')).toBe(true)
    const lines = printConfig(config({ a: SPEC }, {
      warnings: ['a: b'],
    }), '/etc/q.yaml').split('\n')
    expect(lines[0]).toBe('source: /etc/q.yaml')
    expect(lines.slice(-3)).toEqual(['warnings:', '  - "a: b"', ''])
  })

  it('prints a system prompt\'s placement, and anything else as the SHA-256 of its text', () => {
    expect(printed({ ...SPEC, systemPrompt: 'inline' })).toContain('\n    systemPrompt: inline\n')
    const text = printed({ ...SPEC, systemPrompt: 'be-SECRET' as never })
    expect(text).toContain(`\n    systemPrompt: sha256:${createHash('sha256').update('be-SECRET').digest('hex')}\n`)
    expect(text).not.toContain('SECRET')
    expect(printed({ ...SPEC, systemPrompt: 7 as never })).toContain('\n    systemPrompt: "[redacted]"\n')
  })

  it('prints a provider\'s context size after its model', () => {
    expect(printed({ ...SPEC, contextTokens: 65536 })).toContain('    model: m\n    contextTokens: 65536\n')
  })

  it('prints thinking when set', () => {
    expect(printed({ ...SPEC, maxTokens: 900, thinking: 'low' })).toContain('    maxTokens: 900\n    thinking: low\n')
    expect(printed({ ...SPEC, thinking: 'off' })).toContain('\n    thinking: "off"\n')
    expect(printed(SPEC)).not.toContain('thinking')
  })

  it('prints a provider\'s timeoutMs and retries after its system prompt when it sets them, and a provider object\'s after its model', () => {
    expect(printed({ ...SPEC, timeoutMs: 120000, retries: 0 })).toContain('    timeoutMs: 120000\n    retries: 0\n')
    expect(printed({
      ...SPEC,
      timeoutMs: 120000,
      stallTimeoutMs: 300000,
      retries: 0,
    })).toContain('    timeoutMs: 120000\n    stallTimeoutMs: 300000\n    retries: 0\n')
    const unset = printed(SPEC)
    expect(unset).not.toContain('timeoutMs')
    expect(unset).not.toContain('stallTimeoutMs')
    expect(unset).not.toContain('retries')
    const complete: Provider['complete'] = async () => ({ text: '', model: 'm' })
    expect(printConfig(config({
      mine: {
        id: 'mine',
        model: 'm',
        complete,
        timeoutMs: 120000,
        retries: 3,
      },
    }), undefined)).toContain('  mine:\n    implements: Provider\n    model: m\n    timeoutMs: 120000\n    retries: 3\nprofiles:\n')
    expect(printConfig(config({
      mine: {
        id: 'mine',
        model: 'm',
        complete,
        stallTimeoutMs: 300000,
      },
    }), undefined)).toContain('  mine:\n    implements: Provider\n    model: m\n    stallTimeoutMs: 300000\nprofiles:\n')
  })

  it('prints the timeoutMs and retries of a provider object that states its own only, and nothing a polluted prototype holds', () => {
    const proto = Object.prototype as Record<string, unknown>
    proto.timeoutMs = 4242
    proto.retries = 4
    try {
      const complete: Provider['complete'] = async () => ({ text: '', model: 'm' })
      const text = printConfig(config({
        mine: { id: 'mine', model: 'm', complete },
      }), undefined)
      expect(text).toContain('  mine:\n    implements: Provider\n    model: m\nprofiles:\n')
      expect(text).not.toContain('4242')
    } finally {
      delete proto.timeoutMs
      delete proto.retries
    }
  })

  it('prints no room a provider object states', () => {
    const complete: Provider['complete'] = async () => ({ text: '', model: 'm' })
    const text = printConfig(config({
      mine: {
        id: 'mine',
        model: 'm',
        complete,
        room: () => 123456,
      },
    }), undefined)
    expect(text).toContain('  mine:\n    implements: Provider\n    model: m\nprofiles:\n')
    expect(text).not.toContain('room')
    expect(text).not.toContain('123456')
  })

  it('prints a provider\'s own fields only, and nothing a polluted prototype holds', () => {
    const proto = Object.prototype as Record<string, unknown>
    proto.headers = { 'x-polluted': 'SECRET' }
    proto.model = 'polluted-model'
    try {
      const text = printed({ protocol: 'openai-compatible', baseUrl: 'https://h.example/v1' } as ResolvedProvider)
      expect(text).not.toContain('headers')
      expect(text).not.toContain('polluted')
    } finally {
      delete proto.headers
      delete proto.model
    }
  })

  /** The budgets of the built-in profile on one provider at a window of 8192, its figures computed from the real prompts: the rooms, the worst part and the lenses' rooms (1602) alike. */
  const BUDGETS: Readonly<Record<string, ProfileBudgets>> = {
    security: {
      research: {
        provider: 'a',
        window: 8192,
        replyTokens: 2048,
        findings: 3,
        findingsWithoutThinking: 7,
        maxFindings: 50,
        rooms: { one: 3841, part: 3529 },
        worstPart: { tokens: 8192, holds: 244 },
      },
      lenses: {
        reachability: {
          provider: 'a',
          window: 8192,
          replyTokens: 2048,
          room: 1602,
        },
        impact: {
          provider: 'a',
          window: 8192,
          replyTokens: 2048,
          room: 1602,
        },
      },
    },
  }

  it('prints the budgets of each profile', () => {
    const text = printConfig(config({ a: SPEC }), undefined, BUDGETS)
    expect(text).toContain([
      'budgets:',
      '  security:',
      '    research:',
      '      provider: a',
      '      contextTokens: 8192',
      '      replyTokens: 2048',
      '      findings: 3',
      '      findingsWithoutThinking: 7',
      '      rooms:',
      '        one: 3841',
      '        part: 3529',
      '      worstPart:',
      '        tokens: 8192',
      '        holds: 244',
      '    lenses:',
      '      reachability:',
      '        provider: a',
      '        contextTokens: 8192',
      '        replyTokens: 2048',
      '        room: 1602',
      '      impact:',
      '        provider: a',
      '        contextTokens: 8192',
      '        replyTokens: 2048',
      '        room: 1602',
      'concurrency: auto',
      '',
    ].join('\n'))
    // They follow the profiles, and a call without them prints none.
    expect(text.indexOf('\nbudgets:\n')).toBeGreaterThan(text.indexOf('\nprofiles:\n'))
    expect(printed(SPEC)).not.toContain('budgets')
    expect(text).toContain('\nwarnings: []\n')
  })

  it('warns at 19 parts the token cap holds, and at 20 does not', () => {
    const holding = (holds: number): string => printConfig(config({ a: SPEC }, { maxReviewTokens: 2_000_000 }), undefined, {
      security: {
        ...BUDGETS.security,
        research: {
          ...BUDGETS.security.research,
          worstPart: { tokens: 100_000, holds },
        },
      },
    })
    expect(holding(19)).toContain('\nwarnings:\n  - "the token cap of 2000000 holds the worst case of 19 research parts of a (100000 tokens each): lower maxTokens, or raise maxReviewTokens"\n')
    expect(holding(20)).toContain('\nwarnings: []\n')
  })

  it('warns when the token cap holds the worst case of fewer than 20 parts', () => {
    const small = {
      ...BUDGETS.security.research,
      worstPart: { tokens: 120_000, holds: 16 },
    }
    const budgets = {
      security: { ...BUDGETS.security, research: small },
    }
    const lines = (spec: ResolvedProvider): string[] => printConfig(config({ a: spec }, { maxReviewTokens: 2_000_000 }), undefined, budgets).split('\n')
    expect(lines(SPEC).slice(-3)).toEqual([
      'warnings:',
      '  - "the token cap of 2000000 holds the worst case of 16 research parts of a (120000 tokens each): lower maxTokens, or raise maxReviewTokens"',
      '',
    ])
    expect(lines({ ...SPEC, maxTokens: 100_000 }).slice(-2)[0]).toBe('  - "the token cap of 2000000 holds the worst case of 16 research parts of a (120000 tokens each, maxTokens 100000): lower maxTokens, or raise maxReviewTokens"')
    // A provider object's stated maxTokens is the one the warning advises lowering.
    const object = {
      id: 'a',
      model: 'm',
      complete: async () => ({ text: '', model: 'm' }),
      maxTokens: 90_000,
    } satisfies Provider
    expect(lines(object).slice(-2)[0]).toBe('  - "the token cap of 2000000 holds the worst case of 16 research parts of a (120000 tokens each, maxTokens 90000): lower maxTokens, or raise maxReviewTokens"')
    // 20 parts is enough, and the config's own warnings come first.
    expect(printConfig(config({ a: SPEC }), undefined, BUDGETS)).toContain('\nwarnings: []\n')
    expect(printConfig(config({ a: SPEC }, {
      warnings: ['a: b'],
    }), undefined, budgets).split('\n').slice(-4, -2)).toEqual(['warnings:', '  - "a: b"'])
  })
})
