import { describe, expect, it } from 'vitest'
import { ConfigError } from '../core/errors.ts'
import { DIFF_PINS, GitError, MAX_GIT_OUTPUT_BYTES } from '../git/run.ts'
import { fakeGit } from '../testing/git.ts'
import type { GitCall, GitReply } from '../testing/git.ts'
import { rangeSource } from './range.ts'
import type { SourceContext } from './read.ts'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const MERGE = 'c'.repeat(40)
const DIFF = 'diff --git a/a.js b/a.js\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-safe()\n+exec(cmd)\n'

/** What the fake git says of a range: each side's commit, the merge base and the diff, any of them replaced. */
interface Replies {
  readonly base?: GitReply
  readonly head?: GitReply
  readonly mergeBase?: GitReply
  readonly diff?: GitReply
}

function reply(replies: Replies = {}): (call: GitCall) => GitReply | undefined {
  return ({ command }) => {
    if (command[0] === 'rev-parse' && command[1] === '--verify') {
      if (command[4] === 'main^{commit}') return replies.base ?? { stdout: `${BASE}\n` }
      if (command[4] === 'feature^{commit}') return replies.head ?? { stdout: `${HEAD}\n` }
    }
    if (command[0] === 'merge-base') return replies.mergeBase ?? { stdout: `${MERGE}\n` }
    if (command[1] === 'diff') return replies.diff ?? { stdout: DIFF }
    return undefined
  }
}

function contextOf(fake: ReturnType<typeof fakeGit>, extra: Partial<SourceContext> = {}): SourceContext {
  return {
    cwd: '/repo/sub',
    env: {},
    platform: 'linux',
    git: { executable: '/usr/bin/git', spawn: fake.spawn },
    ...extra,
  }
}

/** The `ConfigError` a promise rejects with. */
async function refusal(promise: Promise<unknown>): Promise<ConfigError> {
  const error: unknown = await promise.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ConfigError)
  return error as ConfigError
}

