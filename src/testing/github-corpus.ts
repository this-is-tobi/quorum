/**
 * The hostile corpus of the Markdown reporters: every text a viewer on GitHub would act on, each in every field a
 * reporter writes, and the checks of what GitHub's renderer made of the reporters' documents. The suite checks the
 * documents by structure (`src/report/corpus.spec.ts`); `scripts/github-markdown.ts`, which only a person runs,
 * renders them on GitHub's Markdown API and checks the HTML.
 */

import { createHash } from 'node:crypto'
import { outcome } from '../core/outcome.ts'
import type { QuorumResult, Verdict } from '../core/types.ts'
import { payload } from '../report/payload.ts'
import { cast, reportMeta } from './report.ts'

const COMMIT = 'dd2775b759e298414083ef3bf13a48370f7114da'

/** The most groups the texts are joined into as the files left out and the flags' details, so the summary lists each whole. */
const MAX_GROUPS = 20

/** The longest category the core accepts. */
const MAX_CATEGORY = 80

/** What a viewer on GitHub would act on, each hidden character built from its code point so no file holds it raw. */
export const HOSTILE: readonly string[] = [
  '@octocat',
  '\\@octocat',
  '@github/security',
  '#1',
  'GH-1',
  'this-is-tobi/quorum#1',
  COMMIT,
  `this-is-tobi/quorum@${COMMIT}`,
  ':smile:',
  '$x^2$',
  '<img src=x onerror=alert(1)>',
  '<a href="https://e.example">x</a>',
  '<details open>',
  '<!-- quorum:summary:v1 -->',
  '&#64;octocat',
  '&lt;b&gt;',
  '![x](https://e.example/x.png)',
  'https://e.example',
  'www.e.example',
  '<https://e.example>',
  '`edge',
  'edge`',
  '``edge``',
  'a``b',
  '```',
  '   ',
  'a\nb',
  'a\rb',
  'a\r\nb',
  `a${String.fromCharCode(0x2028)}b`,
  `a${String.fromCharCode(0x202E)}b`,
  `a${String.fromCodePoint(0xE0041)}b`,
  '```suggestion',
  '~~~',
  '```mermaid',
  'a | b',
  '> [!WARNING]',
  '[^1]',
]

/** Raw Markdown that GitHub must link, render or draw, so a renderer that stopped would not pass quorum's documents for nothing: a mention, issue and commit links, an emoji, an image and math. */
export const CONTROL = `@octocat #1 this-is-tobi/quorum#1 ${COMMIT} :smile: <img src="https://e.example/x.png"> $x^2$`

/** The texts joined by a space into at most `MAX_GROUPS` groups, each text in one group. */
function grouped(): string[] {
  const groups: string[][] = Array.from({
    length: Math.min(MAX_GROUPS, HOSTILE.length),
  }, () => [])
  HOSTILE.forEach((text, index) => groups[index % groups.length].push(text))
  return groups.map(group => group.join(' '))
}

/** A finding on a clean relative path, so a reporter places it: the text's slashes are `|` in the file name, since a path with an empty, `.` or `..` segment is counted, not placed, and the text is whole in the other fields. */
function hostileFinding(text: string, index: number): Verdict {
  return {
    id: index.toString(16).padStart(12, '0'),
    fingerprint: `${index.toString(16).padStart(16, '0')}:1`,
    profile: 'security',
    file: `src/h${index}/${text.replaceAll('/', '|')}`,
    line: index + 1,
    category: text.slice(0, MAX_CATEGORY),
    summary: `claim ${index}: ${text}`,
    evidence: [` before ${text}`, `+cited ${text}`, ' after'].join('\n'),
    evidenceRow: 1,
    quoteMatched: true,
    keptVotes: 3,
    totalVotes: 3,
    confidence: 'high',
    votes: [
      cast(true),
      cast(true),
      cast(true),
    ],
  }
}

