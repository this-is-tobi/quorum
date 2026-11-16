/*!
 * The credential rules below are gitleaks 8.30.1's, and the private-key markers are
 * pre-commit-hooks v5.0.0's. Both are MIT licensed:
 *
 * Copyright (c) 2019 Zachary Rice
 * Copyright (c) 2014 pre-commit dev team: Anthony Sottile, Ken Struys
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * What holds a file back from every review: its name, or a credential it holds. Pure functions over a
 * path and a diff's text, which the sources and the review apply before any model is sent a line.
 * Every check is generous (a hunk row that reads like a header names a path, a removed line holds a
 * key as an added one does), so a doubtful file is held and never sent.
 *
 * @see ../../docs/20-using/15-sources.md#files-held-back-as-secrets for what a reader sees.
 */

import { headerNames, namedPaths, namesOldSide } from './diff.ts'
import type { DiffSection } from './diff.ts'
import type { CredentialKind, SecretRule } from './types.ts'

/** The names of files that hold a secret, matched whole against a path's last segment, in any case. */
export const SECRET_NAMES: readonly string[] = Object.freeze([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  '.htpasswd',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
  'credentials.json',
  'secrets.json',
  'secrets.toml',
  'secrets.yaml',
  'secrets.yml',
])

/** A name that starts with this is a secret's: `.env.local`, and `.env.defaults`, which a loader reads as values at run time. In any case. */
export const SECRET_PREFIX = '.env.'

/** What the name of a file that holds a secret ends with, in any case. */
export const SECRET_SUFFIXES: readonly string[] = Object.freeze([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.kdbx',
  '.tfstate',
  '.tfstate.backup',
])

/** What ends the name of a template, after `SECRET_PREFIX`: `.env.example` is committed with no value in it, and is sent. In any case. */
export const TEMPLATE_SUFFIXES: readonly string[] = Object.freeze([
  '.example',
  '.sample',
  '.template',
  '.dist',
])

/** The directory of a Helm chart's templates: its `secrets.yaml` and `secrets.yml` are templates, not secrets. */
const HELM_TEMPLATES = 'templates'
const HELM_SECRET_TEMPLATES: readonly string[] = ['secrets.yaml', 'secrets.yml']

/** Every rule a file can be held by, in the order a reader lists them. */
export const SECRET_RULES = Object.freeze([
  'name',
  'private-key',
  'aws-key',
  'github-token',
  'slack-token',
  'google-key',
  'stripe-key',
  'anthropic-key',
  'openai-key',
] as const satisfies readonly SecretRule[])

/** What a kind of credential is called in a sentence, after "holds what reads as". */
export const CREDENTIAL_PHRASES: Readonly<Record<CredentialKind, string>> = Object.freeze({
  'private-key': 'a private key',
  'aws-key': 'an AWS key',
  'github-token': 'a GitHub token',
  'slack-token': 'a Slack token or webhook',
  'google-key': 'a Google API key',
  'stripe-key': 'a Stripe key',
  'anthropic-key': 'an Anthropic key',
  'openai-key': 'an OpenAI key',
})

/** One rule of gitleaks' default config: what it reads, and what makes a match no hit. */
export interface CredentialRule {
  /** The kind a hit of this rule reports. */
  readonly kind: CredentialKind
  /** The rule's id in gitleaks' config. */
  readonly id: string
  /** Gitleaks' regex, as JavaScript: its `(?i)` is the `i` flag. */
  readonly pattern: RegExp
  /** A match whose secret has an entropy at or below this is no hit; none when the rule has no floor. */
  readonly entropy?: number
  /** A match whose secret this matches is no hit: the rule's own allowlist. */
  readonly allow?: RegExp
  /** A line that holds none of these, in any case, runs no rule. */
  readonly keywords: readonly string[]
}

