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
