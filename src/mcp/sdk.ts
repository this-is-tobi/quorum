import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import packageJson from '../../package.json' with { type: 'json' }
import { decode, readBounded } from '../config/load.ts'

export const MCP_SDK_NAME = '@modelcontextprotocol/server'

/** The version quorum runs the SDK at: the peer dependency's, which a Renovate bump changes in one file. */
export const MCP_SDK_VERSION: string = packageJson.peerDependencies[MCP_SDK_NAME]

export const SDK_ABSENT = `quorum mcp needs ${MCP_SDK_NAME} ${MCP_SDK_VERSION}, which is not installed beside quorum: npm install -g ${MCP_SDK_NAME}@${MCP_SDK_VERSION}`

export const SDK_OTHER = `quorum mcp runs ${MCP_SDK_NAME} ${MCP_SDK_VERSION} alone, and another copy is installed beside quorum: npm install -g ${MCP_SDK_NAME}@${MCP_SDK_VERSION}`

/** How many directories the walk looks in, the entry's own included: the SDK's `package.json` sits two above its entry. */
const LEVELS = 6

const MANIFEST_LIMIT = 64 * 1024

/** What a `package.json` holds, once parsed: the name and the version, whatever else it says. */
interface Manifest {
  readonly name?: unknown
  readonly version?: unknown
}

/**
 * The `package.json` read in `directory`: `undefined` when there is none, `null` when one cannot be used
 * (over 64 KiB, not a file, not UTF-8, not a JSON object), else its content.
 */
async function manifestIn(directory: string): Promise<Manifest | null | undefined> {
  const bytes = await readBounded(join(directory, 'package.json'), MANIFEST_LIMIT, '64 KiB')
  if ('problem' in bytes) {
    return bytes.problem === 'does not exist'
      ? undefined
      : null
  }
  const text = decode(bytes.value)
  if ('problem' in text) return null
  try {
    const parsed: unknown = JSON.parse(text.value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : null
  } catch {
    return null
  }
}

/**
 * Why the SDK installed beside quorum must not be loaded, or `undefined` when it may be imported. It runs
 * before any import, so an SDK of another version, which may be a compromised release, never loads.
 *
 * The SDK states no version at run time and its `exports` hide its `package.json`, so the entry is resolved
 * as the `import()` that follows would resolve it (`resolve`, `import.meta.resolve` by default: one
 * algorithm, so the file read is the one that would load), and the walk goes up from the entry's directory,
 * at most six levels, to the first `package.json` whose own `name` is the SDK's. Its own `version` must be
 * the pin, `MCP_SDK_VERSION`.
 *
 * - A resolution that throws answers `undefined`: nothing on disk, so a binary's bundled copy, which the
 *   lockfile pinned, or no copy, which the `import()` that follows tells apart (`import.meta.resolve`
 *   throws inside a compiled binary, where the bundled `import()` loads).
 * - A URL that is not `file:` answers `SDK_OTHER`.
 * - A `package.json` that cannot be used, another version, or no `package.json` of the SDK's own name
 *   within the walk answers `SDK_OTHER`. A `package.json` of another name (a `dist/` folder's `type`
 *   marker, say) is walked past.
 */
export async function sdkProblem(resolve: (specifier: string) => string = specifier => import.meta.resolve(specifier)): Promise<string | undefined> {
  let resolved: string
  try {
    resolved = resolve(MCP_SDK_NAME)
  } catch {
    return undefined
  }
  let directory: string
  try {
    const url = new URL(resolved)
    if (url.protocol !== 'file:') return SDK_OTHER
    directory = dirname(fileURLToPath(url))
  } catch {
    return SDK_OTHER
  }
  for (let level = 0; level < LEVELS; level++) {
    const manifest = await manifestIn(directory)
    if (manifest === null) return SDK_OTHER
    if (manifest !== undefined && manifest.name === MCP_SDK_NAME) {
      return manifest.version === MCP_SDK_VERSION
        ? undefined
        : SDK_OTHER
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return SDK_OTHER
}
