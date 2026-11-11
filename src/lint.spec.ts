import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

/** The rules that hold each layer to the dependency rule; every other rule is out of this spec's scope. */
const BOUNDARY_RULES: ReadonlySet<string> = new Set(['no-restricted-imports', 'ts/no-restricted-imports', 'no-restricted-globals'])
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const CASES: Array<[string, string, string, string[]]> = [
  ['the core imports zod', 'src/core/probe.ts', 'import { z } from \'zod\'\n\nexport const probe = z\n', []],
  ['the core refuses node:fs', 'src/core/probe.ts', 'import { readFileSync } from \'node:fs\'\n\nexport const probe = readFileSync\n', ['no-restricted-imports']],
  ['the core refuses process', 'src/core/probe.ts', 'export const probe = process.env\n', ['no-restricted-globals']],
  ['a stage refuses the config layer', 'src/core/stages/probe.ts', 'import { readEnv } from \'../../config/env.ts\'\n\nexport const probe = readEnv\n', ['no-restricted-imports']],
  ['a profile imports core types', 'src/profiles/probe.ts', 'import type { Profile } from \'../core/types.ts\'\n\nexport const probe: Profile | undefined = undefined\n', []],
  ['a profile refuses a core value', 'src/profiles/probe.ts', 'import { defaultPolicy } from \'../core/policy.ts\'\n\nexport const probe = defaultPolicy\n', ['ts/no-restricted-imports']],
  ['a provider imports the port', 'src/providers/probe.ts', 'import type { Provider } from \'../core/ports.ts\'\n\nexport const probe: Provider | undefined = undefined\n', []],
  ['a provider refuses the config layer', 'src/providers/probe.ts', 'import { readEnv } from \'../config/env.ts\'\n\nexport const probe = readEnv\n', ['no-restricted-imports']],
  ['a provider refuses process', 'src/providers/probe.ts', 'export const probe = process.env\n', ['no-restricted-globals']],
  ['the config layer imports the providers', 'src/config/probe.ts', 'import { presets } from \'../providers/presets.ts\'\n\nexport const probe = presets\n', []],
  ['the config layer refuses node:http', 'src/config/probe.ts', 'import { request } from \'node:http\'\n\nexport const probe = request\n', ['no-restricted-imports']],
  ['the config layer refuses fetch', 'src/config/probe.ts', 'export const probe = fetch\n', ['no-restricted-globals']],
  ['the config layer refuses src/testing', 'src/config/probe.ts', 'import { jsonReply } from \'../testing/http.ts\'\n\nexport const probe = jsonReply\n', ['no-restricted-imports']],
  ['the CLI imports the config layer', 'src/cli/probe.ts', 'import { loadConfig } from \'../config/load.ts\'\n\nexport const probe = loadConfig\n', []],
  ['the CLI refuses src/testing', 'src/cli/probe.ts', 'import { jsonReply } from \'../testing/http.ts\'\n\nexport const probe = jsonReply\n', ['no-restricted-imports']],
  ['the public API refuses src/testing', 'src/probe.ts', 'import { jsonReply } from \'./testing/http.ts\'\n\nexport const probe = jsonReply\n', ['no-restricted-imports']],
  ['a spec file imports src/testing', 'src/cli/probe.spec.ts', 'import { jsonReply } from \'../testing/http.ts\'\n\nexport const probe = jsonReply\n', []],
]

describe('the layer boundaries of eslint.config.js', { timeout: 30_000 }, () => {
  let eslint: ESLint
  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT })
  })

  it.each(CASES)('%s', async (_name, filePath, code, rules) => {
    const [result] = await eslint.lintText(code, { filePath })
    expect(result.messages.map(message => message.ruleId).filter(rule => rule !== null && BOUNDARY_RULES.has(rule))).toEqual(rules)
  })
})
