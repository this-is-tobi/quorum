import { describe, expect, it } from 'vitest'
import { renderEvent } from './render.ts'

describe('renderEvent', () => {
  it('turns the events a person follows into progress lines', () => {
    expect(renderEvent({ type: 'stage:end', profile: 'security', stage: 'dedup', durationMs: 1, count: 2 })).toBe('2 candidate(s) after dedup')
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'missing.js:1 is not in the diff' })).toBe('invalid finding dropped: missing.js:1 is not in the diff')
    expect(renderEvent({ type: 'incomplete', entry: { profile: 'security', reason: 'research-unusable', detail: '1 finding(s) reported, none usable' } })).toBe('incomplete: research-unusable (1 finding(s) reported, none usable)')
    expect(renderEvent({ type: 'run:end', kept: 1, discarded: 2, unreviewed: 3, incomplete: 0, durationMs: 5 })).toBe('1 kept, 2 discarded, 3 unreviewed by panel')
  })

  it('renders a flag with where it points', () => {
    expect(renderEvent({ type: 'flag', flag: { code: 'hidden-characters', file: 'src/a.js', line: 3, detail: 'U+202E on 1 added line(s)' } })).toBe('flag: hidden-characters at "src/a.js":3 (U+202E on 1 added line(s))')
    expect(renderEvent({ type: 'flag', flag: { code: 'hidden-characters', file: 'src/\u202Egnp.js', detail: 'the file name holds U+202E' } })).toBe('flag: hidden-characters at "src/<U+202E>gnp.js" (the file name holds U+202E)')
    expect(renderEvent({ type: 'flag', flag: { code: 'ai-addressed-text', line: 2, detail: 'a tool-call tag on 1 added line(s)' } })).toBe('flag: ai-addressed-text at line 2 (a tool-call tag on 1 added line(s))')
    expect(renderEvent({ type: 'flag', flag: { code: 'hidden-characters', file: 'a\nb.js', detail: 'the file name holds U+000A' } })).toBe('flag: hidden-characters at "a\\nb.js" (the file name holds U+000A)')
  })

  it('renders the text a line carries inert', () => {
    expect(renderEvent({ type: 'finding:invalid', profile: 'security', reason: 'a\u001B[2J.js:1 is not in the diff' })).toBe('invalid finding dropped: a<U+001B>[2J.js:1 is not in the diff')
    expect(renderEvent({ type: 'incomplete', entry: { profile: 'security', reason: 'vote-failed', file: 'a\u202E.js', detail: '"a\u202E.js":1 is kept at medium, but 1 failed vote(s) could have made it high' } })).toBe('incomplete: vote-failed ("a<U+202E>.js":1 is kept at medium, but 1 failed vote(s) could have made it high)')
    expect(renderEvent({ type: 'incomplete', entry: { profile: 'security', reason: 'finding-unreadable', detail: 'findings[0]: x\n::error::y' } })).toBe('incomplete: finding-unreadable (findings[0]: x<U+000A>::error::y)')
  })

  it('prints nothing for the other events', () => {
    expect(renderEvent({ type: 'stage:end', profile: 'security', stage: 'research', durationMs: 1, count: 2 })).toBeUndefined()
    expect(renderEvent({ type: 'stage:start', profile: 'security', stage: 'panel' })).toBeUndefined()
    expect(renderEvent({ type: 'vote', profile: 'security', findingId: 'f', lens: 'impact', keep: null, error: 'endpoint down' })).toBeUndefined()
    expect(renderEvent({ type: 'verdict', profile: 'security', findingId: 'f', keptVotes: 3, totalVotes: 3, confidence: 'high', status: 'kept' })).toBeUndefined()
  })
})
