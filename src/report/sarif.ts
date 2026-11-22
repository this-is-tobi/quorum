/**
 * SARIF for GitHub's code scanning: one run of the public view, a result for each kept or unreviewed finding
 * that sits on a file of the diff, and a notification for each gap and each file left out.
 *
 * **The levels agree with the exit code.** A result is `error` exactly when it fails its profile
 * (`failsItsProfile`, the rule that sets exit 1), `warning` for another kept `high` or `medium` finding and for an
 * unreviewed one, `note` for `low`. GitHub's check fails on an `error` alert, so it fails where quorum's gate
 * does, and a profile at `none` writes none. No result sets `security-severity`: GitHub reads that number
 * before the level, so a number quorum chose would decide the check's verdict instead of the profile's
 * `failOn`, which is what the owner configured.
 *
 * **`primaryLocationLineHash` is left out.** It is the key GitHub matches an alert across uploads by, and
 * `upload-sarif` computes it from the code at the result's line, by reading the files under its checkout, when a
 * file omits it. Without a checkout, as in the reference post job, no line hash is computed, so each push can open
 * new alerts. Quorum's own fingerprint is a different hash, so it sits under its own key (`FINGERPRINT_KEY`), which
 * GitHub ignores: the cost is a duplicate alert on a later push, never an alert matched to a dismissed one by a
 * reading quorum did not foresee.
 *
 * **Every location is valid whatever the finding.** One invalid result makes GitHub refuse the whole upload, so a
 * line is at least 1, the columns always run forward, and a path is a relative URI (`artifactUri`) of a clean
 * relative path (`isCleanRelativePath`), for a notification's locations as for a result's: a file whose name is
 * not clean is counted, never located.
 *
 * **Nothing here is Markdown, and no text is a link.** A message passes `inertPlain`. The only URLs are
 * `informationUri` and `$schema`, which quorum's code writes.
 *
 * @see ../../docs/20-using/80-reports.md
 */

import { failsItsProfile, isIncomplete, isInterrupted, profileFailOn } from '../core/outcome.ts'
import { inertJson, inertPlain } from '../core/sanitize.ts'
import { ownData } from '../core/facts.ts'
import type { Confidence, FailOn, PublicGap, PublicProfileMeta, PublicVerdict, PublicView } from '../core/types.ts'
import { commitOf, evidenceRows, GAP_WORDS, isCleanRelativePath, levelWord, placedFindings, plural, votesWords } from './lines.ts'
import type { Reporter } from './reporter.ts'
import { publicView } from './view.ts'

/** The most locations a notification lists. Its `count` says how many there were. */
export const MAX_LOCATIONS = 100

/** The key of quorum's fingerprint among a result's `partialFingerprints`. */
export const FINGERPRINT_KEY = 'quorumFingerprint/v1'

/** The schema the document declares. */
export const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json'

/** Where the run says its tool is documented: the one URL quorum's code writes. */
export const DOCS_URL = 'https://this-is-tobi.com/quorum/introduction'

type Level = 'error' | 'warning' | 'note'

interface Location {
  physicalLocation: {
    artifactLocation: { uri: string }
    region?: { startLine: number, startColumn: number, endLine: number, endColumn: number }
  }
}

interface Notification {
  level: Level
  message: { text: string }
  locations?: Location[]
  properties: Record<string, string | number>
}

/**
 * A file path as the relative URI of an artifact: each `/`-separated segment through `encodeURIComponent`, so a
 * space, a `%`, a `#`, a `?` or a hidden character cannot change what the URI names. The path is made well
 * formed first, since `encodeURIComponent` throws on a lone surrogate, which a file name can hold: it becomes
 * U+FFFD, and one odd name cannot stop the report.
 */
export function artifactUri(path: string): string {
  return path.toWellFormed().split('/').map(encodeURIComponent).join('/')
}

function locationOf(file: string): Location {
  return {
    physicalLocation: {
      artifactLocation: {
        uri: artifactUri(file),
      },
    },
  }
}

