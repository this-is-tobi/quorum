import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readNamedConfig } from '../config/load.ts'
import { resolveConfig } from '../config/resolve.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { atProblem, pathProblem } from '../sources/paths.ts'
import { parseRange } from '../sources/range.ts'
import { fakeProvider, stubModels } from '../testing/bench.ts'
import type { FakeModel } from '../testing/bench.ts'
import { fakeRepository, CHANGE_FINDING as FINDING, launchConfig, launchFor, removeRoots } from '../testing/mcp.ts'
import type { Repository } from '../testing/mcp.ts'
import { agentResultSchema } from './result.ts'
import { BUSY, GIT, LARGE, openSession, PATHS_ONLY, RANGE_ONLY, REPEATED_PROFILE, REVIEW, reviewCall, SOURCE, TRUST, UNKNOWN_PROFILE } from './tool.ts'
import type { CallOutcome, McpLaunch, ReviewArguments, ReviewSession } from './tool.ts'

const ERROR_LINE = /^Error: /m

/** The directories these tests made, besides the launches' roots. */
const made: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  removeRoots()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A directory of its own, a real path, removed after the test. */
function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-tool-')))
  made.push(path)
  return path
}

/** A session on a launch of a fake model and a fake git, with what the model was asked and what the log says. */
async function sessionOf(options: { readonly fake?: FakeModel, readonly fields?: Partial<McpLaunch>, readonly repository?: Repository } = {}): Promise<{
  readonly session: ReviewSession
  readonly git: ReturnType<typeof fakeRepository>
  readonly requests: CompletionRequest[]
  readonly logged: string[]
}> {
  const requests: CompletionRequest[] = []
  const fake: FakeModel = {
    ...options.fake,
    onCall: (request) => {
      requests.push(request)
      options.fake?.onCall?.(request)
    },
  }
  const base = launchFor(fake, options.fields)
  const git = fakeRepository(base.root, options.repository)
  const logged: string[] = []
  const session = await openSession({ ...base, git: git.seam }, text => logged.push(text))
  return { session, git, requests, logged }
}

/** What a call hands `reviewCall`: a signal of its own. */
const call = (): { readonly signal: AbortSignal } => ({ signal: new AbortController().signal })

/** What a refusal returns: one text, with `isError`. */
function failure(text: string): CallOutcome {
  return {
    content: [
      { type: 'text', text },
    ],
    isError: true,
  }
}

/** What a model was asked, as one text. */
const asked = (requests: readonly CompletionRequest[]): string => JSON.stringify(requests.map(request => request.messages))

