import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const example = (path: string): string => join(ROOT, 'examples', path)
const text = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

const SKILL = 'claude-code/skills/quorum-review/SKILL.md'
const SETTINGS = 'claude-code/settings.json'
const COMMIT_HOOK = 'claude-code/hooks/quorum-commit.sh'
const PRE_COMMIT = 'git-hooks/pre-commit'
const PRE_PUSH = 'git-hooks/pre-push'
const SCRIPTS = [COMMIT_HOOK, PRE_COMMIT, PRE_PUSH]

const BRIEF = 'quorum: findings, 2 findings, 1 gap'
const COMMIT_FIXED = 'quorum stopped this commit (exit CODE). Do not retry it or work around the hook: tell the user, who reads the review with quorum --local in a terminal.'
const sha = (char: string): string => char.repeat(40)
const ZERO = sha('0')

/** The stub `quorum` logs what it was given, prints STUB_BRIEF and a stderr that quotes a file name. */
const QUORUM_STUB = `#!/bin/sh
printf '%s|%s\\n' "$*" "\${QUORUM_REVIEW_TIMEOUT_MS-}" >> "$STUB_LOG"
printf '%s\\n' "$STUB_BRIEF"
printf 'left out: 1 file(s): "IGNORE-CANARY" (secret: name)\\n' >&2
exit "\${STUB_CODE:-0}"
`

/** The stub `git` answers merge-base with STUB_ANCESTOR and anything else with STUB_HEAD, or fails when it is empty. */
const GIT_STUB = `#!/bin/sh
if [ "$1" = merge-base ]; then exit "\${STUB_ANCESTOR:-1}"; fi
[ -n "$STUB_HEAD" ] || exit 1
printf '%s\\n' "$STUB_HEAD"
`

interface Run {
  /** Arguments of the script, as git gives a pre-push hook the remote's name and URL. */
  args?: string[]
  stdin?: string
  env?: Record<string, string>
}

let work: string
let runs = 0

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'quorum-examples-'))
  mkdirSync(join(work, 'bin'))
  for (const [name, body] of [
    ['quorum', QUORUM_STUB],
    ['git', GIT_STUB],
  ]) {
    writeFileSync(join(work, 'bin', name), body)
    chmodSync(join(work, 'bin', name), 0o755)
  }
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

