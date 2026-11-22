import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

/** The rules that hold each layer to the dependency rule; every other rule is out of this spec's scope. */
const BOUNDARY_RULES: ReadonlySet<string> = new Set([
  'no-restricted-imports',
  'ts/no-restricted-imports',
  'no-restricted-globals',
  'no-restricted-properties',
])
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const CASES: Array<[string, string, string, string[]]> = [
  [
    'the core imports zod',
    'src/core/probe.ts',
    'import { z } from \'zod\'\n\nexport const probe = z\n',
    [],
  ],
  [
    'the core refuses node:fs',
    'src/core/probe.ts',
    'import { readFileSync } from \'node:fs\'\n\nexport const probe = readFileSync\n',
    ['no-restricted-imports'],
  ],
  [
    'the core refuses process',
    'src/core/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'a stage refuses the config layer',
    'src/core/stages/probe.ts',
    'import { readEnv } from \'../../config/env.ts\'\n\nexport const probe = readEnv\n',
    ['no-restricted-imports'],
  ],
  [
    'a stage refuses process',
    'src/core/stages/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'a profile imports core types',
    'src/profiles/probe.ts',
    'import type { Profile } from \'../core/types.ts\'\n\nexport const probe: Profile | undefined = undefined\n',
    [],
  ],
  [
    'a profile refuses a core value',
    'src/profiles/probe.ts',
    'import { defaultPolicy } from \'../core/policy.ts\'\n\nexport const probe = defaultPolicy\n',
    ['ts/no-restricted-imports'],
  ],
  [
    'a profile refuses process',
    'src/profiles/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'a provider imports the port',
    'src/providers/probe.ts',
    'import type { Provider } from \'../core/ports.ts\'\n\nexport const probe: Provider | undefined = undefined\n',
    [],
  ],
  [
    'a provider imports the core\'s token count',
    'src/providers/probe.ts',
    'import { tokenBound } from \'../core/tokens.ts\'\n\nexport const probe = tokenBound\n',
    [],
  ],
  [
    'a provider refuses the config layer',
    'src/providers/probe.ts',
    'import { readEnv } from \'../config/env.ts\'\n\nexport const probe = readEnv\n',
    ['no-restricted-imports'],
  ],
  [
    'a provider refuses process',
    'src/providers/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'the claude-code adapter spawns a process',
    'src/providers/claude-code.ts',
    'import { spawn } from \'node:child_process\'\n\nexport const probe = spawn\n',
    [],
  ],
  [
    'the claude-code adapter reads process.env',
    'src/providers/claude-code.ts',
    'export const probe = process.env\n',
    [],
  ],
  [
    'the claude-code adapter makes a temporary directory',
    'src/providers/claude-code.ts',
    'import { mkdtemp } from \'node:fs/promises\'\nimport { tmpdir } from \'node:os\'\n\nexport const probe = [mkdtemp, tmpdir]\n',
    [],
  ],
  [
    'the claude-code adapter removes a directory synchronously',
    'src/providers/claude-code.ts',
    'import { rmSync } from \'node:fs\'\n\nexport const probe = rmSync\n',
    [],
  ],
  [
    'the claude-code adapter refuses node:net',
    'src/providers/claude-code.ts',
    'import { connect } from \'node:net\'\n\nexport const probe = connect\n',
    ['no-restricted-imports'],
  ],
  [
    'the claude-code adapter refuses Bun',
    'src/providers/claude-code.ts',
    'export const probe = Bun\n',
    ['no-restricted-globals'],
  ],
  [
    'the claude-code adapter refuses globalThis',
    'src/providers/claude-code.ts',
    'export const probe = globalThis\n',
    ['no-restricted-globals'],
  ],
  [
    'the claude-code adapter refuses process.getBuiltinModule',
    'src/providers/claude-code.ts',
    'export const probe = process.getBuiltinModule(\'node:net\')\n',
    ['no-restricted-properties'],
  ],
  [
    'the claude-code adapter refuses it destructured',
    'src/providers/claude-code.ts',
    'export const { getBuiltinModule: probe } = process\n',
    ['no-restricted-properties'],
  ],
  [
    'another provider refuses node:child_process',
    'src/providers/probe.ts',
    'import { spawn } from \'node:child_process\'\n\nexport const probe = spawn\n',
    ['no-restricted-imports'],
  ],
  [
    'the config layer imports the providers',
    'src/config/probe.ts',
    'import { presets } from \'../providers/presets.ts\'\n\nexport const probe = presets\n',
    [],
  ],
  [
    'the config layer refuses node:http',
    'src/config/probe.ts',
    'import { request } from \'node:http\'\n\nexport const probe = request\n',
    ['no-restricted-imports'],
  ],
  [
    'the config layer refuses fetch',
    'src/config/probe.ts',
    'export const probe = fetch\n',
    ['no-restricted-globals'],
  ],
  [
    'the config layer refuses src/testing',
    'src/config/probe.ts',
    'import { jsonReply } from \'../testing/http.ts\'\n\nexport const probe = jsonReply\n',
    ['no-restricted-imports'],
  ],
  [
    'the bench imports the core and the config layer',
    'src/bench/probe.ts',
    'import { loadConfig } from \'../config/load.ts\'\nimport { splitDiff } from \'../core/diff.ts\'\n\nexport const probe = [loadConfig, splitDiff]\n',
    [],
  ],
  [
    'the bench opens files and hashes them',
    'src/bench/probe.ts',
    'import { createHash } from \'node:crypto\'\nimport { open } from \'node:fs/promises\'\n\nexport const probe = [createHash, open]\n',
    [],
  ],
  [
    'the bench refuses node:http',
    'src/bench/probe.ts',
    'import { request } from \'node:http\'\n\nexport const probe = request\n',
    ['no-restricted-imports'],
  ],
  [
    'the bench refuses the CLI',
    'src/bench/probe.ts',
    'import { runCli } from \'../cli/main.ts\'\n\nexport const probe = runCli\n',
    ['no-restricted-imports'],
  ],
  [
    'the bench refuses the providers',
    'src/bench/probe.ts',
    'import { presets } from \'../providers/presets.ts\'\n\nexport const probe = presets\n',
    ['no-restricted-imports'],
  ],
  [
    'the bench refuses src/testing',
    'src/bench/probe.ts',
    'import { PATCHES } from \'../testing/bench.ts\'\n\nexport const probe = PATCHES\n',
    ['no-restricted-imports'],
  ],
  [
    'the bench refuses process',
    'src/bench/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'the bench refuses fetch',
    'src/bench/probe.ts',
    'export const probe = fetch\n',
    ['no-restricted-globals'],
  ],
  [
    'the core refuses the bench',
    'src/core/probe.ts',
    'import { loadSuite } from \'../bench/suite.ts\'\n\nexport const probe = loadSuite\n',
    ['no-restricted-imports'],
  ],
  [
    'the config layer refuses the bench',
    'src/config/probe.ts',
    'import { loadSuite } from \'../bench/suite.ts\'\n\nexport const probe = loadSuite\n',
    ['no-restricted-imports'],
  ],
  [
    'the CLI imports the config layer',
    'src/cli/probe.ts',
    'import { loadConfig } from \'../config/load.ts\'\n\nexport const probe = loadConfig\n',
    [],
  ],
  [
    'the CLI imports the bench',
    'src/cli/probe.ts',
    'import { loadSuite } from \'../bench/suite.ts\'\n\nexport const probe = loadSuite\n',
    [],
  ],
  [
    'the CLI refuses src/testing',
    'src/cli/probe.ts',
    'import { jsonReply } from \'../testing/http.ts\'\n\nexport const probe = jsonReply\n',
    ['no-restricted-imports'],
  ],
  [
    'the public API refuses src/testing',
    'src/probe.ts',
    'import { jsonReply } from \'./testing/http.ts\'\n\nexport const probe = jsonReply\n',
    ['no-restricted-imports'],
  ],
  [
    'a spec file imports src/testing',
    'src/cli/probe.spec.ts',
    'import { jsonReply } from \'../testing/http.ts\'\n\nexport const probe = jsonReply\n',
    [],
  ],
  [
    'the git runner spawns a process',
    'src/git/probe.ts',
    'import { spawn } from \'node:child_process\'\n\nexport const probe = spawn\n',
    [],
  ],
  [
    'the git runner imports the core\'s errors, types and clock',
    'src/git/probe.ts',
    'import { systemClock } from \'../core/clock.ts\'\nimport { QuorumError } from \'../core/errors.ts\'\nimport type { ObjectFormat } from \'../core/types.ts\'\n\nexport const probe: [typeof systemClock, typeof QuorumError, ObjectFormat | undefined] = [systemClock, QuorumError, undefined]\n',
    [],
  ],
  [
    'the git runner refuses node:fs',
    'src/git/probe.ts',
    'import { readFileSync } from \'node:fs\'\n\nexport const probe = readFileSync\n',
    ['no-restricted-imports'],
  ],
  [
    'the git runner refuses the config layer',
    'src/git/probe.ts',
    'import { findExecutable } from \'../config/command.ts\'\n\nexport const probe = findExecutable\n',
    ['no-restricted-imports'],
  ],
  [
    'the git runner refuses process',
    'src/git/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'a source imports the git runner, the core and the config layer',
    'src/sources/probe.ts',
    'import { findExecutable } from \'../config/command.ts\'\nimport { splitDiff } from \'../core/diff.ts\'\nimport { runGit } from \'../git/run.ts\'\n\nexport const probe = [findExecutable, splitDiff, runGit]\n',
    [],
  ],
  [
    'a source reads files',
    'src/sources/probe.ts',
    'import { readFile } from \'node:fs/promises\'\n\nexport const probe = readFile\n',
    [],
  ],
  [
    'a source refuses node:child_process',
    'src/sources/probe.ts',
    'import { spawn } from \'node:child_process\'\n\nexport const probe = spawn\n',
    ['no-restricted-imports'],
  ],
  [
    'a source refuses the providers',
    'src/sources/probe.ts',
    'import { presets } from \'../providers/presets.ts\'\n\nexport const probe = presets\n',
    ['no-restricted-imports'],
  ],
  [
    'a source refuses process',
    'src/sources/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'the core refuses the git runner',
    'src/core/probe.ts',
    'import { runGit } from \'../git/run.ts\'\n\nexport const probe = runGit\n',
    ['no-restricted-imports'],
  ],
  [
    'the config layer refuses the sources',
    'src/config/probe.ts',
    'import { readSource } from \'../sources/read.ts\'\n\nexport const probe = readSource\n',
    ['no-restricted-imports'],
  ],
  [
    'a reporter imports the core',
    'src/report/probe.ts',
    'import { inertLine } from \'../core/sanitize.ts\'\n\nexport const probe = inertLine\n',
    [],
  ],
  [
    'a reporter refuses node:fs',
    'src/report/probe.ts',
    'import { readFileSync } from \'node:fs\'\n\nexport const probe = readFileSync\n',
    ['no-restricted-imports'],
  ],
  [
    'a reporter refuses the config layer',
    'src/report/probe.ts',
    'import { loadConfig } from \'../config/load.ts\'\n\nexport const probe = loadConfig\n',
    ['no-restricted-imports'],
  ],
  [
    'a reporter refuses process',
    'src/report/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'the core refuses the report layer',
    'src/core/probe.ts',
    'import { REPORTERS } from \'../report/registry.ts\'\n\nexport const probe = REPORTERS\n',
    ['no-restricted-imports'],
  ],
  [
    'the CLI refuses the MCP SDK',
    'src/cli/probe.ts',
    'import { McpServer } from \'@modelcontextprotocol/server\'\n\nexport const probe = McpServer\n',
    ['no-restricted-imports'],
  ],
  [
    'the CLI refuses a static import of src/mcp/',
    'src/cli/probe.ts',
    'import { sdkProblem } from \'../mcp/sdk.ts\'\n\nexport const probe = sdkProblem\n',
    ['no-restricted-imports'],
  ],
  [
    'the CLI imports src/mcp/ through import()',
    'src/cli/probe.ts',
    'export const probe = async () => import(\'../mcp/sdk.ts\')\n',
    [],
  ],
  [
    'the library refuses src/mcp/',
    'src/probe.ts',
    'export { sdkProblem } from \'./mcp/sdk.ts\'\n',
    ['no-restricted-imports'],
  ],
  [
    'an MCP module imports the SDK and the config layer',
    'src/mcp/probe.ts',
    'import { McpServer } from \'@modelcontextprotocol/server\'\nimport { readBounded } from \'../config/load.ts\'\n\nexport const probe = [McpServer, readBounded]\n',
    [],
  ],
  [
    'an MCP module refuses node:child_process',
    'src/mcp/probe.ts',
    'import { spawn } from \'node:child_process\'\n\nexport const probe = spawn\n',
    ['no-restricted-imports'],
  ],
  [
    'an MCP module refuses process',
    'src/mcp/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'the state layer imports the config layer\'s file helpers and node:crypto',
    'src/state/probe.ts',
    'import { createHash } from \'node:crypto\'\nimport { readBounded } from \'../config/load.ts\'\n\nexport const probe = [createHash, readBounded]\n',
    [],
  ],
  [
    'the state layer refuses node:child_process',
    'src/state/probe.ts',
    'import { spawn } from \'node:child_process\'\n\nexport const probe = spawn\n',
    ['no-restricted-imports'],
  ],
  [
    'the state layer refuses process',
    'src/state/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'a view module imports the core and the report layer',
    'src/cli/view/probe.ts',
    'import { inertLine } from \'../../core/sanitize.ts\'\nimport { GAP_WORDS } from \'../../report/lines.ts\'\n\nexport const probe = [inertLine, GAP_WORDS]\n',
    [],
  ],
  [
    'a view module refuses the config layer',
    'src/cli/view/probe.ts',
    'import { readEnv } from \'../../config/env.ts\'\n\nexport const probe = readEnv\n',
    ['no-restricted-imports'],
  ],
  [
    'a view module refuses process',
    'src/cli/view/probe.ts',
    'export const probe = process.env\n',
    ['no-restricted-globals'],
  ],
  [
    'the fake server uses node:http',
    'src/testing/server.ts',
    'import { createServer } from \'node:http\'\n\nexport const probe = createServer\n',
    [],
  ],
  [
    'another test helper refuses node:http',
    'src/testing/probe.ts',
    'import { createServer } from \'node:http\'\n\nexport const probe = createServer\n',
    ['no-restricted-imports'],
  ],
  [
    'the CLI refuses a bare http',
    'src/cli/probe.ts',
    'import { createServer } from \'http\'\n\nexport const probe = createServer\n',
    ['no-restricted-imports'],
  ],
  [
    'the public API refuses node:http2',
    'src/probe.ts',
    'import { connect } from \'node:http2\'\n\nexport const probe = connect\n',
    ['no-restricted-imports'],
  ],
  [
    'another test helper refuses node:http2',
    'src/testing/probe.ts',
    'import { connect } from \'node:http2\'\n\nexport const probe = connect\n',
    ['no-restricted-imports'],
  ],
  [
    'another test helper refuses the fake server',
    'src/testing/probe.ts',
    'import { fakeServer } from \'./server.ts\'\n\nexport const probe = fakeServer\n',
    ['no-restricted-imports'],
  ],
  [
    'a spec of the test helpers imports the fake server',
    'src/testing/probe.spec.ts',
    'import { fakeServer } from \'./server.ts\'\n\nexport const probe = fakeServer\n',
    [],
  ],
  [
    'the CLI refuses node:http',
    'src/cli/probe.ts',
    'import { createServer } from \'node:http\'\n\nexport const probe = createServer\n',
    ['no-restricted-imports'],
  ],
  [
    'the public API refuses node:http',
    'src/probe.ts',
    'import { createServer } from \'node:http\'\n\nexport const probe = createServer\n',
    ['no-restricted-imports'],
  ],
  [
    'a spec file imports the fake server',
    'src/providers/probe.spec.ts',
    'import { fakeServer } from \'../testing/server.ts\'\n\nexport const probe = fakeServer\n',
    [],
  ],
  [
    'the core refuses the state layer',
    'src/core/probe.ts',
    'import { openFileStore } from \'../state/store.ts\'\n\nexport const probe = openFileStore\n',
    ['no-restricted-imports'],
  ],
]

describe('the layer boundaries of eslint.config.js', { timeout: 30_000 }, () => {
  let eslint: ESLint
  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT })
  })

  it.each(CASES)('%s', async (_name, filePath, code, rules) => {
    const results = await eslint.lintText(code, { filePath, warnIgnored: true })
    expect(results).toHaveLength(1)
    const { messages } = results[0]
    // A parse error and an ignored probe file are the messages that name no rule: either would pass a case on nothing.
    expect(messages.filter(message => message.ruleId === null).map(message => message.message)).toEqual([])
    expect(messages.map(message => message.ruleId).filter(rule => rule !== null && BOUNDARY_RULES.has(rule))).toEqual(rules)
  })
})
