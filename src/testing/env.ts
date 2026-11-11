/** Test helper for code that reads `process.env`. */

import { vi } from 'vitest'

const ROLES = ['RESEARCH', 'VOTER']

/** Every variable the config layer reads: `QUORUM_CONFIG`, `QUORUM_PROFILES`, the `QUORUM_` form of each role's fields, and their deprecated aliases. */
export const READ_VARIABLES: readonly string[] = [
  'QUORUM_CONFIG',
  'QUORUM_PROFILES',
  ...ROLES.flatMap(role => ['PRESET', 'PROTOCOL', 'BASE_URL', 'MODEL', 'API_KEY'].map(field => `QUORUM_${role}_${field}`)),
  ...ROLES.flatMap(role => ['BASE_URL', 'API_KEY', 'MODEL'].map(field => `${role}_${field}`)),
]

/**
 * Make `process.env` hold the config layer's variables as `values` says and no other: every variable it reads, and
 * every `QUORUM_` variable of the machine, is blanked (a blank variable is unset, and warns about nothing), then
 * each of `values` is set. The spec's `afterEach(() => vi.unstubAllEnvs())` undoes it.
 */
export function isolateEnv(values: Readonly<Record<string, string>> = {}): void {
  const quorumVariables = Object.keys(process.env).filter(name => name.startsWith('QUORUM_'))
  for (const name of new Set([...READ_VARIABLES, ...quorumVariables])) vi.stubEnv(name, '')
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value)
}
