import type { ChildProcess } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }

/** The real entry point, run under Node, which strips its types: what only a process shows is checked here. */
const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url))
const DIFF = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-safe()\n+exec(cmd)\n'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-bin-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The options of every spawn: the temporary directory, and nothing of this process's environment but `PATH`. */
function spawnOptions(env: Record<string, string>): { cwd: string, env: Record<string, string> } {
  return { cwd: dir, env: { PATH: process.env.PATH ?? '', ...env } }
}

/** Run the binary to its end with stdin closed. */
function run(args: string[], env: Record<string, string>): { status: number | null, stdout: string, stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [BIN, ...args], {
    ...spawnOptions(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  return { status, stdout, stderr }
}

/** Start the binary with stdin closed: the child, what it has written so far, and its exit code once it ends. */
function start(args: string[], env: Record<string, string>): { child: ChildProcess, stdout: () => string, stderr: () => string, exited: Promise<number | null> } {
  const child = spawn(process.execPath, [BIN, ...args], { ...spawnOptions(env), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout?.setEncoding('utf8').on('data', (text: string) => out += text)
  child.stderr?.setEncoding('utf8').on('data', (text: string) => err += text)
  const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)))
  return { child, stdout: () => out, stderr: () => err, exited }
}

describe('bin', () => {
  it('exits with the code of the run, and writes its result', () => {
    const { status, stdout, stderr } = run([], { QUORUM_RESEARCH_MODEL: 'm' })
    expect(status).toBe(0)
    expect(JSON.parse(stdout).kept).toEqual([])
    expect(stderr.endsWith('0 kept, 0 discarded, 0 unreviewed by panel\n')).toBe(true)
  })

  it('prints the version', () => {
    const { status, stdout } = run(['--version'], {})
    expect(status).toBe(0)
    expect(stdout).toBe(`quorum ${packageJson.version}\n`)
  })

  it('exits 3, never 0, when the run stops with nothing left to wait for', () => {
    writeFileSync(join(dir, 'hang.mjs'), 'export default { providers: { mine: { model: \'m\', complete: () => new Promise(() => {}) } } }\n')
    writeFileSync(join(dir, 'x.diff'), DIFF)
    const { status, stdout, stderr } = run(['x.diff'], { QUORUM_CONFIG: 'hang.mjs' })
    expect(status).toBe(3)
    expect(stdout).toBe('')
    expect(stderr).toContain('Research (m @ the provider object mine)...\n')
    expect(stderr.endsWith('Error: the run stopped without a result\n')).toBe(true)
  })

  it('exits 130 on SIGTERM, and writes no result', async () => {
    writeFileSync(join(dir, 'slow.mjs'), `export default { providers: { mine: { model: 'm', complete: ({ signal }) => new Promise((_resolve, reject) => {
  const timer = setTimeout(() => {}, 60_000)
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) })
}) } } }\n`)
    writeFileSync(join(dir, 'x.diff'), DIFF)
    const { child, stdout, stderr, exited } = start(['x.diff'], { QUORUM_CONFIG: 'slow.mjs' })
    try {
      await vi.waitFor(() => expect(stderr()).toContain('Research ('), { timeout: 10_000 })
      child.kill('SIGTERM')
      expect(await exited).toBe(130)
      expect(stdout()).toBe('')
      expect(stderr().endsWith('interrupted\n')).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  }, 15_000)

  it('exits 130 at once on a second SIGINT, while a provider ignores the first', async () => {
    writeFileSync(join(dir, 'stuck.mjs'), 'export default { providers: { mine: { model: \'m\', complete: () => new Promise(resolve => setTimeout(resolve, 60_000)) } } }\n')
    writeFileSync(join(dir, 'x.diff'), DIFF)
    const { child, stderr, exited } = start(['x.diff'], { QUORUM_CONFIG: 'stuck.mjs' })
    try {
      await vi.waitFor(() => expect(stderr()).toContain('Research ('), { timeout: 10_000 })
      child.kill('SIGINT')
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(child.exitCode).toBeNull()
      child.kill('SIGINT')
      expect(await exited).toBe(130)
    } finally {
      child.kill('SIGKILL')
    }
  }, 15_000)
})
