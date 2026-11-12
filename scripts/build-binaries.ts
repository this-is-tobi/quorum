import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The binaries a release attaches: `bun run compile:release` compiles one per target and writes them with
// a SHA256SUMS file into bin/release, beside the bin/quorum of `bun run compile`; bin/ is git-ignored and
// outside the npm package's `files`. Bun cross-compiles, so one machine builds all four (it downloads the
// other targets' runtimes on the first run), and the CD builds them on Linux from the tagged commit. Each
// binary keeps the flags `bun run compile` uses, so none reads a .env or a bunfig.toml from the directory
// it runs in. Nothing here is published: the CD attaches and attests the files.

export const RELEASE_TARGETS = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
] as const

const RELEASE_DIR = 'bin/release'
const ROOT = fileURLToPath(new URL('..', import.meta.url))

export interface ReleaseBuild {
  target: string
  /** Where the binary is written, relative to the repository root. */
  outfile: string
  /** The arguments `bun` runs with, from the repository root. */
  args: string[]
}

/** One `bun build` per target, in `RELEASE_TARGETS` order. */
export function releaseBuilds(): ReleaseBuild[] {
  return RELEASE_TARGETS.map((target) => {
    const outfile = `${RELEASE_DIR}/quorum-${target}`
    return {
      target,
      outfile,
      args: [
        'build',
        '--compile',
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        `--target=bun-${target}`,
        './src/cli/bin.ts',
        '--outfile',
        outfile,
      ],
    }
  })
}

/** The line `sha256sum -c` reads for a file: the lowercase hex digest, two spaces, the name. */
export function sha256sumLine(name: string, content: Uint8Array): string {
  return `${createHash('sha256').update(content).digest('hex')}  ${name}`
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

function buildRelease(): void {
  if (!process.versions.bun)
    fail('this script compiles with the Bun that runs it: run `bun run compile:release`')
  const builds = releaseBuilds()
  // The directory ends up holding exactly the binaries and SHA256SUMS, never a leftover of an earlier run.
  rmSync(join(ROOT, RELEASE_DIR), { recursive: true, force: true })
  mkdirSync(join(ROOT, RELEASE_DIR), { recursive: true })
  for (const { target, args } of builds) {
    console.error(`Compiling quorum-${target}...`)
    const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
    if (result.error)
      fail(`cannot run ${process.execPath} for ${target}: ${result.error.message}`)
    if (result.status !== 0) {
      fail(`the build for ${target} failed, ${result.status === null
        ? `stopped by ${result.signal}`
        : `exit code ${result.status}`}`)
    }
  }
  // Written only once every build succeeded, so an incomplete set has no checksums to vouch for it.
  const sums = builds.map(({ outfile }) => `${sha256sumLine(basename(outfile), readFileSync(join(ROOT, outfile)))}\n`)
  writeFileSync(join(ROOT, RELEASE_DIR, 'SHA256SUMS'), sums.join(''))
  console.error(`Wrote ${builds.length} binaries and SHA256SUMS to ${RELEASE_DIR}`)
}

if (import.meta.main) buildRelease()