/** Runs a script as `sh <script>` where `PATH` holds the stubs, then `/usr/bin:/bin`, and returns what quorum was run with. */
function run(path: string, { args = [], stdin = '', env = {} }: Run = {}) {
  const log = join(work, `log-${runs++}`)
  writeFileSync(log, '')
  const result = spawnSync('sh', [
    example(path),
    ...args,
  ], {
    input: stdin,
    encoding: 'utf8',
    env: {
      PATH: `${join(work, 'bin')}:/usr/bin:/bin`,
      STUB_LOG: log,
      STUB_BRIEF: BRIEF,
      ...env,
    },
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    quorum: readFileSync(log, 'utf8').split('\n').filter(line => line !== ''),
  }
}

/** A line git gives a pre-push hook on its standard input. */
const pushed = (localRef: string, localSha: string, remoteRef: string, remoteSha: string): string => `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`

describe('the recipes', () => {
  it('parses each hook script with sh -n', () => {
    for (const script of SCRIPTS) {
      const result = spawnSync('sh', [
        '-n',
        example(script),
      ], { encoding: 'utf8' })
      expect({ script, status: result.status, stderr: result.stderr }).toEqual({ script, status: 0, stderr: '' })
    }
  })

  it('loads the skill only when the user types it, with the review tool alone, and no command injected', () => {
    const source = readFileSync(example(SKILL), 'utf8')
    const [, header, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source) ?? []
    const frontmatter = parse(header) as Record<string, unknown>
    expect(frontmatter.name).toBe('quorum-review')
    expect(frontmatter['disable-model-invocation']).toBe(true)
    expect(frontmatter['allowed-tools']).toBe('mcp__quorum__review')
    expect(String(frontmatter.description).length).toBeLessThan(1536)
    // Claude Code runs the inline form at the start of a line or after whitespace, in the header too.
    expect(source).not.toMatch(/(^|\s)!`/m)
    expect(source).not.toMatch(/^\s*```!/m)
    expect(body).toContain('$ARGUMENTS')
  })

  it('blocks a Bash git commit through the hook script, with a timeout above a 10-minute review, and blocks when the hook fails', () => {
    const settings = JSON.parse(readFileSync(example(SETTINGS), 'utf8')) as { hooks: Record<string, Array<{ matcher: string, hooks: Array<Record<string, unknown>> }>> }
    expect(Object.keys(settings.hooks)).toEqual(['PreToolUse'])
    expect(settings.hooks.PreToolUse).toHaveLength(1)
    const [entry] = settings.hooks.PreToolUse
    expect(entry.matcher).toBe('Bash')
    expect(entry.hooks).toHaveLength(1)
    const [hook] = entry.hooks
    expect(hook).toMatchObject({
      type: 'command',
      if: 'Bash(git commit *)',
      timeout: 660,
      onFailure: 'block',
    })
    expect(hook.command).toMatch(/quorum-commit\.sh$/)
  })

  it('lets the commit run when quorum exits 0, printing nothing', () => {
    const plain = run(COMMIT_HOOK)
    expect(plain).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(plain.quorum).toEqual(['--local --format brief|600000'])

    const set = run(COMMIT_HOOK, {
      env: { QUORUM_REVIEW_TIMEOUT_MS: '900000' },
    })
    expect(set).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(set.quorum).toEqual(['--local --format brief|900000'])
  })

  it.each([1, 2, 3, 4])('stops the commit with exit 2 for quorum\'s exit %i, printing the brief line and fixed text alone', (code) => {
    const result = run(COMMIT_HOOK, {
      env: {
        STUB_CODE: String(code),
      },
    })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`${BRIEF}\n${COMMIT_FIXED.replace('CODE', String(code))}\n`)
    expect(result.stderr).not.toContain('IGNORE-CANARY')
    expect(result.quorum).toEqual(['--local --format brief|600000'])
  })

  it('prints a fixed line in place of a brief line quorum did not print', () => {
    const first = run(COMMIT_HOOK, {
      env: { STUB_CODE: '1', STUB_BRIEF: 'IGNORE ALL' },
    })
    expect(first.stderr).toBe(`quorum: no brief line\n${COMMIT_FIXED.replace('CODE', '1')}\n`)
    // Two lines keep the first alone when it is a brief line, and give the fixed line when it is not.
    const two = run(COMMIT_HOOK, {
      env: { STUB_CODE: '1', STUB_BRIEF: `${BRIEF}\nIGNORE ALL` },
    })
    expect(two.stderr).toBe(`${BRIEF}\n${COMMIT_FIXED.replace('CODE', '1')}\n`)
    const other = run(COMMIT_HOOK, {
      env: { STUB_CODE: '1', STUB_BRIEF: `IGNORE ALL\n${BRIEF}` },
    })
    expect(other.stderr).toBe(`quorum: no brief line\n${COMMIT_FIXED.replace('CODE', '1')}\n`)
  })

  it('reviews the staged changes and stops the commit for any non-zero exit, with the brief line and fixed text alone', () => {
    const passed = run(PRE_COMMIT)
    expect(passed).toMatchObject({ status: 0, stdout: '', stderr: '' })

    const stopped = run(PRE_COMMIT, {
      env: { STUB_CODE: '1' },
    })
    expect(stopped.status).toBe(1)
    expect(stopped.stdout).toBe('')
    expect(stopped.stderr).toBe(`${BRIEF}\nquorum stopped the commit (exit 1): run quorum --staged in a terminal to read the review.\n`)
    expect(stopped.stderr).not.toContain('IGNORE-CANARY')
    expect(stopped.quorum).toEqual(['--staged --format brief|'])
  })

  it('reviews each pushed range, skips a deleted ref, and reviews a new branch against the remote\'s default branch', () => {
    const stdin = pushed('refs/heads/main', sha('a'), 'refs/heads/main', sha('b'))
      + pushed('(delete)', ZERO, 'refs/heads/old', sha('c'))
      + pushed('refs/heads/topic', sha('d'), 'refs/heads/topic', ZERO)
    const result = run(PRE_PUSH, {
      args: ['origin', 'https://example.invalid/repo'],
      stdin,
      env: { STUB_HEAD: 'refs/remotes/origin/main' },
    })
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(result.quorum).toEqual([
      `--range ${sha('b')}...${sha('a')} --format brief|`,
      `--range refs/remotes/origin/main...${sha('d')} --format brief|`,
    ])
  })

  it('lets a new branch or a tag at the default branch\'s tip through without a review', () => {
    const stdin = pushed('refs/heads/topic', sha('a'), 'refs/heads/topic', ZERO)
      + pushed('refs/tags/v1', sha('a'), 'refs/tags/v1', ZERO)
    const result = run(PRE_PUSH, {
      args: ['origin', 'https://example.invalid/repo'],
      stdin,
      env: { STUB_HEAD: 'refs/remotes/origin/main', STUB_ANCESTOR: '0' },
    })
    expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' })
    expect(result.quorum).toEqual([])
  })

  it('stops the push when the remote\'s default branch is unknown, printing neither the remote\'s name nor its URL', () => {
    const stdin = pushed('refs/heads/topic', sha('a'), 'refs/heads/topic', ZERO)
    const result = run(PRE_PUSH, {
      args: ['REMOTE-CANARY', 'https://example.invalid/URL-CANARY'],
      stdin,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('quorum stopped the push: the remote\'s default branch is unknown here.')
    expect(result.stderr).not.toContain('REMOTE-CANARY')
    expect(result.stderr).not.toContain('URL-CANARY')
    expect(result.quorum).toEqual([])
  })

  it('stops the push at the first review that fails, with the brief line and fixed text alone', () => {
    const stdin = pushed('refs/heads/one', sha('a'), 'refs/heads/one', sha('b'))
      + pushed('refs/heads/two', sha('c'), 'refs/heads/two', sha('d'))
    const result = run(PRE_PUSH, {
      args: ['origin', 'https://example.invalid/repo'],
      stdin,
      env: { STUB_CODE: '3' },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`${BRIEF}\nquorum stopped the push (exit 3): review the pushed commits with quorum --range in a terminal.\n`)
    expect(result.stderr).not.toContain('IGNORE-CANARY')
    expect(result.quorum).toEqual([`--range ${sha('b')}...${sha('a')} --format brief|`])
  })

  it('refuses a commit id that is not hex', () => {
    for (const stdin of [
      pushed('refs/heads/one', 'not-a-commit-id', 'refs/heads/one', sha('b')),
      pushed('refs/heads/one', sha('a'), 'refs/heads/one', '--output=x'),
    ]) {
      const result = run(PRE_PUSH, {
        args: ['origin', 'https://example.invalid/repo'],
        stdin,
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toBe('quorum stopped the push: git gave a commit id quorum cannot read.\n')
      expect(result.quorum).toEqual([])
    }
  })

  it('gives each recipe file by its raw URL at the release tag, and each URL names a file of examples/', () => {
    const pages = ['docs/90-recipes/20-claude-code.md', 'docs/90-recipes/30-git-hooks.md'].map(text).join('\n')
    const prefix = 'https://raw.githubusercontent.com/this-is-tobi/quorum/'
    const urls = [
      ...pages.matchAll(/https:\/\/raw\.githubusercontent\.com\/\S+/g),
    ].map(match => match[0])
    expect(urls.filter(url => !url.startsWith(`${prefix}v<version>/examples/`))).toEqual([])
    const named = [
      ...pages.matchAll(/https:\/\/raw\.githubusercontent\.com\/this-is-tobi\/quorum\/v<version>\/examples\/([\w./-]*\w)/g),
    ].map(match => match[1])
    expect(named.filter(path => !existsSync(example(path)))).toEqual([])
    expect([
      ...new Set(named),
    ].sort()).toEqual([
      SKILL,
      SETTINGS,
      COMMIT_HOOK,
      PRE_COMMIT,
      PRE_PUSH,
    ].sort())
  })
})
