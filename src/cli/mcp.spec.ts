import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubModels } from '../testing/bench.ts'
import { harness } from '../testing/cli.ts'
import { CHANGE_FINDING, fakeRepository, streamIO } from '../testing/mcp.ts'
import { EXIT } from './io.ts'
import { MCP_USAGE, runMcp } from './mcp.ts'

const CONFIG = 'providers:\n  local: {protocol: openai-compatible, baseUrl: "https://example.invalid/v1", model: m, contextTokens: 131072}\n'
const INSIDE = 'names a file inside the project, which the calling agent can change: keep the server\'s config outside the project'
const FILE_INSIDE = 'names a file inside the project, which the calling agent can change: keep it outside the project, as the server\'s config is'

/** The directories these tests made. */
const made: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../mcp/sdk.ts')
  vi.doUnmock('../mcp/serve.ts')
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A directory of its own, a real path. */
function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-mcp-cli-')))
  made.push(path)
  return path
}

/** Write `text` to `name` in `parent`, and return the path. */
function write(parent: string, name: string, text: string): string {
  const path = join(parent, name)
  writeFileSync(path, text)
  return path
}

/** What a client of the first era does with a server on `streams`: it opens, lists, reviews the local changes, reads the response, and only then closes stdin. Resolves with the exit code. */
async function converse(streams: ReturnType<typeof streamIO>, run: Promise<number>): Promise<number> {
  const send = (message: object): void => {
    streams.input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  send({
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'spec', version: '0' },
    },
  })
  send({ method: 'notifications/initialized' })
  send({ id: 2, method: 'tools/list' })
  send({
    id: 3,
    method: 'tools/call',
    params: {
      name: 'review',
      arguments: { source: 'local' },
    },
  })
  await vi.waitFor(() => expect(streams.lines().some(line => (JSON.parse(line) as { id?: number }).id === 3)).toBe(true), 5000)
  // The SDK answers nothing that is in flight once stdin ends: the client keeps it open until it has read the response.
  streams.input.end()
  return run
}

