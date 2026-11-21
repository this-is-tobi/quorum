import { describe, expect, it } from 'vitest'
import { ConfigError } from '../../core/errors.ts'
import type { ReportView } from '../../report/view.ts'
import { progressMode } from './progress.ts'
import type { ProgressMode } from './progress.ts'

interface Given {
  readonly flag?: readonly string[]
  readonly env?: Record<string, string>
  readonly terminal?: boolean
  readonly view?: ReportView
}

const choose = ({ flag, env = {}, terminal = false, view = 'full' }: Given): ProgressMode => progressMode({ flag, env, terminal, view })

describe('progressMode', () => {
  it.each<[ProgressMode, string, Given]>([
    // A blank QUORUM_PROGRESS is unset.
    [
      'live',
      'auto on a terminal with TERM=xterm-256color',
      {
        flag: ['auto'],
        env: { TERM: 'xterm-256color', QUORUM_PROGRESS: ' ' },
        terminal: true,
      },
    ],
    [
      'plain',
      'auto with CI=true',
      {
        flag: ['auto'],
        env: { CI: 'true', TERM: 'xterm' },
        terminal: true,
      },
    ],
    [
      'live',
      'auto with CI= empty',
      {
        flag: ['auto'],
        env: { CI: '', TERM: 'xterm' },
        terminal: true,
      },
    ],
    [
      'plain',
      'auto with TERM=dumb',
      {
        flag: ['auto'],
        env: { TERM: ' dumb ' },
        terminal: true,
      },
    ],
    [
      'plain',
      'auto off a terminal',
      {
        flag: ['auto'],
        env: { TERM: 'xterm' },
        terminal: false,
      },
    ],
    [
      'plain',
      'plain on a terminal',
      {
        flag: ['plain'],
        env: { TERM: 'xterm' },
        terminal: true,
      },
    ],
    [
      'json',
      'json',
      {
        flag: ['json'],
      },
    ],
    [
      'none',
      'none',
      {
        flag: ['none'],
        terminal: true,
      },
    ],
    [
      'plain',
      'QUORUM_PROGRESS=plain on a terminal',
      {
        env: { QUORUM_PROGRESS: ' plain ', TERM: 'xterm' },
        terminal: true,
      },
    ],
    [
      'live',
      '--progress live over QUORUM_PROGRESS=plain',
      {
        flag: ['live'],
        env: { QUORUM_PROGRESS: 'plain', CI: 'true' },
        terminal: true,
      },
    ],
  ])('chooses %s for %s', (mode, _name, given) => {
    expect(choose(given)).toBe(mode)
  })

  it.each<[string, Given, string]>([
    [
      '--progress fancy',
      {
        flag: ['fancy'],
        terminal: true,
      },
      '--progress: must be auto, live, plain, json or none',
    ],
    [
      'QUORUM_PROGRESS=fancy',
      {
        env: { QUORUM_PROGRESS: 'fancy' },
        terminal: true,
      },
      'QUORUM_PROGRESS: must be auto, live, plain, json or none',
    ],
    [
      '--progress live off a terminal',
      {
        flag: ['live'],
        terminal: false,
      },
      '--progress: live needs stderr to be a terminal: use plain',
    ],
    [
      '--progress json with --view public',
      {
        flag: ['json'],
        view: 'public',
      },
      '--progress: json writes the library\'s events, which hold usage and server text: it cannot be given with --view public',
    ],
    [
      '--progress given twice',
      {
        flag: ['plain', 'live'],
        terminal: true,
      },
      '--progress: takes one mode',
    ],
  ])('refuses %s', (_name, given, message) => {
    expect(() => choose(given)).toThrow(ConfigError)
    expect(() => choose(given)).toThrow(message)
  })
})