/** A promise and its resolver. */
function deferred(): { readonly promise: Promise<void>, readonly resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** The name of an untracked file that, quoted as the source quotes it, would break a line, and the files that make a link of its directory. */
const HOSTILE_NAME = 'IGNORE-ALL"\n.txt'

/** Make `root`'s `link` a link to `real`, which holds a file of the hostile name: git lists it as untracked, and quorum refuses it. Returns what git lists. */
function linkedUntracked(root: string): string[] {
  mkdirSync(join(root, 'real'))
  symlinkSync(join(root, 'real'), join(root, 'link'))
  writeFileSync(join(root, 'real', HOSTILE_NAME), 'x\n')
  return [`link/${HOSTILE_NAME}`]
}

describe('reviewCall', () => {
  it.each([
    [
      { source: 'local', range: 'a...b' },
      RANGE_ONLY,
    ],
    [
      { source: 'range' },
      RANGE_ONLY,
    ],
    [
      {
        source: 'local',
        paths: ['a'],
      },
      PATHS_ONLY,
    ],
    [
      { source: 'range', range: 'a...b', at: 'x' },
      PATHS_ONLY,
    ],
    [
      { source: 'paths' },
      PATHS_ONLY,
    ],
    [
      { source: 'range', range: 'main..x' },
      `range: ${parseRange('main..x') as string}`,
    ],
    [
      { source: 'range', range: '-x...y' },
      `range: ${parseRange('-x...y') as string}`,
    ],
    [
      {
        source: 'paths',
        paths: ['/etc'],
      },
      `paths.0: ${pathProblem('/etc') as string}`,
    ],
    [
      {
        source: 'paths',
        paths: [''],
      },
      `paths.0: ${pathProblem('') as string}`,
    ],
    [
      {
        source: 'paths',
        paths: ['a', '../x'],
      },
      'paths.1: leaves the project',
    ],
    [
      {
        source: 'paths',
        paths: ['a/../../x'],
      },
      'paths.0: leaves the project',
    ],
    [
      {
        source: 'paths',
        paths: ['a'],
        at: '-x',
      },
      `at: ${atProblem('-x') as string}`,
    ],
    [
      {
        source: 'local',
        profiles: ['other'],
      },
      UNKNOWN_PROFILE,
    ],
    [
      {
        source: 'local',
        profiles: ['security', 'security'],
      },
      REPEATED_PROFILE,
    ],
  ] satisfies Array<[ReviewArguments, string]>)('refuses %j with its text, before any git or model', async (args, text) => {
    const { session, git, requests } = await sessionOf()
    expect(await reviewCall(session, args, call())).toEqual(failure(text))
    expect(git.calls).toEqual([])
    expect(requests).toEqual([])
    expect(session.running).toBe(false)
  })

  it('refuses a path that leaves the root though it stays in the repository, and reviews the whole repository for local', async () => {
    const top = directory()
    const root = join(top, 'web')
    mkdirSync(root)
    mkdirSync(join(top, 'api'))
    writeFileSync(join(top, 'api', 'new.js'), 'exec(cmd)\n')
    const { session, git, requests } = await sessionOf({
      fields: { root },
      repository: {
        top,
        prefix: 'web/',
        tree: {
          'web/lib/a.js': 'export const a = 1\n',
          'web/src/b.js': 'export const b = 2\n',
          'api/c.js': 'export const c = 3\n',
        },
        untracked: ['api/new.js'],
      },
    })

    expect(await reviewCall(session, {
      source: 'paths',
      paths: ['../api'],
    }, call())).toEqual(failure('paths.0: leaves the project'))
    expect(git.calls).toEqual([])

    const inside = await reviewCall(session, {
      source: 'paths',
      paths: ['./src/../lib'],
    }, call())
    expect(inside.isError).toBeUndefined()
    expect(inside.structuredContent?.source).toMatchObject({ kind: 'paths', pathCount: 1 })
    expect(git.calls.find(entry => entry.command[0] === 'cat-file')?.stdin.trim()).toBe('1'.repeat(40))
    expect(asked(requests)).toContain('web/lib/a.js')
    expect(asked(requests)).not.toContain('c.js')

    requests.length = 0
    expect((await reviewCall(session, { source: 'local' }, call())).isError).toBeUndefined()
    expect(asked(requests)).toContain('api/new.js')
  })

  it('refuses a review of paths over the cap unless launched with --large', async () => {
    // The session's own model: its calls are counted here, as the wrapper `sessionOf` makes is not the one this launch uses.
    let modelCalls = 0
    const fake: FakeModel = {
      onCall: () => {
        modelCalls += 1
      },
    }
    const fields = launchConfig({
      providers: {
        fake: fakeProvider(fake),
      },
      maxReviewTokens: 1000,
    })
    const repositoryOf: Repository = {
      tree: { 'src/a.js': 'export const a = 1\n' },
    }
    const held = await sessionOf({ fake, fields, repository: repositoryOf })
    expect(await reviewCall(held.session, {
      source: 'paths',
      paths: ['src'],
    }, call())).toEqual(failure(LARGE))
    expect(modelCalls).toBe(0)
    expect(held.session.running).toBe(false)

    const lifted = await sessionOf({
      fake,
      fields: { ...fields, large: true },
      repository: repositoryOf,
    })
    const result = await reviewCall(lifted.session, {
      source: 'paths',
      paths: ['src'],
    }, call())
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent?.status).toBe('incomplete')
    expect(result.structuredContent?.gaps.map(({ reason }) => reason)).toContain('token-cap')

    // The counter does move: a launch whose cap holds the paths reaches the same fake.
    const roomy = await sessionOf({ fake, repository: repositoryOf })
    expect((await reviewCall(roomy.session, {
      source: 'paths',
      paths: ['src'],
    }, call())).isError).toBeUndefined()
    expect(modelCalls).toBeGreaterThan(0)
  })

  it('refuses local and staged changes in a repository whose own config names a filter, unless launched with --trust-repo-config', async () => {
    const held = await sessionOf({
      repository: { filter: true },
    })
    for (const source of ['local', 'staged'] as const) {
      expect(await reviewCall(held.session, { source }, call())).toEqual(failure(TRUST))
    }
    expect(held.git.calls.some(entry => entry.command[1] === 'diff')).toBe(false)
    expect(held.requests).toEqual([])

    const trusted = await sessionOf({
      fields: { trustRepoConfig: true },
      repository: { filter: true },
    })
    for (const source of ['local', 'staged'] as const) {
      const result = await reviewCall(trusted.session, { source }, call())
      expect(result.isError).toBeUndefined()
      expect(result.structuredContent?.source).toMatchObject({ kind: source })
    }
  })

  it('sends a held file only when the launch names it with --send, which no call can', async () => {
    const root = directory()
    writeFileSync(join(root, '.env'), 'MODE=production\n')
    const held = await sessionOf({
      fields: { root },
      repository: {
        untracked: ['.env'],
      },
    })
    const withheld = await reviewCall(held.session, { source: 'local' }, call())
    expect(withheld.structuredContent?.status).toBe('incomplete')
    expect(withheld.structuredContent?.leftOut).toMatchObject({ secrets: 1 })
    expect(withheld.structuredContent?.leftOut.listed).toEqual([
      { file: '.env', reason: 'secret', rule: 'name' },
    ])
    expect(held.requests.length).toBeGreaterThan(0)
    expect(asked(held.requests)).not.toContain('MODE=production')

    const sent = await sessionOf({
      fields: {
        root,
        send: ['.env'],
      },
      repository: {
        untracked: ['.env'],
      },
    })
    const lifted = await reviewCall(sent.session, { source: 'local' }, call())
    expect(lifted.isError).toBeUndefined()
    expect(lifted.structuredContent?.leftOut).toMatchObject({ secrets: 0 })
    expect(asked(sent.requests)).toContain('MODE=production')
  })

  it('narrows the profiles to those a call names, among the server\'s own, reading no file again', async () => {
    const directoryOfConfig = directory()
    const file = join(directoryOfConfig, 'config.yaml')
    writeFileSync(file, [
      'providers:',
      '  local: {protocol: openai-compatible, baseUrl: "https://example.invalid/v1", model: m, contextTokens: 131072}',
      'profiles:',
      '  security: {}',
      '  other: {extends: security}',
      '',
    ].join('\n'))
    const { input } = await readNamedConfig({ cwd: directoryOfConfig, env: {}, configPath: file })
    const config = resolveConfig(input, { env: {} })
    rmSync(file)
    const fetchMock = stubModels({
      m: {
        findings: [FINDING],
      },
    })
    const { session } = await sessionOf({
      fields: { input, config },
    })
    expect(session.served).toEqual(['security', 'other'])

    const all = await reviewCall(session, { source: 'local' }, call())
    expect(all.structuredContent?.profiles.map(({ id }) => id)).toEqual(['security', 'other'])
    const calls = fetchMock.mock.calls.length
    const one = await reviewCall(session, {
      source: 'local',
      profiles: ['other'],
    }, call())
    expect(one.isError).toBeUndefined()
    expect(one.structuredContent?.profiles.map(({ id }) => id)).toEqual(['other'])
    expect(one.structuredContent?.findings.every(({ profile }) => profile === 'other')).toBe(true)
    expect(fetchMock.mock.calls.length - calls).toBeLessThan(calls)
  })

  it('answers a second call at once while a review runs', async () => {
    const gate = deferred()
    const started = deferred()
    const { session, requests } = await sessionOf({
      fake: { gate: gate.promise, onCall: started.resolve },
    })
    const first = reviewCall(session, { source: 'local' }, call())
    await started.promise
    expect(session.running).toBe(true)

    expect(await reviewCall(session, { source: 'local' }, call())).toEqual(failure(BUSY))
    // The lock comes before the usage check: even a call that names nothing valid is told to wait.
    expect(await reviewCall(session, { source: 'range' }, call())).toEqual(failure(BUSY))
    gate.resolve()
    expect((await first).isError).toBeUndefined()
    expect(requests.length).toBeGreaterThan(0)
    expect(session.running).toBe(false)
  })

  it('answers busy while a cancelled review is still settling, then runs the next call', async () => {
    const gate = deferred()
    const started = deferred()
    const { session, logged } = await sessionOf({
      fake: { gate: gate.promise, onCall: started.resolve },
    })
    const controller = new AbortController()
    const first = reviewCall(session, { source: 'local' }, { signal: controller.signal })
    await started.promise
    controller.abort()

    // The review has not settled yet: no turn of the event loop has run since the abort.
    expect(await reviewCall(session, { source: 'local' }, call())).toEqual(failure(BUSY))
    expect((await first).isError).toBe(true)
    expect(logged).toEqual(['quorum mcp: a review was cancelled'])
    expect(session.running).toBe(false)

    gate.resolve()
    const next = await reviewCall(session, { source: 'local' }, call())
    expect(next.isError).toBeUndefined()
    expect(next.structuredContent?.status).toBeDefined()
  })

  it('words each failure in fixed text, and writes its reason to the log alone', async () => {
    const root = directory()
    const linked = await sessionOf({
      fields: { root },
      repository: {
        untracked: linkedUntracked(root),
      },
    })
    const untracked = await reviewCall(linked.session, { source: 'local' }, call())
    expect(untracked).toEqual(failure(SOURCE))
    expect(linked.logged).toHaveLength(1)
    expect(linked.logged[0]).toMatch(ERROR_LINE)
    expect(linked.logged[0]).toContain('lies under a symbolic link')
    expect(linked.logged[0]).toContain('IGNORE-ALL')

    const broken = await sessionOf({
      repository: {
        diff: { code: 128, stderr: 'fatal: IGNORE-ALL leaked\n' },
      },
    })
    const git = await reviewCall(broken.session, { source: 'local' }, call())
    expect(git).toEqual(failure(GIT))
    expect(broken.logged).toHaveLength(1)
    expect(broken.logged[0]).toMatch(/^Error: git diff failed \(exit 128\)/)

    const failing = await sessionOf({
      fake: { failResearch: true },
    })
    const review = await reviewCall(failing.session, { source: 'local' }, call())
    expect(review).toEqual(failure(REVIEW))
    expect(failing.logged).toHaveLength(1)
    expect(failing.logged[0]).toMatch(ERROR_LINE)

    for (const outcome of [untracked, git, review]) expect(JSON.stringify(outcome)).not.toMatch(/IGNORE|leaked|research failed|\\n/)
    for (const { session } of [linked, broken, failing]) expect(session.running).toBe(false)
  })

  it('passes a refusal of the range, a path or at through, naming the argument in place of the flag', async () => {
    const root = directory()
    const { session, logged } = await sessionOf({
      fields: { root },
      repository: {
        missing: ['canary-base', 'canary-at'],
        tree: { 'src/a.js': 'export const a = 1\n' },
        untracked: linkedUntracked(root),
      },
    })

    const range = await reviewCall(session, { source: 'range', range: 'canary-base...canary-head' }, call())
    expect(range).toEqual(failure('range: its base names no commit of this repository: fetch it first, as actions/checkout does with fetch-depth: 0'))
    const paths = await reviewCall(session, {
      source: 'paths',
      paths: ['canary-path'],
    }, call())
    expect(paths).toEqual(failure('paths: path 1 names no file tracked at the commit'))
    const at = await reviewCall(session, {
      source: 'paths',
      paths: ['src'],
      at: 'canary-at',
    }, call())
    expect(at).toEqual(failure('at: names no commit of this repository'))
    for (const outcome of [range, paths, at]) expect(JSON.stringify(outcome)).not.toContain('canary')

    // An untracked file's refusal quotes its name, so it stays a fixed text.
    expect(await reviewCall(session, { source: 'local' }, call())).toEqual(failure(SOURCE))
    expect(logged).toHaveLength(4)
    expect(logged.every(line => ERROR_LINE.test(line))).toBe(true)
  })

  it('returns the agent\'s result as structured content and as the same JSON in one text block', async () => {
    const { session } = await sessionOf({
      fake: {
        findings: [FINDING],
      },
    })
    const result = await reviewCall(session, { source: 'staged' }, call())
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    const [block] = result.content
    expect(block.type).toBe('text')
    expect(JSON.parse(block.text)).toEqual(result.structuredContent)
    expect(block.text).toBe(JSON.stringify(result.structuredContent))
    expect(agentResultSchema.safeParse(result.structuredContent).success).toBe(true)
    expect(result.structuredContent?.status).toBe('findings')
    expect(result.structuredContent?.findings).toMatchObject([
      {
        file: 'a.js',
        line: 1,
        category: 'CWE-78',
        summary: 'command injection',
      },
    ])
    expect(result.structuredContent?.source).toMatchObject({ kind: 'staged' })
  })
})