describe('quorum mcp', () => {
  it('prints its usage with -h, and calls no model and no git', async () => {
    const fetchMock = stubModels({})
    const root = directory()
    const git = fakeRepository(root)
    const { io, stdout, stderr } = harness({
      argv: ['-h'],
      cwd: root,
      git: git.seam,
    })
    expect(await runMcp(io, ['-h'])).toBe(EXIT.ok)
    expect(stdout()).toBe(MCP_USAGE)
    expect(stderr()).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(git.calls).toEqual([])
    expect(MCP_USAGE).toContain('      --max-session-tokens <n>    Spend at most this many tokens over the server\'s life; four times maxReviewTokens by default\n      --code-fields-only          Leave each finding\'s category and summary out of what the agent receives\n      --require-approval          Have Claude Code ask before every call\n  -h, --help')
    for (const line of MCP_USAGE.split('\n').filter(entry => entry.startsWith('  '))) {
      expect(line.slice(0, 34).trim(), line).toMatch(/^(?:-\w, )?--[a-z-]+(?: <\w+>)?$/)
      expect(line[34], line).not.toBe(' ')
    }
  })

  it.each([
    [
      ['extra'],
      'Error: takes no argument, and 1 were given\n',
    ],
    [
      ['--config='],
      'Error: --config: must name a file\n',
    ],
    [
      ['--send='],
      'Error: --send: must name a file\n',
    ],
    [
      ['--watch'],
      'Error: Unknown option \'--watch\'',
    ],
  ])('refuses %j before anything is read, with the usage', async (argv, start) => {
    const fetchMock = stubModels({})
    const root = directory()
    const git = fakeRepository(root)
    const { io, stdout, stderr } = harness({
      cwd: root,
      git: git.seam,
      env: {
        QUORUM_CONFIG: join(root, 'missing.yaml'),
      },
    })
    expect(await runMcp(io, argv)).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr().startsWith(start)).toBe(true)
    expect(stderr().endsWith(`\n${MCP_USAGE}`)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(git.calls).toEqual([])
  })

  it.each([
    [
      ['0'],
      'must be a whole number of tokens, from 1',
      true,
    ],
    [
      ['1.5'],
      'must be a whole number of tokens, from 1',
      true,
    ],
    [
      ['x'],
      'must be a whole number of tokens, from 1',
      true,
    ],
    [
      ['5', '6'],
      'takes one number',
      true,
    ],
    [
      ['10'],
      'is below the config\'s maxReviewTokens of 100, so no review could start: raise it, or name a config with a lower cap',
      false,
    ],
  ] as const)('refuses --max-session-tokens %j', async (values, text, withUsage) => {
    const fetchMock = stubModels({})
    const root = directory()
    const git = fakeRepository(root)
    const config = write(directory(), 'q.yaml', `${CONFIG}maxReviewTokens: 100\n`)
    const { io, stdout, stderr } = harness({ cwd: root, git: git.seam })
    expect(await runMcp(io, [
      '--config',
      config,
      ...values.flatMap(value => ['--max-session-tokens', value]),
    ])).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`Error: --max-session-tokens: ${text}\n${withUsage
      ? MCP_USAGE
      : ''}`)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(git.calls).toEqual([])
  })

  it('sets the session budget to four times the config\'s maxReviewTokens unless told otherwise', async () => {
    stubModels({
      m: {
        findings: [CHANGE_FINDING],
      },
    })
    const outside = directory()
    for (const { config, flags, total } of [
      { config: CONFIG, flags: [], total: 8_000_000 },
      { config: `${CONFIG}maxReviewTokens: 1000000\n`, flags: [], total: 4_000_000 },
      {
        config: `${CONFIG}maxReviewTokens: 1000000\n`,
        flags: ['--max-session-tokens', '3000000'],
        total: 3_000_000,
      },
    ]) {
      const root = directory()
      const streams = streamIO({ cwd: root, git: fakeRepository(root).seam })
      const run = runMcp(streams.io, [
        '--config',
        write(outside, 'q.yaml', config),
        ...flags,
      ])
      expect(await converse(streams, run)).toBe(EXIT.ok)
      expect(streams.stderr()).toMatch(new RegExp(`quorum mcp: the session has spent \\d+ of ${total} tokens\\n`))
    }
  })

  it('refuses a CLAUDE_PROJECT_DIR that is not an absolute path to a directory', async () => {
    const root = directory()
    const file = write(root, 'a-file', 'x\n')
    for (const value of [
      'relative/dir',
      join(root, 'missing'),
      file,
    ]) {
      const { io, stdout, stderr } = harness({
        cwd: root,
        env: { CLAUDE_PROJECT_DIR: value },
      })
      expect(await runMcp(io, [])).toBe(EXIT.usage)
      expect(stdout()).toBe('')
      expect(stderr()).toBe('Error: CLAUDE_PROJECT_DIR: must be an absolute path to a directory\n')
    }
  })

  it('serves from CLAUDE_PROJECT_DIR, else from the directory it was launched in', async () => {
    stubModels({
      m: {
        findings: [CHANGE_FINDING],
      },
    })
    const config = write(directory(), 'q.yaml', CONFIG)
    const project = directory()
    const launched = directory()
    for (const { cwd, env, expected } of [
      {
        cwd: launched,
        env: { CLAUDE_PROJECT_DIR: project },
        expected: project,
      },
      { cwd: launched, env: {}, expected: launched },
    ]) {
      const git = fakeRepository(expected)
      const streams = streamIO({ cwd, env, git: git.seam })
      const run = runMcp(streams.io, ['--config', config])
      expect(await converse(streams, run)).toBe(EXIT.ok)
      expect(git.calls.length).toBeGreaterThan(0)
      expect(new Set(git.calls.map(call => call.cwd))).toEqual(new Set([expected]))
    }
  })

  it('refuses a config file inside the project, named by --config or by QUORUM_CONFIG, before reading it', async () => {
    const outside = directory()
    const root = directory()
    const marker = join(outside, 'marker')
    write(root, 'q.yaml', CONFIG)
    write(root, 'q.mjs', `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default {}\n`)

    const byFlag = harness({ cwd: root })
    expect(await runMcp(byFlag.io, ['--config', 'q.yaml'])).toBe(EXIT.usage)
    expect(byFlag.stderr()).toBe(`Error: --config: ${INSIDE}\n`)

    const byEnv = harness({
      cwd: outside,
      env: {
        CLAUDE_PROJECT_DIR: root,
        QUORUM_CONFIG: join(root, 'q.yaml'),
      },
    })
    expect(await runMcp(byEnv.io, [])).toBe(EXIT.usage)
    expect(byEnv.stderr()).toBe(`Error: QUORUM_CONFIG: ${INSIDE}\n`)

    const code = harness({ cwd: root })
    expect(await runMcp(code.io, [
      '--config',
      join(root, 'q.mjs'),
    ])).toBe(EXIT.usage)
    expect(code.stderr()).toBe(`Error: --config: ${INSIDE}\n`)
    expect(existsSync(marker)).toBe(false)

    // A directory that merely starts with the project's name is another directory: the config in it is read (it stops at the missing streams).
    const sibling = join(outside, 'app-two')
    const project = join(outside, 'app')
    mkdirSync(sibling)
    mkdirSync(project)
    const beside = harness({ cwd: project })
    expect(await runMcp(beside.io, [
      '--config',
      write(sibling, 'q.yaml', CONFIG),
    ])).toBe(EXIT.runtime)
    expect(beside.stderr()).toContain('needs standard input and output as streams')

    // A link in the project to a file outside is the agent's to repoint, so it is refused as a file inside is.
    symlinkSync(join(sibling, 'q.yaml'), join(project, 'link.yaml'))
    const linked = harness({ cwd: project })
    expect(await runMcp(linked.io, [
      '--config',
      'link.yaml',
    ])).toBe(EXIT.usage)
    expect(linked.stderr()).toBe(`Error: --config: ${INSIDE}\n`)

    // A path typed through a link in the project to a directory outside is the agent's to repoint too: it is refused as typed, and the file is never read.
    write(sibling, 'l.mjs', `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport default {}\n`)
    symlinkSync(sibling, join(project, 'l'))
    for (const named of [
      join(project, 'l', 'l.mjs'),
      join('l', 'l.mjs'),
    ]) {
      const typed = harness({ cwd: project })
      expect(await runMcp(typed.io, [
        '--config',
        named,
      ])).toBe(EXIT.usage)
      expect(typed.stderr()).toBe(`Error: --config: ${INSIDE}\n`)
    }
    const typedByEnv = harness({
      cwd: outside,
      env: {
        CLAUDE_PROJECT_DIR: project,
        QUORUM_CONFIG: join(project, 'l', 'l.mjs'),
      },
    })
    expect(await runMcp(typedByEnv.io, [])).toBe(EXIT.usage)
    expect(typedByEnv.stderr()).toBe(`Error: QUORUM_CONFIG: ${INSIDE}\n`)
    expect(existsSync(marker)).toBe(false)

    // A relative QUORUM_CONFIG is refused first, a path given or not.
    const relative = harness({
      cwd: project,
      env: { QUORUM_CONFIG: 'q.yaml' },
    })
    expect(await runMcp(relative.io, [
      '--config',
      join(sibling, 'q.yaml'),
    ])).toBe(EXIT.usage)
    expect(relative.stderr()).toBe('Error: QUORUM_CONFIG: must be an absolute path\n')
    expect(beside.stderr()).not.toContain(INSIDE)
  })

  it('refuses to serve a terminal', async () => {
    const root = directory()
    const { io, stdout, stderr } = harness({ cwd: root, isTTY: true })
    expect(await runMcp(io, [])).toBe(EXIT.usage)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('Error: reads MCP messages on standard input, which is a terminal here: let an MCP client start it, as claude mcp add quorum -- quorum mcp does\n')
  })

  it('refuses an SDK of another version before importing it, and an absent one, each with the command that installs the pin', async () => {
    const root = directory()
    const named = join(root, 'never-read.yaml')
    const loaded: string[] = []
    const actual = await vi.importActual<typeof import('../mcp/sdk.ts')>('../mcp/sdk.ts')

    vi.doMock('../mcp/sdk.ts', () => ({
      ...actual,
      sdkProblem: async () => actual.SDK_OTHER,
    }))
    vi.doMock('../mcp/serve.ts', () => {
      loaded.push('serve')
      throw new Error('the SDK must not load')
    })
    const other = harness({ cwd: root })
    expect(await runMcp(other.io, ['--config', named])).toBe(EXIT.usage)
    expect(other.stderr()).toBe(`Error: ${actual.SDK_OTHER}\n`)
    expect(loaded).toEqual([])

    vi.doMock('../mcp/sdk.ts', () => ({
      ...actual,
      sdkProblem: async () => undefined,
    }))
    vi.doMock('../mcp/serve.ts', () => {
      loaded.push('serve')
      throw new Error('Cannot find package \'@modelcontextprotocol/server\'')
    })
    const absent = harness({ cwd: root })
    expect(await runMcp(absent.io, ['--config', named])).toBe(EXIT.usage)
    expect(absent.stderr()).toBe(`Error: ${actual.SDK_ABSENT}\n`)
    expect(loaded).toEqual(['serve'])
  })

  it('refuses to launch with a profile that leaves no room, before it serves anything and with no call', async () => {
    const fetchMock = stubModels({})
    const config = write(directory(), 'q.yaml', 'providers:\n  local: {protocol: openai-compatible, baseUrl: "https://example.invalid/v1", model: m, contextTokens: 2000}\n')
    const root = directory()
    const streams = streamIO({ cwd: root, git: fakeRepository(root).seam })
    const run = runMcp(streams.io, ['--config', config])
    streams.input.end()
    expect(await run).toBe(EXIT.usage)
    expect(streams.lines()).toEqual([])
    expect(streams.stderr()).toContain('Error: profiles.security: the research request on local leaves no tokens for the diff, its other tokens 803 over the window, where a hunk may need 1024: contextTokens 2000 counts 1791 for the instructions, 512 for the chat template and 500 for the reply: lower maxTokens, or state a larger window\n')
    expect(streams.stderr()).not.toContain('serving the review tool')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses to launch with a profile that reads a repository document, at its entry, before it serves anything and with no call', async () => {
    const fetchMock = stubModels({})
    const kept = directory()
    write(kept, 'guide.md', 'Name things for what they do.')
    const config = write(kept, 'q.yaml', `${CONFIG}profiles:\n  security:\n    guidelines: [{repository: REVIEW.md}, {file: guide.md}]\n    doNotReport: [{repository: .github/SKIP.md, optional: true}]\n    rules: [{id: inline, text: Written in the config.}, {repository: .quorum/rules.yaml}]\n`)
    const root = directory()
    const streams = streamIO({ cwd: root, git: fakeRepository(root).seam })
    const run = runMcp(streams.io, ['--config', config])
    streams.input.end()
    expect(await run).toBe(EXIT.usage)
    expect(streams.lines()).toEqual([])
    // The calling agent can commit to the repository, so every entry is refused at its own place, and the { file } one is not.
    expect(streams.stderr()).toBe([
      'Error: profiles.security.guidelines.0.repository: reads a document of the repository, which the calling agent can commit to: name the file with { file }, kept outside the project',
      'profiles.security.doNotReport.0.repository: reads a document of the repository, which the calling agent can commit to: name the file with { file }, kept outside the project',
      'profiles.security.rules.1.repository: reads a document of the repository, which the calling agent can commit to: name the file with { file }, kept outside the project',
      '',
    ].join('\n'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each<[string, string, string, (root: string, kept: string) => string]>([
    [
      'research prompt file',
      'prompts: {research: {file: NAME}}',
      'profiles.security.prompts.research.file',
      (root) => {
        write(root, 'research.md', 'Look for naming problems.')
        return join(root, 'research.md')
      },
    ],
    [
      'guideline file',
      'guidelines: [{file: NAME}]',
      'profiles.security.guidelines.0.file',
      (root) => {
        write(root, 'guide.md', 'Name things for what they do.')
        return join(root, 'guide.md')
      },
    ],
    [
      'do-not-report file',
      'doNotReport: [{file: NAME}]',
      'profiles.security.doNotReport.0.file',
      (root) => {
        write(root, 'skip.md', 'Generated files.')
        return join(root, 'skip.md')
      },
    ],
    [
      'rules file',
      'rules: [{id: inline, text: Written in the config.}, {file: NAME}]',
      'profiles.security.rules.1.file',
      (root) => {
        write(root, 'rules.yaml', '- id: no-any\n  text: No any outside tests.\n')
        return join(root, 'rules.yaml')
      },
    ],
    [
      'file a link outside the root leads to',
      'guidelines: [{file: NAME}]',
      'profiles.security.guidelines.0.file',
      (root, kept) => {
        write(root, 'guide.md', 'Name things for what they do.')
        symlinkSync(join(root, 'guide.md'), join(kept, 'link.md'))
        return 'link.md'
      },
    ],
    [
      'file in a directory a link outside the root leads to',
      'guidelines: [{file: NAME}]',
      'profiles.security.guidelines.0.file',
      (root, kept) => {
        // The file itself leads outside, but it lies in a directory of the project: the agent can repoint it.
        mkdirSync(join(root, 'docs'))
        symlinkSync(write(directory(), 'guide.md', 'Name things for what they do.'), join(root, 'docs', 'guide.md'))
        symlinkSync(join(root, 'docs'), join(kept, 'dir-link'))
        return join('dir-link', 'guide.md')
      },
    ],
  ])('refuses to launch with a %s inside the root, at its config path', async (_kind, entry, at, place) => {
    const fetchMock = stubModels({})
    const kept = directory()
    const root = directory()
    const name = place(root, kept)
    const config = write(kept, 'q.yaml', `${CONFIG}profiles:\n  security:\n    ${entry.replace('NAME', JSON.stringify(name))}\n`)
    const streams = streamIO({ cwd: root, git: fakeRepository(root).seam })
    const run = runMcp(streams.io, ['--config', config])
    streams.input.end()
    expect(await run).toBe(EXIT.usage)
    expect(streams.lines()).toEqual([])
    expect(streams.stderr()).toBe(`Error: ${at}: ${FILE_INSIDE}\n`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses every file inside the root at once, before the profiles resolve and before a repository document', async () => {
    const fetchMock = stubModels({})
    const kept = directory()
    const root = directory()
    write(kept, 'outside.md', 'Kept outside.')
    const config = write(kept, 'q.yaml', [
      CONFIG,
      'profiles:',
      '  security:',
      `    guidelines: [{file: ${JSON.stringify(write(root, 'a.md', 'a'))}}, {repository: REVIEW.md}, {file: outside.md}]`,
      `    doNotReport: [{file: outside.md}, {file: ${JSON.stringify(write(root, 'b.md', 'b'))}}]`,
      '',
    ].join('\n'))
    const streams = streamIO({ cwd: root, git: fakeRepository(root).seam })
    const run = runMcp(streams.io, ['--config', config])
    streams.input.end()
    expect(await run).toBe(EXIT.usage)
    expect(streams.stderr()).toBe([
      `Error: profiles.security.guidelines.0.file: ${FILE_INSIDE}`,
      `profiles.security.doNotReport.1.file: ${FILE_INSIDE}`,
      '',
    ].join('\n'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves a config whose prompt and document files lie outside the root', async () => {
    stubModels({
      m: {
        findings: [CHANGE_FINDING],
      },
    })
    const kept = directory()
    write(kept, 'research.md', 'Look for naming problems.')
    write(kept, 'guide.md', 'Name things for what they do.')
    write(kept, 'skip.md', 'Generated files.')
    const config = write(kept, 'q.yaml', `${CONFIG}profiles:\n  security:\n    prompts: {research: {file: research.md}}\n    guidelines: [{file: guide.md}]\n    doNotReport: [{file: skip.md}]\n`)
    const root = directory()
    const streams = streamIO({ cwd: root, git: fakeRepository(root).seam })
    const run = runMcp(streams.io, ['--config', config])
    expect(await converse(streams, run)).toBe(EXIT.ok)
    expect(streams.stderr()).toContain('quorum mcp: serving the review tool\n')
  })

  it('writes nothing on stdout but protocol messages, one a line, and exits 0 when the client closes stdin', async () => {
    stubModels({
      m: {
        findings: [CHANGE_FINDING],
      },
    })
    const config = write(directory(), 'q.yaml', CONFIG)
    const root = directory()
    const streams = streamIO({ cwd: root, git: fakeRepository(root).seam })
    const run = runMcp(streams.io, ['--config', config])
    expect(await converse(streams, run)).toBe(EXIT.ok)

    const messages = streams.lines().map(line => JSON.parse(line) as { jsonrpc?: string, id?: number, method?: string, result?: { structuredContent?: { status?: string } } })
    expect(messages.length).toBeGreaterThanOrEqual(3)
    for (const message of messages) expect(message.jsonrpc).toBe('2.0')
    const answer = messages.find(message => message.id === 3)
    expect(answer?.result?.structuredContent?.status).toBe('findings')
    expect(streams.stderr()).toContain('Research (m @ https://example.invalid)...\nPanel will use m @ https://example.invalid\n')
    expect(streams.stderr()).toContain('quorum mcp: serving the review tool\n')
  })
})