describe('the range source', () => {
  it.each([
    ['', '--range: must name a range, written <base>...<head>'],
    ['main', '--range: must be written <base>...<head>: a single revision names no range'],
    ['main..feature', '--range: must be written <base>...<head>, with three dots: <base>..<head> compares the two ends, and shows what <base> gained since as removed'],
    ['...feature', '--range: must name a revision on each side of ...'],
    ['main...', '--range: must name a revision on each side of ...'],
    ['-x...feature', '--range: a revision may not start with -'],
    ['main...-y', '--range: a revision may not start with -'],
    ['a...b...c', '--range: must hold one ... between two revisions'],
  ])('refuses --range %j before any git runs', async (range, message) => {
    const fake = fakeGit(reply())
    const error = await refusal(rangeSource(range, contextOf(fake)))
    expect(error.message).toBe(message)
    expect(error.issues).toEqual([
      {
        path: '--range',
        message: message.slice('--range: '.length),
      },
    ])
    expect(fake.calls).toEqual([])
  })

  it('resolves both sides, finds the merge base and diffs it with the head, attributes from the base', async () => {
    const fake = fakeGit(reply())
    const read = await rangeSource('main...feature', contextOf(fake))

    expect(fake.calls.map(call => call.command)).toEqual([
      ['--version'],
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--show-prefix'],
      ['rev-parse', '--absolute-git-dir'],
      ['rev-parse', '--absolute-git-dir'],
      ['rev-parse', '--show-object-format'],
      [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        'main^{commit}',
      ],
      [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        'feature^{commit}',
      ],
      ['merge-base', BASE, HEAD],
      [
        `--attr-source=${BASE}`,
        'diff',
        ...DIFF_PINS,
        '--ignore-submodules=none',
        MERGE,
        HEAD,
        '--',
      ],
    ])
    expect(new Set(fake.calls.map(call => call.file))).toEqual(new Set(['/usr/bin/git']))
    expect(fake.calls.map(call => call.cwd)).toEqual(Array.from({ length: 10 }).fill('/repo/sub'))
    expect(read).toEqual({
      diff: DIFF,
      source: {
        kind: 'range',
        base: BASE,
        mergeBase: MERGE,
        head: HEAD,
        objectFormat: 'sha1',
      },
      leftOut: [],
    })
  })

  it('decodes the diff as decodeDiff does: a byte that is not UTF-8 becomes U+FFFD', async () => {
    const bytes = Buffer.concat([
      Buffer.from('diff --git a/x b/x\n+'),
      Uint8Array.of(0xFF, 0xC3),
      Buffer.from('\n'),
    ])
    const fake = fakeGit(reply({
      diff: { stdout: bytes },
    }))
    const read = await rangeSource('main...feature', contextOf(fake))
    expect(read.diff).toBe(`diff --git a/x b/x\n+${String.fromCharCode(0xFFFD, 0xFFFD)}\n`)
  })

  it.each([
    [
      'base names no commit',
      {
        base: { code: 1 },
      },
      'its base names no commit of this repository: fetch it first, as actions/checkout does with fetch-depth: 0',
      7,
    ],
    [
      'head names no commit',
      {
        head: { code: 1 },
      },
      'its head names no commit of this repository',
      8,
    ],
    [
      'two sides are one commit',
      {
        head: { stdout: `${BASE}\n` },
      },
      'its two sides are one commit, so it names nothing to review',
      8,
    ],
    [
      'sides share no history',
      {
        mergeBase: { code: 1 },
      },
      'its two sides share no history in this clone: fetch the base\'s history, as actions/checkout does with fetch-depth: 0',
      9,
    ],
    [
      'diff is over 16 MiB',
      {
        diff: {
          stdout: new Uint8Array(MAX_GIT_OUTPUT_BYTES + 1),
        },
      },
      'its diff is over 16 MiB, the most quorum reads: review a shorter range',
      10,
    ],
  ] satisfies Array<[string, Replies, string, number]>)('refuses a range whose %s', async (_name, replies, message, calls) => {
    const fake = fakeGit(reply(replies))
    const error = await refusal(rangeSource('main...feature', contextOf(fake)))
    expect(error.message).toBe(`--range: ${message}`)
    expect(error.message).not.toMatch(/main|feature/)
    expect(fake.calls).toHaveLength(calls)
  })

  it('rejects with the GitError of a diff that fails', async () => {
    const fake = fakeGit(reply({
      diff: { code: 128, stderr: 'fatal: bad object\n' },
    }))
    const error: unknown = await rangeSource('main...feature', contextOf(fake)).then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(GitError)
    expect(error).toMatchObject({ message: 'git diff failed (exit 128): "fatal: bad object"', operation: 'diff', exitCode: 128 })
  })

  it('reviews an empty range as an empty diff', async () => {
    const fake = fakeGit(reply({
      mergeBase: { stdout: `${HEAD}\n` },
      diff: { stdout: '' },
    }))
    await expect(rangeSource('main...feature', contextOf(fake))).resolves.toEqual({
      diff: '',
      source: {
        kind: 'range',
        base: BASE,
        mergeBase: HEAD,
        head: HEAD,
        objectFormat: 'sha1',
      },
      leftOut: [],
    })
  })

  it('refuses every git source on Windows before any spawn', async () => {
    const fake = fakeGit(reply())
    const error = await refusal(rangeSource('main...feature', contextOf(fake, { platform: 'win32' })))
    expect(error.message).toBe('--range: the git sources run on Linux and macOS: on Windows, pipe a diff in')
    expect(fake.calls).toEqual([])
  })

  it('refuses when no git is on PATH', async () => {
    for (const env of [
      {},
      { PATH: '' },
      { PATH: 'relative/bin' },
    ]) {
      const error = await refusal(rangeSource('main...feature', { cwd: '/repo', env, platform: 'linux' }))
      expect(error.message).toBe('--range: needs git 2.41 or later on PATH, and none was found: install it, or pipe a diff in')
    }
  })
})
