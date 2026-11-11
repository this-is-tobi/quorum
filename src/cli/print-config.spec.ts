import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import type { Provider } from '../core/ports.ts'
import { securityProfile } from '../profiles/security.ts'
import { printConfig } from './print-config.ts'

const SPEC = { protocol: 'openai-compatible', baseUrl: 'https://h.example/v1', model: 'm' } as const

/** A config with the built-in profile, every role of it bound to the first of `providers`. */
function config(providers: Record<string, ResolvedProvider>, rest: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const [name] = Object.keys(providers)
  const voters = Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, name]))
  return { providers, profiles: [{ profile: securityProfile, research: name, voters }], warnings: [], ...rest } satisfies ResolvedConfig
}

/** The text printed for one provider spec. */
const printed = (spec: ResolvedProvider): string => printConfig(config({ a: spec }), undefined)

describe('printConfig', () => {
  it('prints a provider object by its name and model, never its function', () => {
    const complete: Provider['complete'] = async () => ({ text: '', model: 'm' })
    const named = printConfig(config({ mine: { id: 'mine', model: 'm', complete } }), undefined)
    expect(named).toContain('  mine:\n    implements: Provider\n    model: m\nprofiles:\n')
    expect(named).not.toContain('complete')
    expect(named).not.toContain('=>')
    const unnamed = printConfig(config({ mine: { id: 'mine', model: 7 as never, complete } }), undefined)
    expect(unnamed).toContain('  mine:\n    implements: Provider\nprofiles:\n')
  })

  it('breaks a workflow command a key would start', () => {
    const text = printed({ ...SPEC, extraBody: { '::error::x': 'value' } })
    expect(text).toContain('\n      <U+003A>:error::x: "[redacted]"\n')
    expect(text).not.toContain('\n      ::')
    expect(text).not.toContain('value')
  })

  it('keeps a value that holds a newline, then a workflow command, inert on every line', () => {
    const hostile = 'a\n::error::forged\n##[group]forged'
    const text = printConfig(config({ a: { ...SPEC, model: hostile } }, { warnings: [hostile] }), `/work/${hostile}.yaml`)
    expect(text).not.toMatch(/^\s*::/m)
    expect(text).not.toContain('##[')
    expect(text).toContain('<U+003A>:error::forged')
    expect(text).toContain('##<U+005B>group]forged')
  })

  it('prints the values the review applies when the config sets none', () => {
    expect(printed(SPEC)).toContain('\nconcurrency: 4\nmaxFindings: 50\nwarnings: []\n')
    expect(printConfig(config({ a: SPEC }, { concurrency: 2, maxFindings: 5 }), undefined)).toContain('\nconcurrency: 2\nmaxFindings: 5\n')
  })

  it('prints source null when no file was read, and the warnings it lists', () => {
    expect(printed(SPEC).startsWith('source: null\nproviders:\n')).toBe(true)
    const lines = printConfig(config({ a: SPEC }, { warnings: ['a: b'] }), '/etc/q.yaml').split('\n')
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
})
