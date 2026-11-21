import { describe, expect, it } from 'vitest'
import type { Outcome } from '../core/outcome.ts'
import type { Flag, LeftOutFile, PublicView, QuorumResult, Verdict } from '../core/types.ts'
import { expectCodeWritten as expectWritten, HOSTILE, RLO } from '../testing/markdown.ts'
import { blankResult, cast, FINDINGS, INCOMPLETE, INTERRUPTED, PASS, reportResult, SQL, TOKEN, UPLOAD } from '../testing/report.ts'
import { LISTED, markdown, SUMMARY_BUDGET, summaryMarkdown } from './markdown.ts'
import { renderReport } from './registry.ts'
import { publicView } from './view.ts'

const MARKER = '<!-- quorum:summary:v1 -->'
const TABLE_HEAD = '| Profile | Fail-on | Kept | Unreviewed | Discarded | Outside the diff | Coverage |'
const TABLE_RULE = '| --- | --- | ---: | ---: | ---: | ---: | --- |'
const TRAILER = 'quorum 0.6.0 · range `1f3a9c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`...`7b2e4d0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`'
const MORE = 'listed in the review\'s JSON result'

/** The head of the fixture's staged review, a commit whose id starts `7b2e4d0`. */
const HEAD = '7b2e4d0'.padEnd(40, 'a')

/** The summary of a result as its lines, the last one the empty text after the final line feed. */
function render(result: QuorumResult | PublicView, outcome: Outcome = FINDINGS): string[] {
  return markdown.render(result, { color: false, outcome }).split('\n')
}

const MAIN = [
  MARKER,
  '### quorum review',
  '',
  '**exit 1, findings:** a gating profile kept a finding at or above its fail-on level',
  '',
  TABLE_HEAD,
  TABLE_RULE,
  '| security | high | 1 | 1 | 1 | 0 | 1 of 3 files reviewed, 1 in part, 1 not |',
  '',
  '#### Findings',
  '',
  '- **HIGH** security · `src/auth/login.ts` line 42 · `CWE-89` · kept by 3 of 3 lenses',
  '',
  '  `SQL built from the request\'s id parameter reaches db.query`',
  '',
  '  ```text',
  '        41   const sql = \'SELECT * FROM users WHERE id = \' + id',
  '     >  42 + db.query(sql)',
  '        43   return rows',
  '  ```',
  '',
  '- **UNREVIEWED** security · `src/session.js` line 20 · `CWE-338` · kept by 1 of 3 lenses, 1 vote failed',
  '',
  '  `Session tokens come from Math.random, which is not a cryptographic generator.`',
  '',
  '  ```text',
  '           -   return crypto.randomBytes(32).toString(\'hex\')',
  '     >  20 +   return Math.random().toString(36).slice(2)',
  '        21   }',
  '  ```',
  '',
  '#### Gaps',
  '',
  '- security, binary: the diff carries no content for a binary file',
  '',
  '#### Files left out',
  '',
  '- `assets/logo.png` (binary)',
  '',
  '#### Flags',
  '',
  '- hidden-characters at `src/session.js` line 20: `U+202E on 1 added line(s)`',
  '',
  '---',
  '',
  TRAILER,
  '',
]

/** What the secrets fix records for a held file, a reviewed one and a deleted secret, on the staged changes. */
function secrets(): QuorumResult {
  return blankResult({
    durationMs: 1234,
    source: { kind: 'staged', head: HEAD, objectFormat: 'sha1' },
    profiles: {
      security: {
        ...reportResult().meta.profiles.security,
        coverage: [
          { file: '.env', status: 'unreviewed', reason: 'secret' },
          { file: 'a.js', status: 'reviewed' },
          { file: 'old/.env', status: 'unreviewed', reason: 'deleted-secret' },
        ],
      },
    },
    incomplete: [
      { profile: 'security', reason: 'secret', detail: 'no model was sent 1 file(s) held as secrets, listed in meta.leftOut' },
    ],
    leftOut: [
      { file: '.env', reason: 'secret', rule: 'name' },
      { file: 'old/.env', reason: 'deleted-secret', rule: 'name' },
    ],
    flags: [
      { code: 'secret-file', file: '.env', detail: 'named as a secret, so no model was sent any of it: check that it belongs in the change' },
      { code: 'secret-file', file: 'old/.env', detail: 'deletes a file named as a secret, so no model was sent any of it: the history still holds the file, so rotate what it held' },
    ],
  })
}

