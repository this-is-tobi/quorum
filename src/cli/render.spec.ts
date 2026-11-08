import { describe, expect, it } from 'vitest'
import { renderEvent } from './render.ts'

describe('renderEvent', () => {
  it('turns the events a person follows into progress lines', () => {
    expect(renderEvent({ type: 'stage:end', profile: 'security', stage: 'dedup', durationMs: 1, count: 2 })).toBe('2 candidate(s) after dedup')
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'missing.js:1 is not in the diff' })).toBe('invalid finding dropped: missing.js:1 is not in the diff')
    expect(renderEvent({ type: 'incomplete', entry: { profile: 'security', reason: 'research-unusable', detail: '1 finding(s) reported, none usable' } })).toBe('incomplete: research-unusable (1 finding(s) reported, none usable)')
    expect(renderEvent({ type: 'run:end', kept: 1, discarded: 2, unreviewed: 3, incomplete: 0, durationMs: 5 })).toBe('1 kept, 2 discarded, 3 unreviewed by panel')
  })

  it('prints nothing for the other events', () => {
    expect(renderEvent({ type: 'stage:end', profile: 'security', stage: 'research', durationMs: 1, count: 2 })).toBeUndefined()
    expect(renderEvent({ type: 'stage:start', profile: 'security', stage: 'panel' })).toBeUndefined()
    expect(renderEvent({ type: 'vote', profile: 'security', findingId: 'f', lens: 'impact', keep: null, error: 'endpoint down' })).toBeUndefined()
    expect(renderEvent({ type: 'verdict', profile: 'security', findingId: 'f', keptVotes: 3, totalVotes: 3, confidence: 'high', status: 'kept' })).toBeUndefined()
  })
})
