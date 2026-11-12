/** Test helper for code that reads `process.env`. */

import { vi } from 'vitest'
import { READ_VARIABLES as ENV_LAYER_VARIABLES } from '../config/env.ts'
import { presets } from '../providers/presets.ts'

/** Every variable the config layer reads: those of the environment layer, and the key variable each preset names. */
export const READ_VARIABLES: readonly string[] = [
  ...ENV_LAYER_VARIABLES,
  ...Object.values(presets).flatMap(preset => preset.apiKeyEnv ?? []),
]

/**
 * Make `process.env` hold the config layer's variables as `values` says and no other: every variable it reads, and
 * every `QUORUM_` variable of the machine, is blanked (a blank variable is unset, and warns about nothing), then
 * each of `values` is set. The spec's `afterEach(() => vi.unstubAllEnvs())` undoes it.
 */
export function isolateEnv(values: Readonly<Record<string, string>> = {}): void {
  const quorumVariables = Object.keys(process.env).filter(name => name.startsWith('QUORUM_'))
  for (const name of new Set([
    ...READ_VARIABLES,
    ...quorumVariables,
  ])) vi.stubEnv(name, '')
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value)
}