/* eslint-disable regexp/prefer-w, regexp/prefer-d, regexp/optimal-quantifier-concatenation -- gitleaks 8.30.1's patterns, kept as it ships them so they compare with its config */
/** The 21 rules of gitleaks 8.30.1 for AWS, GitHub, Slack, Google, Stripe, Anthropic and OpenAI, grouped by kind, in the order of `SECRET_RULES`. */
export const CREDENTIAL_RULES: readonly CredentialRule[] = Object.freeze([
  {
    kind: 'aws-key',
    id: 'aws-access-token',
    pattern: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/,
    entropy: 3,
    allow: /.+EXAMPLE$/,
    keywords: ['a3t', 'akia', 'asia', 'abia', 'acca'],
  },
  {
    kind: 'aws-key',
    id: 'aws-amazon-bedrock-api-key-long-lived',
    pattern: /\b(ABSK[A-Za-z0-9+/]{109,269}={0,2})(?:[\x60'"\s;]|\\[nr]|$)/,
    entropy: 3,
    keywords: ['absk'],
  },
  {
    kind: 'github-token',
    id: 'github-pat',
    pattern: /ghp_[0-9a-zA-Z]{36}/,
    entropy: 3,
    keywords: ['ghp_'],
  },
  {
    kind: 'github-token',
    id: 'github-fine-grained-pat',
    pattern: /github_pat_\w{82}/,
    entropy: 3,
    keywords: ['github_pat_'],
  },
  {
    kind: 'github-token',
    id: 'github-oauth',
    pattern: /gho_[0-9a-zA-Z]{36}/,
    entropy: 3,
    keywords: ['gho_'],
  },
  {
    kind: 'github-token',
    id: 'github-app-token',
    pattern: /(?:ghu|ghs)_[0-9a-zA-Z]{36}/,
    entropy: 3,
    keywords: ['ghu_', 'ghs_'],
  },
  {
    kind: 'github-token',
    id: 'github-refresh-token',
    pattern: /ghr_[0-9a-zA-Z]{36}/,
    entropy: 3,
    keywords: ['ghr_'],
  },
  {
    kind: 'slack-token',
    id: 'slack-bot-token',
    pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*/,
    entropy: 3,
    keywords: ['xoxb'],
  },
  {
    kind: 'slack-token',
    id: 'slack-user-token',
    pattern: /xox[pe](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}/,
    entropy: 2,
    keywords: ['xoxp-', 'xoxe-'],
  },
  {
    kind: 'slack-token',
    id: 'slack-app-token',
    pattern: /xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/i,
    entropy: 2,
    keywords: ['xapp'],
  },
  {
    kind: 'slack-token',
    id: 'slack-config-access-token',
    pattern: /xoxe.xox[bp]-\d-[A-Z0-9]{163,166}/i,
    entropy: 2,
    keywords: ['xoxe.xoxb-', 'xoxe.xoxp-'],
  },
  {
    kind: 'slack-token',
    id: 'slack-config-refresh-token',
    pattern: /xoxe-\d-[A-Z0-9]{146}/i,
    entropy: 2,
    keywords: ['xoxe-'],
  },
  {
    kind: 'slack-token',
    id: 'slack-legacy-bot-token',
    pattern: /xoxb-[0-9]{8,14}-[a-zA-Z0-9]{18,26}/,
    entropy: 2,
    keywords: ['xoxb'],
  },
  {
    kind: 'slack-token',
    id: 'slack-legacy-token',
    pattern: /xox[os]-\d+-\d+-\d+-[a-fA-F\d]+/,
    entropy: 2,
    keywords: ['xoxo', 'xoxs'],
  },
  {
    kind: 'slack-token',
    id: 'slack-legacy-workspace-token',
    pattern: /xox[ar]-(?:\d-)?[0-9a-zA-Z]{8,48}/,
    entropy: 2,
    keywords: ['xoxa', 'xoxr'],
  },
  {
    kind: 'slack-token',
    id: 'slack-webhook-url',
    pattern: /(?:https?:\/\/)?hooks.slack.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/,
    keywords: ['hooks.slack.com'],
  },
  {
    kind: 'google-key',
    id: 'gcp-api-key',
    pattern: /\b(AIza[\w-]{35})(?:[\x60'"\s;]|\\[nr]|$)/,
    entropy: 4,
    keywords: ['aiza'],
  },
  {
    kind: 'stripe-key',
    id: 'stripe-access-token',
    pattern: /\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\x60'"\s;]|\\[nr]|$)/,
    entropy: 2,
    keywords: [
      'sk_test',
      'sk_live',
      'sk_prod',
      'rk_test',
      'rk_live',
      'rk_prod',
    ],
  },
  {
    kind: 'anthropic-key',
    id: 'anthropic-api-key',
    pattern: /\b(sk-ant-api03-[a-zA-Z0-9_\-]{93}AA)(?:[\x60'"\s;]|\\[nr]|$)/,
    keywords: ['sk-ant-api03'],
  },
  {
    kind: 'anthropic-key',
    id: 'anthropic-admin-api-key',
    pattern: /\b(sk-ant-admin01-[a-zA-Z0-9_\-]{93}AA)(?:[\x60'"\s;]|\\[nr]|$)/,
    keywords: ['sk-ant-admin01'],
  },
  {
    kind: 'openai-key',
    id: 'openai-api-key',
    pattern: /\b(sk-(?:proj|svcacct|admin)-(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})T3BlbkFJ(?:[A-Za-z0-9_-]{74}|[A-Za-z0-9_-]{58})\b|sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20})(?:[\x60'"\s;]|\\[nr]|$)/,
    entropy: 3,
    keywords: ['t3blbkfj'],
  },
])
/* eslint-enable regexp/prefer-w, regexp/prefer-d, regexp/optimal-quantifier-concatenation */

/**
 * The private-key markers of pre-commit-hooks v5.0.0, matched as substrings, case and all. A source
 * that spells one holds itself, so each is built from pieces and none is contiguous here.
 */
const PRIVATE_KEY_MARKERS: readonly string[] = Object.freeze([
  ...[
    'RSA ',
    'DSA ',
    'EC ',
    'OPENSSH ',
    '',
    'SSH2 ENCRYPTED ',
    'ENCRYPTED ',
  ].map(kind => `BEGIN ${kind}PRIVATE KEY`),
  ['BEGIN PGP ', 'PRIVATE KEY BLOCK'].join(''),
  ['PuTTY-User-', 'Key-File-2'].join(''),
  ['BEGIN OpenVPN ', 'Static key V1'].join(''),
])

/** A text as a pattern that matches only it: the dot of a keyword is a dot, as gitleaks takes it. */
const escapeLiteral = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

/** The markers as one test. */
const MARKER = new RegExp(PRIVATE_KEY_MARKERS.map(escapeLiteral).join('|'))

/** How many lines after a marker one may hold the key's body. A PEM key's body follows its marker, and PuTTY's after three header lines. */
const BODY_REACH = 6
/** The fewest characters of a body run: a PEM line is 64 of them, and OpenVPN's is 32 hex digits. */
const BODY_RUN = 32

/** The keywords of every rule as one test, in any case: a line that holds none runs no rule, as gitleaks prefilters a fragment. */
const KEYWORDS = new RegExp([
  ...new Set(CREDENTIAL_RULES.flatMap(rule => rule.keywords)),
].map(escapeLiteral).join('|'), 'i')

/** Each rule's pattern with the `g` flag, to read every match of a line. */
const SCANNERS: ReadonlyArray<{ readonly rule: CredentialRule, readonly all: RegExp }> = CREDENTIAL_RULES.map(rule => ({
  rule,
  all: new RegExp(rule.pattern, `${rule.pattern.flags}g`),
}))

/** The last segment of a path, lower-cased, and the directory above it. */
function splitName(path: string): { name: string, parent: string } {
  const cut = path.lastIndexOf('/')
  const above = cut > 0
    ? path.lastIndexOf('/', cut - 1)
    : -1
  return {
    name: path.slice(cut + 1).toLowerCase(),
    parent: cut > 0
      ? path.slice(above + 1, cut)
      : '',
  }
}

/** Whether a name is a template that holds no value: `.env.example` and its kind, or a Helm chart's `secrets.yaml`. */
function isTemplate(name: string, parent: string): boolean {
  if (name.startsWith(SECRET_PREFIX)) return TEMPLATE_SUFFIXES.some(suffix => name.endsWith(suffix))
  return parent === HELM_TEMPLATES && HELM_SECRET_TEMPLATES.includes(name)
}

/**
 * Whether the name of a file is a secret's: its last segment is one of `SECRET_NAMES`, starts with
 * `SECRET_PREFIX` or ends in one of `SECRET_SUFFIXES`, in any case, and is no template (a `.env.` name
 * that ends in one of `TEMPLATE_SUFFIXES`, or a `secrets.yaml` or `secrets.yml` in a directory named
 * `templates`). It reads a path as the diff writes it, so an `a/` or `b/` prefix changes nothing.
 * Generous: only the name decides, never the directory, a template apart.
 */
export function isSecretName(path: string): boolean {
  const { name, parent } = splitName(path)
  if (isTemplate(name, parent)) return false
  return SECRET_NAMES.includes(name) || name.startsWith(SECRET_PREFIX) || SECRET_SUFFIXES.some(suffix => name.endsWith(suffix))
}

/** Whether a character code is one of the base64 alphabet: `A`-`Z`, `a`-`z`, `0`-`9`, `+`, `/` and `=`. */
function isBase64(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 43 || code === 47 || code === 61
}

/**
 * Whether a line holds a body run from `from` on: a maximal run of at least `BODY_RUN` characters of
 * the base64 alphabet that holds a digit and a letter. Any other character ends a run (a space, a tab,
 * a quote, a backslash, a comma, `\r`), so an indented, a quoted and a JSON-escaped body is read, and
 * code and prose are not: spaces and punctuation break their runs, and a long identifier has no
 * digit. One pass, each character looked at once.
 */
function holdsBodyRun(line: string, from = 0): boolean {
  let length = 0
  let digit = false
  let letter = false
  for (let at = from; at < line.length; at++) {
    const code = line.charCodeAt(at)
    if (!isBase64(code)) {
      length = 0
      digit = false
      letter = false
      continue
    }
    length++
    if (code >= 48 && code <= 57) digit = true
    else if (code >= 65) letter = true // `+`, `/` and `=` sit below `A`, so what is left up here is a letter
    if (length >= BODY_RUN && digit && letter) return true
  }
  return false
}

/**
 * The lines the markers' windows looked at: the last one read, and the last of them that holds a body
 * run. A line is read at most twice, whatever the markers: once as the tail of its own marker line, and
 * once in a window, so the search stays linear.
 */
interface BodySearch {
  scanned: number
  lastBody: number
}

/** Whether a line within `BODY_REACH` lines after `at` holds a body run, reading a line at most once in a window for all the markers of a text. */
function holdsBodyAfter(lines: readonly string[], at: number, search: BodySearch): boolean {
  const last = Math.min(at + BODY_REACH, lines.length - 1)
  for (let next = Math.max(search.scanned, at) + 1; next <= last; next++) {
    if (holdsBodyRun(lines[next] ?? '')) search.lastBody = next
    search.scanned = next
  }
  return search.lastBody > at
}

/**
 * Whether the line at `at` holds a marker with a body run after it: on its own line, read once from the
 * end of its first marker, or on one of the next `BODY_REACH` lines.
 */
function isPrivateKeyAt(lines: readonly string[], at: number, search: BodySearch): boolean {
  const line = lines[at] ?? ''
  const marker = MARKER.exec(line)
  if (marker === null) return false
  return holdsBodyRun(line, marker.index + marker[0].length) || holdsBodyAfter(lines, at, search)
}

/** The Shannon entropy of a text in bits per character, over its code points, as gitleaks measures a secret. */
function entropyOf(text: string): number {
  const counts = new Map<string, number>()
  let length = 0
  for (const character of text) {
    counts.set(character, (counts.get(character) ?? 0) + 1)
    length++
  }
  let entropy = 0
  for (const count of counts.values()) {
    const share = count / length
    entropy -= share * Math.log2(share)
  }
  return entropy
}

/** The part of a match gitleaks judges: its first non-empty capture group, else the whole match. */
function secretOf(match: RegExpMatchArray): string {
  return match.slice(1).find(group => group !== undefined && group !== '') ?? match[0]
}

/** The kind of the first match on a line that a rule keeps: every match of every rule, in the table's order. */
function ruleHitOn(line: string): CredentialKind | undefined {
  if (!KEYWORDS.test(line)) return undefined
  for (const { rule, all } of SCANNERS) {
    for (const match of line.matchAll(all)) {
      const secret = secretOf(match)
      if (rule.entropy !== undefined && entropyOf(secret) <= rule.entropy) continue
      if (rule.allow?.test(secret)) continue
      return rule.kind
    }
  }
  return undefined
}

/**
 * The kind of the first credential a text holds, read line by line as gitleaks reads a fragment, or
 * undefined. A line is first tested for a private-key marker, which counts only when a body run
 * follows it, on its own line or within `BODY_REACH` lines; then, when it holds a keyword of the rules, for each rule in
 * the table's order and every match of it on the line, a match whose secret has an entropy at or below
 * the rule's floor, or that the rule's own allowlist matches, being no hit. It reads every row alike
 * (added, removed, context, or none), a line of any length and a line that ends with `\r`, and it is
 * linear in the text. Generous: a removed line and a key in a comment hold as any other.
 */
export function credentialIn(text: string): CredentialKind | undefined {
  const lines = text.split('\n')
  const search: BodySearch = { scanned: -1, lastBody: -1 }
  for (let at = 0; at < lines.length; at++) {
    if (isPrivateKeyAt(lines, at, search)) return 'private-key'
    const kind = ruleHitOn(lines[at] ?? '')
    if (kind !== undefined) return kind
  }
  return undefined
}

/**
 * Why a section is held back, or undefined: `name` when its header's path (a non-empty one), a name
 * its `diff --git` line holds (each word of it, so a header that cannot be read, or that is forged as
 * `diff --git a/.env` or `diff --git a/.env b/.env c`, still names the `.env` it spells), or a path its
 * own lines name is a secret's, else the kind of the first credential its text holds. The name is
 * taken before the content, so a `.env` is held by its name whatever it holds. Generous: any one path
 * the section names, a rename's old side included, holds it.
 */
export function secretRuleOf(section: DiffSection): SecretRule | undefined {
  const { path, text } = section
  const headerNamed = path !== undefined && path !== '' && isSecretName(path)
  return headerNamed || headerNames(text).some(isSecretName) || namedPaths(text).some(named => isSecretName(named))
    ? 'name'
    : credentialIn(text)
}

const GIT_HEADER = 'diff --git '
const DELETED_MODE = 'deleted file mode '
/** What opens the line that names the old side of a file. */
const OLD_SIDE = '--- '
/** A hunk header whose new side is empty: the lines it counts are all removed. */
const EMPTIED_HUNK = /^@@ -\d+(?:,\d+)? \+0,0 @@/

/** Whether a line, less its `\r`, is one git writes in the diff of a file it deletes whole, after the header. */
function isDeletionLine(line: string): boolean {
  return line.startsWith(DELETED_MODE)
    || line.startsWith('index ')
    || line.startsWith('-')
    || line === '+++ /dev/null'
    || line === '\\ No newline at end of file'
    || (line.startsWith('Binary files ') && line.endsWith(' and /dev/null differ'))
    || EMPTIED_HUNK.test(line)
}

/**
 * Whether a section deletes its file whole: it starts with its `diff --git` header, holds a `deleted
 * file mode` line, and every other line of it is one git writes for a deletion: `deleted file mode`,
 * `index`, a `-` row (the `---` line is one), `+++ /dev/null`, `Binary files <path> and /dev/null
 * differ`, a hunk header whose new side is `+0,0`, `\ No newline at end of file`, and an empty last
 * piece, each less a trailing `\r`. Any other line (a `+` or context row, a blank line in the
 * middle, a mail's headers in a `format-patch` series, a `GIT binary patch`) makes it no whole
 * deletion, so a forged or mixed section is a gap and never passes as one, and a file truncated to
 * empty, which has no `deleted file mode`, is no deletion. Its first `--- ` line, when it has one (an
 * empty or a binary file has none), also names the old side of a header that names one path on both
 * sides (`namesOldSide`): a `.env` header over a `--- a/src/auth.ts` line is a forged section that
 * would hide the removal of another file, so it is no deletion and a gap. Only the first such line
 * counts: a later one is a removed row of the file.
 */
export function isWholeDeletion(text: string): boolean {
  const [header, ...rest] = text.split('\n')
  if (!header?.startsWith(GIT_HEADER)) return false
  let deletesFile = false
  let oldSideChecked = false
  for (const [at, raw] of rest.entries()) {
    const line = raw.endsWith('\r')
      ? raw.slice(0, -1)
      : raw
    const allowed = line === ''
      ? at === rest.length - 1
      : isDeletionLine(line)
    if (!allowed) return false
    if (line.startsWith(DELETED_MODE)) deletesFile = true
    if (!oldSideChecked && line.startsWith(OLD_SIDE)) {
      if (!namesOldSide(header, line)) return false
      oldSideChecked = true
    }
  }
  return deletesFile
}