/** The check of a summary: the marker first, then only what quorum wrote. */
const expectCodeWritten = (summary: string): void => expectWritten(summary, MARKER)

/** The line of each finding's head, as `<level> <profile> <file>:<line>`, in the order the summary lists them. */
function heads(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const head = /^- \*\*(\w+)\*\* (\S+) · `([^`]+)` line (\d+)/.exec(line)
    return head === null
      ? []
      : [`${head[1]} ${head[2]} ${head[3]}:${head[4]}`]
  })
}

/** The lines of the list under `heading`: those between it and the blank line that ends the list. */
function listUnder(lines: readonly string[], heading: string): string[] {
  const start = lines.indexOf(heading) + 2
  return lines.slice(start, lines.indexOf('', start))
}

describe('markdown', () => {
  it('renders a review for a pull request: the verdict, the profiles, each finding with its evidence, the gaps, what was left out, the flags and the source', () => {
    expect(render(reportResult())).toEqual(MAIN)
  })

  it('writes the verdict of an interrupted review', () => {
    const lines = render(blankResult({
      incomplete: [
        { profile: 'security', reason: 'interrupted', detail: 'the interrupt stopped 2 of its 3 research parts' },
      ],
    }), INTERRUPTED)
    expect(lines.slice(0, 4)).toEqual([
      MARKER,
      '### quorum review',
      '',
      '**exit 130, interrupted:** the review was stopped before its end; what it read is above',
    ])
    expect(listUnder(lines, '#### Gaps')).toEqual(['- security, interrupted: the review was stopped before its end, so part of the work was never read'])
  })

  it('renders the review of a blank diff', () => {
    expect(render(blankResult(), PASS)).toEqual([
      MARKER,
      '### quorum review',
      '',
      '**exit 0, pass:** no gating profile kept a finding to fail on, and none has a gap',
      '',
      TABLE_HEAD,
      TABLE_RULE,
      '| security | high | 0 | 0 | 0 | 0 | the diff holds no file |',
      '',
      '---',
      '',
      'quorum 0.6.0 · diff',
      '',
    ])
  })

  it('renders the files held as secrets, their secret gap and their secret-file flags', () => {
    expect(render(secrets(), INCOMPLETE)).toEqual([
      MARKER,
      '### quorum review',
      '',
      '**exit 4, incomplete:** a gating profile has a gap or an unreviewed finding',
      '',
      TABLE_HEAD,
      TABLE_RULE,
      '| security | high | 0 | 0 | 0 | 0 | 1 of 3 files reviewed, 2 not |',
      '',
      '#### Gaps',
      '',
      '- security, secret: a file held back as a secret was sent to no model',
      '',
      '#### Files left out',
      '',
      '- `.env` (secret: name)',
      '- `old/.env` (deleted-secret: name)',
      '',
      '#### Flags',
      '',
      '- secret-file at `.env`: `named as a secret, so no model was sent any of it: check that it belongs in the change`',
      '- secret-file at `old/.env`: `deletes a file named as a secret, so no model was sent any of it: the history still holds the file, so rotate what it held`',
      '',
      '---',
      '',
      `quorum 0.6.0 · staged on \`${HEAD}\``,
      '',
    ])
  })

  it('lists the findings that fail their profile first, then high, medium, unreviewed and low, each by file and line', () => {
    const base = reportResult().meta.profiles.security
    const finding = (profile: string, file: string, line: number, confidence: Verdict['confidence']): Verdict => ({
      ...SQL,
      profile,
      file,
      line,
      confidence,
    })
    const result = reportResult({
      kept: [
        finding('security', 'd.js', 1, 'low'),
        finding('team', 'b.js', 1, 'medium'),
        finding('team', 'a.js', 9, 'high'),
        finding('security', 'z.js', 1, 'high'),
        finding('team', 'a.js', 2, 'high'),
        finding('security', 'y.js', 1, 'medium'),
      ],
      unreviewed: [
        {
          ...TOKEN,
          profile: 'security',
          file: 'c.js',
          line: 1,
        },
      ],
      meta: {
        profiles: {
          security: { ...base, failOn: 'medium' },
          team: { ...base, failOn: 'none', gating: false },
        },
      },
    })
    expect(heads(render(result))).toEqual([
      'MEDIUM security y.js:1',
      'HIGH security z.js:1',
      'HIGH team a.js:2',
      'HIGH team a.js:9',
      'MEDIUM team b.js:1',
      'UNREVIEWED security c.js:1',
      'LOW security d.js:1',
    ])
  })

  it('puts every text a model or the diff wrote in a code span or a fenced block, and gives every line the command rules', () => {
    const leftOut: LeftOutFile[] = [
      { file: 'a | `b`', reason: 'binary' },
    ]
    const flags: Flag[] = [
      {
        code: 'hidden-characters',
        file: '::x',
        line: 3,
        detail: '[link](https://e.example)',
      },
    ]
    const summary = markdown.render(reportResult({
      kept: [HOSTILE],
      unreviewed: [],
      meta: { leftOut, flags },
    }), { color: false, outcome: FINDINGS })
    expectCodeWritten(summary)
    expect(summary.split('\n')).toContain('- `` a | `b` `` (binary)')
    expect(summary).toContain('`[link](https://e.example)`')
    expect(summary).not.toContain('##[')
    expect(summary).not.toContain(RLO)
    expect(summary.split('\n').filter(line => /^\s*::/.test(line))).toEqual([])
  })

  it('renders a claim that quotes code in backticks as one code span', () => {
    const claim = 'Passes `req.query.id` to `db.query`'
    const lines = render(reportResult({
      kept: [
        { ...SQL, summary: claim },
      ],
      unreviewed: [],
    }))
    expect(lines).toContain('  `` Passes `req.query.id` to `db.query` ``')
    expectCodeWritten(lines.join('\n'))
  })

  it('writes the empty name as (no path), and lists twenty files left out and twenty flags, then how many more', () => {
    const leftOut: LeftOutFile[] = Array.from({ length: 25 }, (_, index) => ({
      file: index === 0
        ? ''
        : `f${index}.png`,
      reason: 'binary',
    }))
    const flags: Flag[] = Array.from({ length: 25 }, (_, index) => ({
      code: 'hidden-characters',
      file: `f${index}.js`,
      line: index + 1,
      detail: 'U+202E on 1 added line(s)',
    }))
    const lines = render(blankResult({ leftOut, flags }), PASS)
    expect(LISTED).toBe(20)
    expect(listUnder(lines, '#### Files left out')).toEqual([
      '- (no path) (binary)',
      ...Array.from({ length: 19 }, (_, index) => `- \`f${index + 1}.png\` (binary)`),
      `- and 5 more, ${MORE}`,
    ])
    expect(listUnder(lines, '#### Flags')).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `- hidden-characters at \`f${index}.js\` line ${index + 1}: \`U+202E on 1 added line(s)\``),
      `- and 5 more, ${MORE}`,
    ])
  })

  it('drops the evidence first, from the last finding up, and says how many', () => {
    const view = publicView(reportResult())
    const full = summaryMarkdown(view, FINDINGS)
    const lines = summaryMarkdown(view, FINDINGS, full.length - 1).split('\n')
    const fences = lines.flatMap((line, index) => line === '  ```text'
      ? [index]
      : [])
    expect(fences).toHaveLength(1)
    expect(fences[0]).toBeGreaterThan(lines.findIndex(line => line.startsWith('- **HIGH**')))
    expect(fences[0]).toBeLessThan(lines.findIndex(line => line.startsWith('- **UNREVIEWED**')))
    expect(lines.filter(line => line.startsWith('- **'))).toHaveLength(2)
    expect(lines.at(-5)).toBe('The evidence of 1 finding is left out, to stay within GitHub\'s limit: the review\'s JSON result holds it.')
    expect(lines.at(-3)).toBe('---')
    expect(lines.join('\n').length).toBeLessThanOrEqual(full.length - 1)
  })

  it('keeps the head, the verdict, the headings, the count lines and the trailer whatever the budget', () => {
    expect(summaryMarkdown(publicView(reportResult()), FINDINGS, 0).split('\n')).toEqual([
      MARKER,
      '### quorum review',
      '',
      '**exit 1, findings:** a gating profile kept a finding at or above its fail-on level',
      '',
      TABLE_HEAD,
      TABLE_RULE,
      '',
      `- and 1 more, ${MORE}`,
      '',
      '#### Findings',
      '',
      `- and 2 more findings (1 high, 1 unreviewed), ${MORE}`,
      '',
      '#### Gaps',
      '',
      `- and 1 more, ${MORE}`,
      '',
      '#### Files left out',
      '',
      `- and 1 more, ${MORE}`,
      '',
      '#### Flags',
      '',
      `- and 1 more, ${MORE}`,
      '',
      '---',
      '',
      TRAILER,
    ])
  })

  it('keeps 100 findings with full evidence, 5000 files left out and 5000 flags within 60 000 characters, the evidence going first and the findings that fail their profile last, each cut counted', () => {
    const base = reportResult().meta.profiles.security
    const evidence = Array.from({ length: 5 }, (_, row) => `+${String(row).repeat(389)}`).join('\n')
    const finding = (profile: string, index: number, confidence: Verdict['confidence']): Verdict => ({
      ...SQL,
      profile,
      file: `src/${profile}/file-${index}.ts`,
      line: index + 1,
      summary: `Claim ${index}: `.padEnd(500, 'w'),
      evidence,
      evidenceRow: 2,
      confidence,
    })
    const result = reportResult({
      kept: [
        ...Array.from({ length: 50 }, (_, index) => finding('team', index, 'medium')),
        ...Array.from({ length: 50 }, (_, index) => finding('security', index, 'high')),
      ],
      unreviewed: [],
      meta: {
        profiles: {
          security: base,
          team: { ...base, failOn: 'none', gating: false },
        },
        leftOut: Array.from({ length: 5000 }, (_, index) => ({ file: `big/${index}.bin`, reason: 'binary' })),
        flags: Array.from({ length: 5000 }, (_, index) => ({
          code: 'hidden-characters',
          file: `big/${index}.js`,
          line: 1,
          detail: 'U+202E on 1 added line(s)',
        })),
      },
    })
    const summary = markdown.render(result, { color: false, outcome: FINDINGS })
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_BUDGET)
    expect(SUMMARY_BUDGET).toBe(60_000)
    const lines = summary.split('\n')
    const listed = heads(lines)
    const profiles = listed.map(head => head.split(' ')[1])
    expect(profiles).toEqual([...profiles].sort())
    const cut = /^- and (\d+) more findings? \((.*)\), listed in the review's JSON result$/.exec(lines.find(line => line.startsWith('- and ') && line.includes('more finding')) ?? '')
    expect(cut).not.toBeNull()
    expect(listed.length + Number(cut![1])).toBe(100)
    expect(profiles.filter(profile => profile === 'security')).toHaveLength(50)
    if (/\bhigh\b/.test(cut![2])) expect(profiles).not.toContain('team')
    expect(lines.filter(line => line === `- and 5000 more, ${MORE}`)).toHaveLength(2)
    expect(lines.filter(line => line.startsWith('The evidence of '))).toEqual([`The evidence of ${listed.length} findings is left out, to stay within GitHub's limit: the review's JSON result holds it.`])
    expect(lines).not.toContain('  ```text')
    expectCodeWritten(summary)
  })

  it('renders the public view of a full result: no reasoning, and the discarded findings counted only', () => {
    const result = reportResult({
      kept: [
        {
          ...SQL,
          votes: [
            {
              ...cast(true),
              vote: { keep: true, reasoning: 'REASONING-CANARY' },
            },
          ],
        },
      ],
    })
    const rendered = renderReport(result, { format: 'markdown', outcome: FINDINGS })
    expect(rendered).toBe(`${summaryMarkdown(publicView(result), FINDINGS)}\n`)
    expect(rendered).toBe(markdown.render(publicView(result), { color: false, outcome: FINDINGS }))
    expect(rendered).not.toContain('REASONING-CANARY')
    expect(rendered).not.toContain(UPLOAD.file)
    expect(rendered.split('\n').find(line => line.startsWith('| security |'))).toBe('| security | high | 1 | 1 | 1 | 0 | 1 of 3 files reviewed, 1 in part, 1 not |')
  })
})
