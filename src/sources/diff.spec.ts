import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import { diffSource, readDiffInput } from './diff.ts'

const DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-safe()\n+exec(cmd)\n'
const MiB = 1024 * 1024

/** A directory of its own for the diff files of these tests. */
let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-diff-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** What stdin is: its chunks, and whether it is a terminal. */
function stdin(chunks: string[], isTTY = false): AsyncIterable<string> & { isTTY: boolean } {
  async function* read(): AsyncGenerator<string> {
    yield* chunks
  }
  return Object.assign(read(), { isTTY })
}

/** The message of the `ConfigError` a promise rejects with, and its issue's path. */
async function refusal(promise: Promise<unknown>): Promise<{ message: string, paths: string[] }> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ConfigError)
  return {
    message: (error as ConfigError).message,
    paths: (error as ConfigError).issues.map(issue => issue.path),
  }
}

describe('the diff source', () => {
  it('passes a diff\'s text through as the diff source, with nothing left out', () => {
    expect(diffSource(DIFF)).toEqual({
      diff: DIFF,
      source: { kind: 'diff' },
      leftOut: [],
    })
    expect(diffSource('')).toEqual({
      diff: '',
      source: { kind: 'diff' },
      leftOut: [],
    })
  })

  it('refuses a text over 16 MiB of UTF-8, counting each character\'s bytes', () => {
    const wide = String.fromCharCode(0xE9).repeat(8 * MiB + 1)
    expect(wide.length).toBeLessThan(16 * MiB)
    const refused = (): unknown => diffSource(wide)
    expect(refused).toThrow(ConfigError)
    expect(refused).toThrow('the diff is over 16 MiB, the most quorum reads')
    expect(diffSource('a'.repeat(16 * MiB)).diff).toHaveLength(16 * MiB)
  })

  it.for([
    ['does not exist', 'the diff file does not exist'],
    ['is a directory', 'the diff file is a directory'],
    ['cannot be read', 'the diff file cannot be read'],
  ])('says that the diff file %s, never repeating its path', async ([kind, text], { skip }) => {
    // The superuser reads a file of mode 000.
    if (kind === 'cannot be read') skip(process.getuid?.() === 0)
    const name = `secret-${kind.replaceAll(' ', '-')}`
    const path = join(dir, name)
    if (kind === 'is a directory') mkdirSync(path)
    if (kind === 'cannot be read') {
      writeFileSync(path, DIFF)
      chmodSync(path, 0o000)
    }
    const { message, paths } = await refusal(readDiffInput(dir, name, stdin([])))
    expect(message).toBe(text)
    expect(paths).toEqual([''])
    expect(message).not.toContain('secret')
    expect(message).not.toContain(dir)
    const absolute = await refusal(readDiffInput('/elsewhere', path, stdin([])))
    expect(absolute.message).toBe(text)
  })

  it('reads stdin when no file is named, and refuses a terminal with no diff given', async () => {
    await expect(readDiffInput(dir, undefined, stdin(['diff --git a/x b/x\n', DIFF]))).resolves.toBe(`diff --git a/x b/x\n${DIFF}`)
    await expect(readDiffInput(dir, '', stdin([DIFF]))).resolves.toBe(DIFF)
    expect(await refusal(readDiffInput(dir, undefined, stdin([DIFF], true)))).toEqual({
      message: 'no diff given',
      paths: [''],
    })
    // A terminal is no reason to refuse a file: only stdin waits on a person.
    writeFileSync(join(dir, 'named.diff'), DIFF)
    await expect(readDiffInput(dir, 'named.diff', stdin([], true))).resolves.toBe(DIFF)
  })

  it('ends a read at the first abort, destroying the stream it reads, and reads to the end when no abort comes', async () => {
    /** A stream that gives one chunk and then never resolves, with a spy for its `destroy`. */
    function stalled(): AsyncIterable<string> & { destroy: () => void, read: () => number } {
      let chunks = 0
      const destroy = vi.fn()
      async function* read(): AsyncGenerator<string> {
        chunks += 1
        yield DIFF
        await new Promise<never>(() => {})
      }
      return Object.assign(read(), {
        destroy,
        read: () => chunks,
      })
    }
    // An abort after a turn: the read rejects with the signal's reason, and the stream is destroyed once.
    const held = stalled()
    const controller = new AbortController()
    const reading = readDiffInput(dir, undefined, held, controller.signal)
    await Promise.resolve()
    const reason = new Error('the first signal')
    controller.abort(reason)
    await expect(reading).rejects.toBe(reason)
    expect(held.destroy).toHaveBeenCalledTimes(1)
    // A signal aborted already: it rejects with no chunk read.
    const before = stalled()
    const aborted = new AbortController()
    aborted.abort(reason)
    await expect(readDiffInput(dir, undefined, before, aborted.signal)).rejects.toBe(reason)
    expect(before.read()).toBe(0)
    // No abort: a stream that ends gives its text, and nothing is destroyed.
    const ending = Object.assign(stdin([DIFF]), {
      destroy: vi.fn(),
    })
    await expect(readDiffInput(dir, undefined, ending, new AbortController().signal)).resolves.toBe(DIFF)
    expect(ending.destroy).not.toHaveBeenCalled()
  })
})
