import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadSuite } from './suite.ts'
import type { Suite } from './suite.ts'

const BENCH = fileURLToPath(new URL('../../bench', import.meta.url))
const BUGS = join(BENCH, 'bugs')

/** The language of a file by its extension. An extension this lacks fails the spread test, so a new language adds its row here. */
const LANGUAGES: Readonly<Record<string, string>> = {
  '.py': 'Python',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.go': 'Go',
  '.rs': 'Rust',
  '.php': 'PHP',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.cs': 'C#',
}

describe('bench/bugs, the real-bug suite', () => {
  let suite: Suite
  beforeAll(async () => {
    suite = await loadSuite(BUGS, 'bench/bugs')
  })

  it('passes the validation every run applies, and holds at least 30 bug cases and 10 controls', () => {
    expect(suite.name).toBe('bugs')
    expect(suite.cases.filter(({ kind }) => kind === 'bug').length).toBeGreaterThanOrEqual(30)
    expect(suite.cases.filter(({ kind }) => kind === 'control').length).toBeGreaterThanOrEqual(10)
  })

  it('spans at least four languages, with none over a third of the bug cases', () => {
    const perLanguage = new Map<string, number>()
    let bugs = 0
    for (const entry of suite.cases) {
      if (entry.kind !== 'bug') continue
      const file = entry.locations[0]?.file ?? ''
      const language = LANGUAGES[extname(file).toLowerCase()]
      if (language === undefined) throw new Error(`${entry.id}: no language for the extension of ${JSON.stringify(file)}`)
      perLanguage.set(language, (perLanguage.get(language) ?? 0) + 1)
      bugs++
    }
    const languages = Array.from(perLanguage.keys()).join(', ')
    expect(perLanguage.size, languages).toBeGreaterThanOrEqual(4)
    for (const [language, count] of perLanguage) expect(count, language).toBeLessThanOrEqual(bugs / 3)
  })

  it('gives every case its provenance', () => {
    for (const entry of suite.cases) {
      expect(entry.repo, entry.id).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
      for (const field of ['license', 'date', 'note'] as const) expect(entry[field], `${entry.id}.${field}`).toBeDefined()
      expect(entry.copyright?.length, entry.id).toBeGreaterThan(0)
      expect([
        'MIT',
        'Apache-2.0',
        'BSD-2-Clause',
        'BSD-3-Clause',
        'ISC',
      ], entry.id).toContain(entry.license)
      if (entry.kind === 'bug') expect([entry.fixCommit, entry.introducingCommit].every(Boolean), entry.id).toBe(true)
      else if (entry.kind === 'control') expect(entry.commit, entry.id).toBeDefined()
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
