import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { RELEASE_TARGETS, releaseBuilds, sha256sumLine } from './build-binaries.ts'

// A build spawns Bun, downloads the other targets' runtimes and writes bin/release: no test runs one, and
// importing the script must start none.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))

const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']

describe('the release targets', () => {
  it('names linux and macOS on x64 and arm64, in the order the checksums list them', () => {
    expect([...RELEASE_TARGETS]).toEqual(TARGETS)
  })
})

describe('releaseBuilds', () => {
  it('holds one build per target, in order, writing bin/release/quorum-<target>', () => {
    expect(releaseBuilds().map(({ target, outfile }) => ({ target, outfile }))).toEqual(
      TARGETS.map(target => ({ target, outfile: `bin/release/quorum-${target}` })),
    )
  })

  it('compiles ./src/cli/bin.ts for its target with the flags `bun run compile` uses', () => {
    for (const { target, outfile, args } of releaseBuilds()) {
      expect(args.slice(0, 2)).toEqual(['build', '--compile'])
      expect(args).toContain('--no-compile-autoload-dotenv')
      expect(args).toContain('--no-compile-autoload-bunfig')
      expect(args).toContain(`--target=bun-${target}`)
      expect(args).toContain('./src/cli/bin.ts')
      const at = args.indexOf('--outfile')
      expect(args.slice(at, at + 2)).toEqual(['--outfile', outfile])
    }
  })

  it('keeps every flag of the compile script, so a binary of a release loads no .env or bunfig.toml either', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }
    const flags = scripts.compile.split(/\s+/).filter(word => word.startsWith('--') && word !== '--outfile')
    expect(flags.length).toBeGreaterThanOrEqual(3)
    for (const { args } of releaseBuilds())
      expect(args).toEqual(expect.arrayContaining(flags))
  })
})

describe('sha256sumLine', () => {
  it('writes the line sha256sum -c reads: the lowercase hex digest, two spaces, the name, no newline', () => {
    // FIPS 180 test vector: the SHA-256 of the bytes `abc`.
    expect(sha256sumLine('quorum-linux-x64', new TextEncoder().encode('abc')))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  quorum-linux-x64')
  })

  it('hashes the bytes of the content, whatever they are', () => {
    expect(sha256sumLine('empty', new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty')
  })
})

describe('importing the script', () => {
  it('spawns no build', () => {
    expect(spawnSync).not.toHaveBeenCalled()
  })
})