/** A review of one profile, `security`, with one kept `high` finding per hostile text, every one on a file of its coverage, and the texts again as files left out and flags. */
export function corpusResult(): QuorumResult {
  const kept = HOSTILE.map(hostileFinding)
  const base = reportMeta()
  const texts = grouped()
  return {
    kept,
    discarded: [],
    unreviewed: [],
    meta: {
      ...base,
      profiles: {
        security: {
          ...base.profiles.security,
          invalidFindings: 0,
          rules: { listed: 0, sent: 0 },
          invalidRules: 0,
          coverage: kept.map(({ file }) => ({ file, status: 'reviewed' as const })),
        },
      },
      incomplete: [],
      leftOut: texts.map(file => ({ file, reason: 'excluded' as const })),
      flags: texts.map(detail => ({ code: 'ai-addressed-text' as const, detail })),
    },
  }
}

/** The documents the script renders on GitHub: the `control`, then the `summary` and a `comment-<n>` for each finding, the `payload` reporter's. */
export function corpusDocuments(): Array<{ readonly name: string, readonly markdown: string }> {
  const result = corpusResult()
  const document = JSON.parse(payload.render(result, {
    color: false,
    outcome: outcome(result),
  })) as {
    summary: string
    comments: Array<{ body: string }>
  }
  return [
    { name: 'control', markdown: CONTROL },
    { name: 'summary', markdown: document.summary },
    ...document.comments.map(({ body }, index) => ({ name: `comment-${index + 1}`, markdown: body })),
  ]
}

/** `sha256:` and the hex of SHA-256 over the documents' names and Markdown as JSON, in order. */
export function corpusHash(documents: ReadonlyArray<{ readonly name: string, readonly markdown: string }>): string {
  const json = JSON.stringify(documents.map(({ name, markdown }) => [name, markdown]))
  return `sha256:${createHash('sha256').update(json).digest('hex')}`
}

/** A class inside a tag: GitHub escapes `<` in a text node but not `"`, so `class="…"` written as code must not match. */
const classOf = (name: string): RegExp => new RegExp(`<[a-z][^>]*\\bclass="[^"]*\\b${name}\\b`)

const MENTION = classOf('(?:user|team)-mention')
const ISSUE_LINK = classOf('issue-link')
const COMMIT_LINK = classOf('commit-link')
const EMOJI = /<g-emoji\b/
const IMAGE = /<img\b/
const MATH = new RegExp(`<math-renderer\\b|${classOf('js-inline-math').source}`)
const ALERT = classOf('markdown-alert')
const FOOTNOTE = /<[a-z][^>]*\sdata-footnotes\b/

/** What GitHub's renderer must not make of quorum's documents, as the HTML shows it, each with the words that name it. */
const PROBLEMS: ReadonlyArray<readonly [string, RegExp]> = [
  ['an image', IMAGE],
  ['a mention', MENTION],
  ['an issue or pull request link', ISSUE_LINK],
  ['a commit link', COMMIT_LINK],
  ['an emoji', EMOJI],
  ['math', MATH],
  ['an alert', ALERT],
  ['a footnote', FOOTNOTE],
  ['raw HTML', /<(?:script|iframe|object|embed|form|input|textarea|style|details|summary)\b/i],
  ['a link', /<a\b[^>]*\shref="(?!#)/],
]

/** What the HTML GitHub rendered holds that quorum's documents must never produce, each found once, in fixed words; `[]` when it holds none. A link to a heading of the page is no link. */
export function renderingProblems(html: string): string[] {
  return PROBLEMS.filter(([, pattern]) => pattern.test(html)).map(([name]) => name)
}

/** What GitHub must render of the control and did not, each in fixed words: `no mention`, `no issue link`, `no commit link`, `no emoji`, `no image` and `no math`, in that order; `[]` when it rendered all six. */
const CONTROL_CHECKS: ReadonlyArray<readonly [string, RegExp]> = [
  ['no mention', MENTION],
  ['no issue link', ISSUE_LINK],
  ['no commit link', COMMIT_LINK],
  ['no emoji', EMOJI],
  ['no image', IMAGE],
  ['no math', MATH],
]

/** What the control's HTML lacks that GitHub must render, in the words of `CONTROL_CHECKS`; `[]` when it holds all six. */
export function controlProblems(html: string): string[] {
  return CONTROL_CHECKS.filter(([, pattern]) => !pattern.test(html)).map(([name]) => name)
}
