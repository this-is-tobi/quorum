import { describe, expect, it } from 'vitest'
import { failureFacts, providerFailure } from './facts.ts'

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

  it('reads a timeout\'s ceilingMs as own data, a positive safe integer, and no other kind\'s', () => {
    expect(providerFailure(failure({ kind: 'timeout', ceilingMs: 10_512_000 }))).toEqual({ kind: 'timeout', ceilingMs: 10_512_000 })
    expect(providerFailure(failure({ kind: 'timeout', ceilingMs: 0 }))).toEqual({ kind: 'timeout' })
    expect(providerFailure(failure({ kind: 'timeout', ceilingMs: 1.5 }))).toEqual({ kind: 'timeout' })
    expect(providerFailure(failure({ kind: 'timeout', ceilingMs: '10512000' }))).toEqual({ kind: 'timeout' })
    expect(providerFailure(failure({ kind: 'timeout', ceilingMs: Number.MAX_SAFE_INTEGER + 1 }))).toEqual({ kind: 'timeout' })
    expect(providerFailure(failure({ kind: 'network', ceilingMs: 10_512_000 }))).toEqual({ kind: 'network' })
    const getter = new Error('x')
    Object.defineProperty(getter, 'kind', { value: 'timeout' })
    Object.defineProperty(getter, 'ceilingMs', {
      get() {
        throw new Error('a getter ran')
      },
    })
    expect(providerFailure(getter)).toEqual({ kind: 'timeout' })
    expect(providerFailure(Object.assign(Object.create({ ceilingMs: 5 }), { kind: 'timeout' }))).toEqual({ kind: 'timeout' })
  })

  it('reads a failure\'s noAnswer as own data, so a getter or an inherited field says nothing', () => {
    expect(failureFacts(failure({ kind: 'no-answer', noAnswer: 'thinking' })).noAnswer).toBe('thinking')
    const getter = new Error('x')
    Object.defineProperty(getter, 'kind', { value: 'no-answer' })
    Object.defineProperty(getter, 'noAnswer', {
      get() {
        throw new Error('a getter ran')
      },
    })
    expect(failureFacts(getter).noAnswer).toBeUndefined()
    expect(failureFacts(Object.assign(Object.create({ noAnswer: 'thinking' }), { kind: 'no-answer' })).noAnswer).toBeUndefined()
  })
})