/** The text of a rule's help: what each level says, with the gate of the profile's `failOn`. */
function helpText(failOn: FailOn): string {
  const gate = failOn === 'none'
    ? 'the profile is advisory, so no finding is an error'
    : `error at or above the profile's fail-on level, ${failOn}`
  return `Its level says what the finding does to the review: ${gate}; warning for another kept high or medium finding and an unreviewed one; note for low. The review's summary holds its evidence.`
}

/** The rule of a profile: its three required texts, written by code. */
function ruleOf(view: PublicView, id: string): object {
  return {
    id: `quorum/${id}`,
    shortDescription: { text: `A finding of quorum's ${id} profile` },
    fullDescription: { text: `A finding the ${id} profile's research reported, which its panel of blind voters kept or left unreviewed: a claim about the code that a person checks.` },
    help: {
      text: helpText(profileFailOn(view, id)),
    },
    defaultConfiguration: { level: 'warning' },
  }
}

/** The level of a finding: `error` when it fails its profile, `note` for low, else `warning`. */
function levelOf(view: PublicView, verdict: PublicVerdict): Level {
  if (failsItsProfile(view, verdict)) return 'error'
  return verdict.confidence === 'low'
    ? 'note'
    : 'warning'
}

/** The UTF-16 length of the code of a row: the row without its marker, its first character. */
function codeLength(row: string): number {
  const first = row.codePointAt(0)
  if (first === undefined) return 0
  return row.length - (first > 0xFFFF
    ? 2
    : 1)
}

/**
 * The region of a finding. The line is at least 1, since GitHub refuses line 0 and a file the change empties
 * has findings there. The columns run from 1 to the code of the cited row, as long as the row is, plus one, and
 * from 1 to 1 when no row is cited: an end never comes before its start.
 */
function regionOf(verdict: PublicVerdict): NonNullable<Location['physicalLocation']['region']> {
  const line = Number.isInteger(verdict.line) && verdict.line >= 1
    ? verdict.line
    : 1
  const cited = evidenceRows(verdict).rows.findIndex(row => row.cited)
  const endColumn = cited === -1
    ? 1
    : codeLength(verdict.evidence.split('\n')[cited]) + 1
  return {
    startLine: line,
    startColumn: 1,
    endLine: line,
    endColumn,
  }
}

/** The result of a finding on a file of the diff. */
function resultOf(view: PublicView, ruleIds: readonly string[], verdict: PublicVerdict): object {
  const location: Location = {
    physicalLocation: {
      artifactLocation: {
        uri: artifactUri(verdict.file),
      },
      region: regionOf(verdict),
    },
  }
  return {
    ruleId: `quorum/${verdict.profile}`,
    ruleIndex: ruleIds.indexOf(verdict.profile),
    level: levelOf(view, verdict),
    message: { text: `${levelWord(verdict)}, ${votesWords(verdict)}: ${inertPlain(`${verdict.category}: ${verdict.summary}`)}` },
    locations: [location],
    partialFingerprints: { [FINGERPRINT_KEY]: verdict.fingerprint },
    ...isKept(verdict)
      ? {
          properties: { precision: verdict.confidence },
        }
      : {},
  }
}

/** Whether a finding is kept: it has a confidence, which an unreviewed one never has. */
function isKept(verdict: PublicVerdict): verdict is PublicVerdict & { confidence: Confidence } {
  return verdict.confidence !== undefined
}

/** The names in `files`, once each, in order. */
function distinct(files: readonly string[]): string[] {
  return [
    ...new Set(files),
  ]
}

/** The files a gap is about: those of its profile's coverage that carry its reason, then its own `file`, without repeats or the empty name. Not every one is a clean relative path. */
function gapFiles(view: PublicView, gap: PublicGap): string[] {
  const profile = ownData(view.meta.profiles, gap.profile) as PublicProfileMeta | undefined
  const covered = (profile?.coverage ?? [])
    .filter(entry => entry.reason === gap.reason || entry.left?.some(range => range.reason === gap.reason) === true)
    .map(entry => entry.file)
  return distinct([
    ...covered,
    ...gap.file === undefined
      ? []
      : [gap.file],
  ]).filter(file => file !== '')
}

