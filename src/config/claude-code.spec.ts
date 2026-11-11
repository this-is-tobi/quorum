import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { billingWarnings, CLAUDE_NOT_FOUND, claudeCodeCommand, findCommand } from './claude-code.ts'

/** A directory of its own, made when the file loads and removed after the last test. */
const dir = mkdtempSync(join(tmpdir(), 'quorum-find-'))
const bin = join(dir, 'bin')
const win = join(dir, 'win')
mkdirSync(bin)
mkdirSync(win)
writeFileSync(join(bin, 'claude'), '#!/bin/sh\n')
chmodSync(join(bin, 'claude'), 0o755)
writeFileSync(join(bin, 'plain'), '#!/bin/sh\n')
chmodSync(join(bin, 'plain'), 0o644)
mkdirSync(join(bin, 'folder'))
writeFileSync(join(win, 'claude.exe'), '')
chmodSync(join(win, 'claude.exe'), 0o644)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('findCommand', () => {
  it('finds a name in the first absolute PATH entry that holds it as an executable file', () => {
    expect(findCommand('claude', { PATH: [join(dir, 'none'), win, bin].join(':') }, 'linux')).toBe(join(bin, 'claude'))
  })

  it('skips a file that is not executable, a directory, and every relative PATH entry', () => {
    expect(findCommand('plain', { PATH: bin }, 'linux')).toBeUndefined()
    expect(findCommand('folder', { PATH: bin }, 'linux')).toBeUndefined()
    const node = basename(process.execPath)
    expect(findCommand(node, { PATH: dirname(process.execPath) }, 'linux')).toBe(process.execPath)
    expect(findCommand(node, { PATH: `${relative(process.cwd(), dirname(process.execPath))}::.` }, 'linux')).toBeUndefined()
  })

  it('checks an absolute command as it is', () => {
    expect(findCommand(join(bin, 'claude'), {}, 'linux')).toBe(join(bin, 'claude'))
    expect(findCommand(join(bin, 'plain'), { PATH: bin }, 'linux')).toBeUndefined()
    expect(findCommand(join(dir, 'missing'), {}, 'linux')).toBeUndefined()
  })

  it('finds the .exe of a name on Windows, where no file has an execute bit', () => {
    expect(findCommand('claude', { PATH: win }, 'win32')).toBe(join(win, 'claude.exe'))
  })

  it('refuses a name with a separator that is not an absolute path, and a Windows script, itself', () => {
    writeFileSync(join(bin, 'claude.cmd'), '#!/bin/sh\n')
    chmodSync(join(bin, 'claude.cmd'), 0o755)
    // Each of these exists under an absolute PATH entry, once joined to it.
    expect(findCommand('bin/claude', { PATH: dir }, 'linux')).toBe(undefined)
    expect(findCommand('../bin/claude', { PATH: bin }, 'linux')).toBe(undefined)
    expect(findCommand('claude.cmd', { PATH: bin }, 'linux')).toBe(undefined)
    expect(findCommand('claude', { PATH: bin }, 'linux')).toBe(join(bin, 'claude'))
  })

  it('finds no name without PATH', () => {
    expect(findCommand('claude', {}, 'linux')).toBeUndefined()
  })

  it('splits PATH on a semicolon on Windows, and reads the variable in any letter case there', () => {
    expect(findCommand('claude', { Path: `${join(dir, 'none')};${win}` }, 'win32')).toBe(join(win, 'claude.exe'))
    expect(findCommand('claude', { Path: win }, 'linux')).toBeUndefined()
  })

  it('reads only the environment\'s own PATH, never one its prototype holds', () => {
    expect(findCommand('claude', Object.create({ PATH: bin }) as Record<string, string>, 'linux')).toBeUndefined()
  })
})

