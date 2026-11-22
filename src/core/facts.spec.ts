import { describe, expect, it } from 'vitest'
import { providerFailure } from './facts.ts'

const failure = (facts: Record<string, unknown>): Error => Object.assign(new Error('failed'), facts)

describe('providerFailure', () => {
  it('reads a timeout\'s stalledMs as own data, a positive safe integer, and no other kind\'s', () => {
    expect(providerFailure(failure({ kind: 'timeout', stalledMs: 300_000 }))).toEqual({ kind: 'timeout', stalledMs: 300_000 })
    expect(providerFailure(failure({ kind: 'timeout', stalledMs: 0 }))).toEqual({ kind: 'timeout' })
    expect(providerFailure(failure({ kind: 'timeout', stalledMs: 1.5 }))).toEqual({ kind: 'timeout' })
    expect(providerFailure(failure({ kind: 'timeout', stalledMs: '300000' }))).toEqual({ kind: 'timeout' })
    expect(providerFailure(failure({ kind: 'timeout' }))).toEqual({ kind: 'timeout' })
    expect(providerFailure(failure({ kind: 'network', stalledMs: 300_000 }))).toEqual({ kind: 'network' })
    const getter = new Error('x')
    Object.defineProperty(getter, 'kind', { value: 'timeout' })
    Object.defineProperty(getter, 'stalledMs', {
      get() {
        throw new Error('a getter ran')
      },
    })
    expect(providerFailure(getter)).toEqual({ kind: 'timeout' })
    expect(providerFailure(Object.assign(Object.create({ stalledMs: 5 }), { kind: 'timeout' }))).toEqual({ kind: 'timeout' })
  })
})