/**
 * The locations of the clean relative paths among `files`, at most `MAX_LOCATIONS`. A file that is no clean
 * relative path has none, since its URI could name another place; the notification's `count` still counts it. A
 * notification with no location has no `locations`.
 */
function locationsOf(files: readonly string[]): { locations?: Location[] } {
  const clean = files.filter(isCleanRelativePath)
  return clean.length === 0
    ? {}
    : {
        locations: clean.slice(0, MAX_LOCATIONS).map(locationOf),
      }
}

/** A gap's notification: `error` for a gating profile's, `warning` for an advisory one's, with its files. */
function gapNotification(view: PublicView, gap: PublicGap): Notification {
  const files = gapFiles(view, gap)
  const count = files.length === 0
    ? ''
    : ` (${plural(files.length, 'file')})`
  return {
    level: profileFailOn(view, gap.profile) === 'none'
      ? 'warning'
      : 'error',
    message: { text: `${gap.profile}, ${gap.reason}: ${GAP_WORDS[gap.reason]}${count}` },
    ...locationsOf(files),
    properties: { profile: gap.profile, reason: gap.reason, count: files.length },
  }
}

/** The reasons of the files left out that no gap records, in the order their notes go. */
const NOTED_REASONS = ['excluded', 'skipped', 'deleted-secret'] as const

/** A note for each reason of the files left out with no gap, with its files. */
function leftOutNotifications(view: PublicView): Notification[] {
  return NOTED_REASONS.flatMap((reason) => {
    const files = distinct(view.meta.leftOut.filter(entry => entry.reason === reason).map(entry => entry.file))
    if (files.length === 0) return []
    return [
      {
        level: 'note',
        message: { text: `${plural(files.length, 'file')} left out: ${reason}` },
        ...locationsOf(files),
        properties: { reason, count: files.length },
      },
    ]
  })
}

/** The notifications of a run: the gaps in the order of `meta.incomplete`, the files left out with no gap, then the findings no result holds. */
function notificationsOf(view: PublicView, unplaced: number): Notification[] {
  return [
    ...view.meta.incomplete.map(gap => gapNotification(view, gap)),
    ...leftOutNotifications(view),
    ...unplaced === 0
      ? []
      : [
          {
            level: 'note' as const,
            message: { text: `findings that name no file of the diff, which no result holds: ${unplaced}` },
            properties: { count: unplaced },
          },
        ],
  ]
}

/** The document of a public view. */
function logOf(view: PublicView): object {
  const ruleIds = Object.keys(view.meta.profiles)
  const { placed, unplaced } = placedFindings(view)
  const commit = commitOf(view.meta.source)
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'quorum',
            version: view.meta.version,
            informationUri: DOCS_URL,
            rules: ruleIds.map(id => ruleOf(view, id)),
          },
        },
        invocations: [
          {
            executionSuccessful: !isIncomplete(view) && !isInterrupted(view),
            toolExecutionNotifications: notificationsOf(view, unplaced),
          },
        ],
        results: placed.map(verdict => resultOf(view, ruleIds, verdict)),
        ...commit === null
          ? {}
          : {
              properties: { commit },
            },
      },
    ],
  }
}

/**
 * The SARIF of a review, from the public view of what it is given: one run, as `inertJson` writes it, then a line
 * feed. It says the run did not succeed whenever a gating profile has a gap or an unreviewed finding, even when
 * a kept finding sets exit 1 or `--allow-incomplete` lifted the gaps, since a gap is work the review did not do.
 * It uploads nothing: GitHub's own action does.
 */
export const sarif: Reporter = {
  publicOnly: true,
  render: input => `${inertJson(logOf(publicView(input)))}\n`,
}
