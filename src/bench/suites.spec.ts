import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { splitDiff } from '../core/diff.ts'
import { diffFlags } from '../core/flags.ts'
import { largestVote, researchNeed } from '../testing/bench.ts'
import { GOALS, loadSuite } from './suite.ts'
import type { AttackCase, Suite, SuiteCase } from './suite.ts'

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

const INJECTION = join(BENCH, 'injection')
const TWINS = [
  'laravel-framework-ghsa-w2pm-r78h-4m7v',
  'binderhub-ghsa-9jjr-qqfp-ppwx',
  'wheel-ghsa-8rrh-rw8j-w5fx',
  'kredis-ghsa-h2wm-p2vg-6pw4',
  'fonttools-ghsa-6673-4983-2vx5',
  'slab-ghsa-qx2v-8332-m4fv',
  'ssh-net-ghsa-72p8-v4hg-v45p',
  'cakephp-ghsa-fxf7-vhh8-7vpq',
  'gorilla-handlers-ghsa-jcr6-mmjj-pchw',
  'compuware-common-configuration-plugin-ghsa-g43x-pcc9-f472',
  'react-native-cli-ghsa-399j-vxmf-hjvr',
  'hono-ghsa-xh87-mx6m-69f3',
]
/** The carrier and encoding pairs every goal holds (Decision 17), sorted. */
const PAIRS = [
  'comment base64',
  'comment hidden-unicode',
  'comment plain',
  'documentation base64',
  'documentation html-comment',
  'documentation multilingual',
  'file-name fake-delimiter',
  'file-name plain',
  'guideline-file hidden-unicode',
  'guideline-file html-comment',
  'string-literal fake-delimiter',
  'string-literal multilingual',
]

describe('bench/injection, the injection corpus', () => {
  let suite: Suite
  let bugs: Suite
  beforeAll(async () => {
    suite = await loadSuite(INJECTION, 'bench/injection')
    bugs = await loadSuite(BUGS, 'bench/bugs')
  })
  const attacks = (): AttackCase[] => suite.cases.filter((entry): entry is AttackCase => entry.kind === 'attack')
  const caseOf = (id: string): SuiteCase | undefined => suite.cases.find(entry => entry.id === id)

  it('passes the validation every run applies: the twelve twins, 48 attack cases and ten trials', () => {
    expect([suite.name, suite.trials, suite.window]).toEqual(['injection', 10, 3])
    expect(suite.cases.filter(({ kind }) => kind === 'bug').map(({ id }) => id)).toEqual(TWINS)
    expect(attacks()).toHaveLength(48)
    expect(suite.cases.filter(({ kind }) => kind === 'control')).toHaveLength(0)
  })

  it('copies its twins whole from the real-bug suite: the same entry and the same patch, byte for byte', () => {
    for (const twin of TWINS) {
      const entry = caseOf(twin)
      expect(entry, twin).toEqual(bugs.cases.find(({ id }) => id === twin))
      expect(readFileSync(join(INJECTION, 'cases', entry?.patch ?? '')), twin).toEqual(readFileSync(join(BUGS, 'cases', entry?.patch ?? '')))
    }
  })

  it('leaves out min-dash, fastify and youtubedlsharp, whose locations are open', () => {
    for (const left of ['min-dash-ghsa-2m53-83f3-562j', 'fastify-ghsa-667r-xxjv-c9mm', 'youtubedlsharp-ghsa-2jh5-g5ch-43q5']) expect(caseOf(left), left).toBeUndefined()
  })

  it('gives each twin one attack case of each goal, and each goal the same carrier and encoding pairs', () => {
    for (const twin of TWINS) expect(attacks().filter(entry => entry.twin === twin).map(({ goal }) => goal).sort(), twin).toEqual([...GOALS].sort())
    for (const goal of GOALS) expect(attacks().filter(entry => entry.goal === goal).map(({ carrier, encoding }) => `${carrier} ${encoding}`).sort(), goal).toEqual(PAIRS)
    const count = (pick: (entry: AttackCase) => string): Record<string, number> => Object.fromEntries([
      ...new Set(attacks().map(pick)),
    ].map(value => [value, attacks().filter(entry => pick(entry) === value).length]))
    expect(count(({ carrier }) => carrier)).toEqual({
      comment: 12,
      'string-literal': 8,
      'file-name': 8,
      documentation: 12,
      'guideline-file': 8,
    })
    expect(count(({ encoding }) => encoding)).toEqual({
      plain: 8,
      multilingual: 8,
      'hidden-unicode': 8,
      base64: 8,
      'html-comment': 8,
      'fake-delimiter': 8,
    })
  })

  it('gives every attack case its twin\'s repository, license, copyright and date, and a note that names its twin', () => {
    for (const entry of attacks()) {
      const twin = caseOf(entry.twin)
      expect([
        entry.repo,
        entry.license,
        entry.copyright,
        entry.date,
      ], entry.id).toEqual([
        twin?.repo,
        twin?.license,
        twin?.copyright,
        twin?.date,
      ])
      expect(entry.note?.endsWith(`; the poisoned patch of ${entry.twin}`), entry.id).toBe(true)
    }
  })

  it('raises no advisory flag on a twin, so a flag on a poisoned patch is its payload\'s', () => {
    for (const twin of TWINS) expect(diffFlags(splitDiff(suite.patches.get(caseOf(twin)?.patch ?? '') ?? '')), twin).toEqual([])
  })

  it('fits every research request and every vote of its cases in a window of 32 768 tokens, as the size guard counts them', () => {
    for (const entry of suite.cases) {
      const patch = suite.patches.get(entry.patch) ?? ''
      expect(researchNeed(patch), entry.id).toBeLessThanOrEqual(32_768)
      expect(largestVote(patch), entry.id).toBeLessThanOrEqual(32_768)
    }
  })

  it('has the text of every license its cases use', () => {
    const files = readdirSync(join(BENCH, 'LICENSES'))
    for (const { id, license } of suite.cases) expect(files, id).toContain(`${license}.txt`)
  })

  it('holds no file in cases/ that no case names', () => {
    expect(readdirSync(join(INJECTION, 'cases')).sort()).toEqual([
      ...suite.patches.keys(),
    ].sort())
  })
})
