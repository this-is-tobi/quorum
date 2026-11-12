import { afterEach, describe, expect, it, vi } from 'vitest'
import { isolateEnv } from './env.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isolateEnv', () => {
  it('blanks the variables the config layer reads, a preset\'s key and any QUORUM_ name, then sets the values it is given', () => {
    const hostValues = [
      'OPENAI_API_KEY',
      'QUORUM_RESEARCH_MODEL',
      'RESEARCH_API_KEY',
      'QUORUM_NOT_IN_ANY_LIST',
    ]
    for (const name of hostValues) vi.stubEnv(name, 'host-value')

    isolateEnv()
    for (const name of hostValues) expect(process.env[name], name).toBe('')

    isolateEnv({ QUORUM_RESEARCH_MODEL: 'm' })
    expect(process.env.QUORUM_RESEARCH_MODEL).toBe('m')
    for (const name of hostValues.filter(name => name !== 'QUORUM_RESEARCH_MODEL')) expect(process.env[name], name).toBe('')
  })
})
