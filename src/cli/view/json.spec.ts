import { describe, expect, it } from 'vitest'
import type { QuorumEvent } from '../../core/types.ts'
import { reportResult } from '../../testing/report.ts'
import { DEFAULT_FACTS } from './model.ts'
import { jsonWriter, quietWriter } from './json.ts'
import type { LineLevel } from './writer.ts'

const ESC = String.fromCharCode(0x1B)
const OVERRIDE = String.fromCharCode(0x202E)
/** Every hidden class the sanitizer knows, a line feed included, since a line holds none. */
const ANY_HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u

const LEVELS: LineLevel[] = [
  'warning',
  'banner',
  'estimate',
  'notice',
  'error',
]

describe('jsonWriter', () => {
  it('writes each event as one line that JSON.parse reads back, its hidden characters escaped', () => {
    const lines: string[] = []
    const { sink } = jsonWriter(line => lines.push(line))
    const events: QuorumEvent[] = [
      {
        type: 'run:start',
        profiles: [`sec${ESC}[31m${OVERRIDE}\nurity`],
        providers: {},
      },
      {
        type: 'stage:start',
        profile: 'security',
        stage: 'research',
        parts: 44,
      },
      {
        type: 'part',
        profile: 'security',
        part: { index: 1, count: 44 },
        outcome: 'reviewed',
        durationMs: 1000,
        spent: 100,
        listed: 1,
      },
      {
        type: 'run:end',
        kept: 1,
        discarded: 0,
        unreviewed: 0,
        incomplete: 0,
        durationMs: 1,
      },
    ]
    for (const event of events) sink(event)
    expect(lines).toHaveLength(4)
    for (const [index, line] of lines.entries()) {
      expect(line).not.toMatch(ANY_HIDDEN)
      expect(JSON.parse(line)).toEqual(events[index])
    }
    // The escape and the override are in the line as text, and the line feed as an escape.
    expect(lines[0]).toContain('\\u001b[31m\\u202e\\nurity')
  })

  it('writes each line of the CLI as a cli:line of its level', () => {
    const lines: string[] = []
    const writer = jsonWriter(line => lines.push(line))
    for (const level of LEVELS) writer.line(level, `a ${level} line`)
    writer.line('error', `Error: bad${ESC}[2Jname${OVERRIDE}`)
    expect(lines.map(line => JSON.parse(line))).toEqual([
      ...LEVELS.map(level => ({ type: 'cli:line', level, text: `a ${level} line` })),
      // The text is the inert line: the escape and the override are shown, never written.
      { type: 'cli:line', level: 'error', text: 'Error: bad<U+001B>[2Jname<U+202E>' },
    ])
    for (const line of lines) expect(line).not.toMatch(ANY_HIDDEN)
  })

  it('writes no summary and nothing else', async () => {
    const lines: string[] = []
    const writer = jsonWriter(line => lines.push(line))
    writer.begin(DEFAULT_FACTS)
    writer.sink({
      type: 'stage:start',
      profile: 'security',
      stage: 'research',
      parts: 1,
    })
    const before = lines.length
    writer.summary({
      stdout: { format: 'json', terminal: false },
      stderr: { terminal: false },
      outputs: [],
      result: reportResult({}),
    })
    await writer.close()
    writer.restore()
    expect(lines).toHaveLength(before)

    // The quiet mode writes the warnings and the errors, as plain text, and nothing else.
    const quiet: string[] = []
    const none = quietWriter(line => quiet.push(line))
    none.begin(DEFAULT_FACTS)
    none.sink({
      type: 'stage:start',
      profile: 'security',
      stage: 'research',
      parts: 1,
    })
    for (const level of LEVELS) none.line(level, `a ${level} line${ESC}`)
    none.summary({
      stdout: { format: 'json', terminal: false },
      stderr: { terminal: false },
      outputs: [],
      result: reportResult({}),
    })
    await none.close()
    none.restore()
    expect(quiet).toEqual(['a warning line<U+001B>', 'a error line<U+001B>'])
  })
})
