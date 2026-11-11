import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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

/** Run the binary in the temporary directory with stdin closed, and nothing of this process's environment but `PATH`. */
function run(args: string[], env: Record<string, string>): { status: number | null, stdout: string, stderr: string } {
  const { status, stdout, stderr } = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  return { status, stdout, stderr }
}

describe('bin', () => {
  it('exits with the code of the run, and writes its result', () => {
    const { status, stdout, stderr } = run([], { QUORUM_RESEARCH_MODEL: 'm' })
    expect(status).toBe(0)
    expect(JSON.parse(stdout).kept).toEqual([])
    expect(stderr.endsWith('0 kept, 0 discarded, 0 unreviewed by panel\n')).toBe(true)
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
})
