/**
 * The payload `quorum-action` posts: one versioned JSON document that holds the commit the review is about, what
 * it concluded, the summary, and a line comment for each kept or unreviewed finding that sits on a file of the
 * diff. It is the public view's, and `inertJson` writes it, so no text a model or the diff wrote can act in it.
 *
 * The Action composes no text from the payload: the summary and each comment's body are posted as they are, so
 * what is written here is what a stranger reads on the pull request. Everything the Action must do besides
 * posting, such as paging through the comments already there, is listed in its reference page.
 *
 * @see ../../docs/95-reference/50-action-payload.md
 */

import type { Outcome, OutcomeStatus } from '../core/outcome.ts'
import { codeSpan, inertJson, inertLine } from '../core/sanitize.ts'
import type { Confidence, PublicVerdict, PublicView } from '../core/types.ts'
import { byLocation, commitOf, levelWord, votesWords } from './lines.ts'
import { summaryMarkdown } from './markdown.ts'
import type { Reporter } from './reporter.ts'
import { publicView } from './view.ts'

/** A line comment on a file of the diff: the finding's fingerprint, its level, where it sits and its body. */
export interface ActionComment {
  readonly fingerprint: string
  readonly profile: string
  readonly confidence: Confidence | 'unreviewed'
  readonly path: string
  /** The line of the finding in the new file. 0 stays 0: GitHub refuses it, and the Action turns it into a comment on the file. */
  readonly line: number
  readonly side: 'RIGHT'
  readonly body: string
}

/** The document `-f payload` writes. A change of its shape raises `version`. */
export interface ActionPayload {
  readonly version: 1
  /** The commit the changes sit on: a range's head, a local or staged review's head, a path review's commit; `null` for a diff, or before a first commit. */
  readonly head: string | null
  /** What the review came to, as the exit code says it. */
  readonly conclusion: OutcomeStatus
  /** The Markdown summary, which the Action posts as one comment and updates in place. */
  readonly summary: string
  readonly comments: readonly ActionComment[]
  /** How many kept and unreviewed findings no line comment holds, since their file is no file of the diff. The summary lists them. */
  readonly unplaced: number
}

/**
 * The body of a finding's line comment: the marker, then its level, profile, category and votes, a blank line and
 * its claim. The marker holds the fingerprint, which survives a push that moves the line, so the Action finds
 * the comment it posted for a finding by that text, whatever the comment's line has become, and never posts it
 * twice. Only the first line holds raw HTML; the category and the claim, a model's text, are code spans, and no
 * evidence is written, since the comment sits on the code. Every line passes `inertLine`, and there is no line
 * feed after the last.
 */
export function commentBody(verdict: PublicVerdict): string {
  return [
    `<!-- quorum:finding:v1 ${verdict.fingerprint} -->`,
    `**${levelWord(verdict)}** ${verdict.profile} · ${codeSpan(verdict.category)} · ${votesWords(verdict)}`,
    '',
    codeSpan(verdict.summary),
  ].map(inertLine).join('\n')
}

/** The files of each profile's coverage, the diff's own files, built once. */
function filesByProfile(view: PublicView): Map<string, ReadonlySet<string>> {
  return new Map(Object.entries(view.meta.profiles).map(([id, profile]) => [
    id,
    new Set(profile.coverage.map(entry => entry.file)),
  ]))
}

/** The document of a public view: a finding is a comment when its file is a non-empty path its profile's coverage lists, and counted in `unplaced` otherwise. */
function payloadOf(view: PublicView, outcome: Outcome): ActionPayload {
  const files = filesByProfile(view)
  const findings = [
    ...view.kept,
    ...view.unreviewed,
  ]
  const placed = findings
    .filter(({ file, profile }) => file !== '' && files.get(profile)?.has(file) === true)
    .sort(byLocation)
  return {
    version: 1,
    head: commitOf(view.meta.source),
    conclusion: outcome.status,
    summary: summaryMarkdown(view, outcome),
    comments: placed.map(verdict => ({
      fingerprint: verdict.fingerprint,
      profile: verdict.profile,
      confidence: levelWord(verdict).toLowerCase() as ActionComment['confidence'],
      path: verdict.file,
      line: verdict.line,
      side: 'RIGHT',
      body: commentBody(verdict),
    })),
    unplaced: findings.length - placed.length,
  }
}

/**
 * The payload of a review, from the public view of what it is given: the document `ActionPayload` describes,
 * as `inertJson` writes it, then a line feed. The comments go by file, then line, as the text report orders its
 * findings.
 */
export const payload: Reporter = {
  publicOnly: true,
  render: (input, { outcome }) => {
    return `${inertJson(payloadOf(publicView(input), outcome))}\n`
  },
}
