import { describe, expect, it } from 'vitest'
import type { Outcome } from '../core/outcome.ts'
import type { Flag, LeftOutFile, PublicView, QuorumResult, Verdict } from '../core/types.ts'
import { expectCodeWritten as expectWritten, HOSTILE, RLO } from '../testing/markdown.ts'
import { blankResult, cast, contextDocument, FINDINGS, INCOMPLETE, INTERRUPTED, PASS, reportResult, SQL, TOKEN, UPLOAD } from '../testing/report.ts'
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
  '- **UNREVIEWED** security · `src/session.js` line 20 · `CWE-338` · kept by 1 of 3 lenses, 1 vote failed: a network error',
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

  it('writes a finding\'s rule in a code span in the summary, after its category, and none for a finding that cites none', () => {
    const result = reportResult({
      kept: [
        { ...SQL, rule: 'tests-for-new-code' },
      ],
      unreviewed: [
        { ...TOKEN, rule: 'no-any' },
      ],
    })
    const lines = render(result)
    expect(lines).toContain('- **HIGH** security · `src/auth/login.ts` line 42 · `CWE-89` · rule `tests-for-new-code` · kept by 3 of 3 lenses')
    expect(lines).toContain('- **UNREVIEWED** security · `src/session.js` line 20 · `CWE-338` · rule `no-any` · kept by 1 of 3 lenses, 1 vote failed: a network error')
    expectCodeWritten(lines.join('\n'))
    // The rest of the summary is the one a review with no rule reads: the table holds no rule words, and neither does a finding with none.
    expect(lines.filter(line => !line.startsWith('- **'))).toEqual(MAIN.filter(line => !line.startsWith('- **')))
    expect(render(reportResult())).toEqual(MAIN)
    expect(render(reportResult()).join('\n')).not.toContain('rule `')
    // The public view the summary is written from keeps the id, and a result given as that view reads the same.
    expect(render(publicView(result))).toEqual(lines)
  })

  it('ends the coverage cell of a profile that asked nothing with the rules it was sent and that its research asks nothing, and no other profile\'s', () => {
    const { security } = reportResult().meta.profiles
    const asked = (rules: { listed: number, sent: number }): QuorumResult => blankResult({
      profiles: {
        security: {
          ...security,
          rules,
          asksNothing: true,
          coverage: [
            { file: 'a.js', status: 'reviewed' },
          ],
        },
      },
    })
    expect(render(asked({ listed: 0, sent: 0 }), PASS).slice(5, 8)).toEqual([
      TABLE_HEAD,
      TABLE_RULE,
      '| security | high | 0 | 0 | 0 | 0 | 1 of 1 file reviewed; rules 0 of 0 sent, so its research asks nothing |',
    ])
    expect(render(asked({ listed: 5, sent: 0 }), PASS)[7]).toBe('| security | high | 0 | 0 | 0 | 0 | 1 of 1 file reviewed; rules 0 of 5 sent, so its research asks nothing |')
    // The view the summary is written from keeps the flag, so a result given as that view reads the same, and the cell holds no `|` and nothing a model wrote.
    expect(render(publicView(asked({ listed: 5, sent: 0 })), PASS)).toEqual(render(asked({ listed: 5, sent: 0 }), PASS))
    expectCodeWritten(render(asked({ listed: 0, sent: 0 }), PASS).join('\n'))
    // A profile that lists no rule and requires none has the row it always had, and so has one that was sent some of its rules.
    expect(render(reportResult())).toEqual(MAIN)
    expect(render(blankResult({
      profiles: {
        security: {
          ...security,
          rules: { listed: 5, sent: 3 },
          coverage: [],
        },
      },
    }), PASS)[7]).toBe('| security | high | 0 | 0 | 0 | 0 | the diff holds no file |')
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

  it('names a flag\'s profile', () => {
    const flags: Flag[] = [
      {
        code: 'guideline-edited',
        profile: 'security',
        file: 'REVIEW.md',
        detail: 'the guidelines this review read for the profile from 1f3a9c2, not the change\'s version',
      },
      { code: 'guideline-edited', profile: 'naming', detail: 'the do-not-report text this review read' },
    ]
    expect(render(blankResult({ flags }), PASS).filter(line => line.startsWith('- guideline-edited'))).toEqual([
      '- guideline-edited at `REVIEW.md` (security): `the guidelines this review read for the profile from 1f3a9c2, not the change\'s version`',
      '- guideline-edited (naming): `the do-not-report text this review read`',
    ])
  })

  it('lists the documents read, each path, commit and hash in a code span', () => {
    const commit = '1f3a9c2'.padEnd(40, 'a')
    const documents = [
      contextDocument(),
      contextDocument({
        origin: 'repository',
        path: 'docs/threat-model.md',
        commit,
        sha256: 'a'.repeat(64),
        bytes: 2000,
      }),
      contextDocument({
        profile: 'naming',
        origin: 'config',
        sha256: '3f2a9c1d0b7e'.padEnd(64, '0'),
        bytes: 4100,
        removed: { characters: 3, comments: 1, entities: 0 },
      }),
      contextDocument({
        profile: 'naming',
        kind: 'do-not-report',
        origin: 'repository',
        path: 'REVIEW-skip.md',
        commit,
        status: 'missing',
        bytes: 0,
      }),
    ]
    const lines = render(reportResult({
      meta: {
        context: { documents },
      },
    }))
    // The section follows the flags, and each record is an item in the words of its line, its path, commit and hash in spans.
    expect(lines.slice(lines.indexOf('#### Flags'))).toEqual([
      '#### Flags',
      '',
      '- hidden-characters at `src/session.js` line 20: `U+202E on 1 added line(s)`',
      '',
      '#### Documents read',
      '',
      '- security guidelines of the profile, 1830 bytes',
      '- security guidelines `docs/threat-model.md` at `1f3a9c2`, 2000 bytes',
      '- naming guidelines from a file, sha256 `3f2a9c1d0b7e`, 4100 bytes; the cleaner removed 3 hidden character(s) and 1 comment(s)',
      '- naming do-not-report text `REVIEW-skip.md` at `1f3a9c2`: missing, and optional',
      '',
      '---',
      '',
      TRAILER,
      '',
    ])
    // A review with no document has no section, and a path that holds Markdown stays in its span.
    expect(render(reportResult())).toEqual(MAIN)
    const hostile = render(reportResult({
      meta: {
        context: {
          documents: [
            contextDocument({
              origin: 'repository',
              path: '`@octocat` #1 |![x](https://e.example/x.png)',
              commit,
            }),
          ],
        },
      },
    }))
    expect(hostile).toContain('- security guidelines `` `@octocat` #1 |![x](https://e.example/x.png) `` at `1f3a9c2`, 1830 bytes')
    expectCodeWritten(hostile.join('\n'))
  })

  it('lists twenty documents then how many more, and cuts them before the flags when the budget is short', () => {
    const documents = Array.from({ length: 25 }, (_, index) => contextDocument({
      origin: 'repository',
      path: `docs/${index}.md`,
      commit: '1f3a9c2'.padEnd(40, 'a'),
    }))
    const result = blankResult({
      context: { documents },
      flags: [
        {
          code: 'hidden-characters',
          file: 'a.js',
          line: 1,
          detail: 'U+202E on 1 added line(s)',
        },
      ],
    })
    const view = publicView(result)
    const full = summaryMarkdown(view, PASS)
    expect(listUnder(full.split('\n'), '#### Documents read')).toEqual([
      ...Array.from({ length: 20 }, (_, index) => `- security guidelines \`docs/${index}.md\` at \`1f3a9c2\`, 1830 bytes`),
      `- and 5 more, ${MORE}`,
    ])
    // One code unit short of the whole, the documents lose their last entry, and the flag stays.
    const short = summaryMarkdown(view, PASS, full.length - 1).split('\n')
    expect(listUnder(short, '#### Documents read').at(-1)).toBe(`- and 6 more, ${MORE}`)
    expect(listUnder(short, '#### Flags')).toEqual(['- hidden-characters at `a.js` line 1: `U+202E on 1 added line(s)`'])
    // With no room at all, each section keeps its heading and a count of what it cut.
    const none = summaryMarkdown(view, PASS, 0).split('\n')
    expect(listUnder(none, '#### Documents read')).toEqual([`- and 25 more, ${MORE}`])
    expect(listUnder(none, '#### Flags')).toEqual([`- and 1 more, ${MORE}`])
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
