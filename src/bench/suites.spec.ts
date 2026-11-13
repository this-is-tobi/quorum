import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadSuite } from './suite.ts'
import type { Suite } from './suite.ts'

const BENCH = fileURLToPath(new URL('../../bench', import.meta.url))
const BUGS = join(BENCH, 'bugs')

describe('bench/bugs, the real-bug suite', () => {
  let suite: Suite
  beforeAll(async () => {
    suite = await loadSuite(BUGS, 'bench/bugs')
  })

  it('passes the validation every run applies, and holds about ten cases', () => {
    expect(suite.name).toBe('bugs')
    expect(suite.cases.filter(({ kind }) => kind === 'bug').length).toBeGreaterThanOrEqual(8)
    expect(suite.cases.filter(({ kind }) => kind === 'control').length).toBeGreaterThanOrEqual(2)
  })

  it('gives every case its provenance', () => {
    for (const entry of suite.cases) {
      expect(entry.repo, entry.id).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
      for (const field of ['license', 'date', 'note'] as const) expect(entry[field], `${entry.id}.${field}`).toBeDefined()
      expect(entry.copyright?.length, entry.id).toBeGreaterThan(0)
      if (entry.kind === 'bug') expect([entry.fixCommit, entry.introducingCommit].every(Boolean), entry.id).toBe(true)
      else expect(entry.commit, entry.id).toBeDefined()
    }
  })

  it('has the text of every license its cases use, and of no other', () => {
    const used = new Set(suite.cases.map(({ license }) => `${license}.txt`))
    expect(readdirSync(join(BENCH, 'LICENSES')).sort()).toEqual([...used].sort())
  })

  it('keeps every patch under 64 KiB', () => {
    for (const name of suite.patches.keys()) expect(statSync(join(BUGS, 'cases', name)).size, name).toBeLessThan(64 * 1024)
  })

  it('holds no file in cases/ that no case names', () => {
    expect(readdirSync(join(BUGS, 'cases')).sort()).toEqual([
      ...suite.patches.keys(),
    ].sort())
  })
})