describe('claudeCodeCommand', () => {
  const settings = (command?: string): Parameters<typeof claudeCodeCommand>[1] => ({ protocol: 'claude-code', model: 'sonnet', contextTokens: 1000000, ...command === undefined ? {} : { command } })
  const onPath = { PATH: bin }

  it('takes the variable over the settings\' command, and that over claude on PATH', () => {
    expect(claudeCodeCommand('cc', settings(join(win, 'claude.exe')), join(bin, 'claude'), onPath)).toEqual({ command: join(bin, 'claude'), issues: [] })
    expect(claudeCodeCommand('cc', settings(join(bin, 'plain')), undefined, onPath)).toEqual({ issues: [{ path: 'providers.cc.command', message: 'names no executable file' }] })
    expect(claudeCodeCommand('cc', settings(), undefined, onPath)).toEqual({ command: join(bin, 'claude'), issues: [] })
  })

  it('finds a bare name of the settings on PATH', () => {
    expect(claudeCodeCommand('cc', settings('claude'), undefined, onPath)).toEqual({ command: join(bin, 'claude'), issues: [] })
  })

  it('names where a missing command came from, and holds no path or value', () => {
    expect(claudeCodeCommand('cc', settings(), undefined, {})).toEqual({ issues: [{ path: 'providers.cc', message: CLAUDE_NOT_FOUND }] })
    expect(claudeCodeCommand('cc', settings(), join(dir, 'secret-path', 'claude'), onPath)).toEqual({ issues: [{ path: 'QUORUM_CLAUDE_CODE_COMMAND', message: 'names no executable file' }] })
    expect(claudeCodeCommand('cc', settings(join(dir, 'secret-path', 'claude')), undefined, onPath)).toEqual({ issues: [{ path: 'providers.cc.command', message: 'names no executable file' }] })
    expect(CLAUDE_NOT_FOUND).toBe('claude CLI not found; install Claude Code or set QUORUM_CLAUDE_CODE_COMMAND')
  })

  it('leaves a settings\' command the adapter refuses to the adapter: no command, no issue', () => {
    expect(claudeCodeCommand('cc', settings('./claude'), undefined, onPath)).toEqual({ issues: [] })
    expect(claudeCodeCommand('cc', settings('claude.cmd'), undefined, onPath)).toEqual({ issues: [] })
  })

  it('does not look the command of settings up when the variable names one', () => {
    expect(claudeCodeCommand('cc', settings('./claude'), join(bin, 'claude'), {})).toEqual({ command: join(bin, 'claude'), issues: [] })
  })
})

describe('billingWarnings', () => {
  const WARNING = 'providers.cc: ANTHROPIC_API_KEY is set, so Claude Code bills that key rather than its login: unset it, or set auth to login or api-key'
  const settings = (auth?: 'inherit' | 'login' | 'api-key'): Parameters<typeof billingWarnings>[1] => ({ protocol: 'claude-code', model: 'sonnet', contextTokens: 1000000, ...auth === undefined ? {} : { auth } })

  it('warns under inherit, set or not, when ANTHROPIC_API_KEY is set', () => {
    expect(billingWarnings('cc', settings(), { ANTHROPIC_API_KEY: 'sk-k' })).toEqual([WARNING])
    expect(billingWarnings('cc', settings('inherit'), { ANTHROPIC_API_KEY: 'sk-k' })).toEqual([WARNING])
  })

  it('never prints the key', () => {
    expect(billingWarnings('cc', settings(), { ANTHROPIC_API_KEY: 'sk-SECRET' }).join('\n')).not.toContain('SECRET')
  })

  it('does not warn without a key, with a blank one, or under login or api-key', () => {
    expect(billingWarnings('cc', settings(), {})).toEqual([])
    expect(billingWarnings('cc', settings(), { ANTHROPIC_API_KEY: ' ' })).toEqual([])
    expect(billingWarnings('cc', settings('login'), { ANTHROPIC_API_KEY: 'sk-k' })).toEqual([])
    expect(billingWarnings('cc', settings('api-key'), { ANTHROPIC_API_KEY: 'sk-k' })).toEqual([])
  })
})
