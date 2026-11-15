import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findExecutable } from './command.ts'

/** A directory of its own, made when the file loads and removed after the last test. */
const dir = mkdtempSync(join(tmpdir(), 'quorum-executable-'))
const first = join(dir, 'first')
const second = join(dir, 'second')
const win = join(dir, 'win')
mkdirSync(first)
mkdirSync(second)
mkdirSync(win)
writeFileSync(join(first, 'tool'), '#!/bin/sh\n')
chmodSync(join(first, 'tool'), 0o755)
writeFileSync(join(second, 'tool'), '#!/bin/sh\n')
chmodSync(join(second, 'tool'), 0o755)
writeFileSync(join(first, 'plain'), '#!/bin/sh\n')
chmodSync(join(first, 'plain'), 0o644)
mkdirSync(join(first, 'folder'))
writeFileSync(join(win, 'tool.exe'), '')
chmodSync(join(win, 'tool.exe'), 0o644)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('findExecutable', () => {
  it('finds a bare name in the first absolute entry of PATH that holds an executable file of that name', () => {
    expect(findExecutable('tool', {
      PATH: [
        join(dir, 'none'),
        second,
        first,
      ].join(':'),
    }, 'linux')).toBe(join(second, 'tool'))
    expect(findExecutable('tool', {
      PATH: [first, second].join(':'),
    }, 'linux')).toBe(join(first, 'tool'))
  })

  it('skips relative and empty entries, a directory of that name and a file that is not executable', () => {
    expect(findExecutable('tool', { PATH: `::.:first:${second}` }, 'linux')).toBe(join(second, 'tool'))
    expect(findExecutable('folder', { PATH: first }, 'linux')).toBeUndefined()
    expect(findExecutable('plain', { PATH: first }, 'linux')).toBeUndefined()
    expect(findExecutable('tool', {}, 'linux')).toBeUndefined()
  })

  it('takes an absolute command as it is when it is an executable file, and finds nothing for one that is not', () => {
    expect(findExecutable(join(first, 'tool'), {}, 'linux')).toBe(join(first, 'tool'))
    expect(findExecutable(join(first, 'plain'), { PATH: first }, 'linux')).toBeUndefined()
    expect(findExecutable(join(first, 'folder'), { PATH: first }, 'linux')).toBeUndefined()
    expect(findExecutable(join(dir, 'missing'), {}, 'linux')).toBeUndefined()
  })

  it('splits PATH at ; and looks up name.exe on Windows', () => {
    expect(findExecutable('tool', { Path: `${join(dir, 'none')};${win}` }, 'win32')).toBe(join(win, 'tool.exe'))
    expect(findExecutable('tool', { PATH: `${first};${second}` }, 'linux')).toBeUndefined()
    expect(findExecutable('tool', { PATH: `${first};${second}` }, 'win32')).toBeUndefined()
  })
})
