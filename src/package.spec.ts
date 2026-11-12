import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

interface PackageJson {
  name: string
  license: string
  bin: Record<string, string>
  exports: Record<string, Record<string, string>>
  files: string[]
  publishConfig: Record<string, string>
  engines: Record<string, string>
  scripts: Record<string, string>
}

const pkg = JSON.parse(read('package.json')) as PackageJson
const scripts = pkg.scripts

describe('package.json', () => {
  it('builds a binary that loads no .env or bunfig.toml from the directory it runs in', () => {
    // By default a Bun-compiled binary loads both from its working directory, a pull request's checkout
    // in CI: a bunfig.toml can preload code, and a .env can set the variables that choose the endpoints.
    const compile = scripts.compile.split(/\s+/)
    expect(compile.slice(0, 3)).toEqual(['bun', 'build', '--compile'])
    expect(compile).toContain('--no-compile-autoload-dotenv')
    expect(compile).toContain('--no-compile-autoload-bunfig')
  })

  it('is the public npm package @tobi-or-not/quorum', () => {
    expect(pkg.name).toBe('@tobi-or-not/quorum')
    expect(pkg.publishConfig).toEqual({ access: 'public' })
  })

  it('is licensed under the Apache License 2.0, whose text npm puts in the package', () => {
    // npm ships LICENSE whatever `files` says, and a published version's license field cannot change.
    expect(pkg.license).toBe('Apache-2.0')
    expect(read('LICENSE')).toMatch(/^\s*Apache License\s+Version 2\.0, January 2004\s/)
  })

  it('exposes a quorum command that runs on Node and a library with its types', () => {
    expect(pkg.bin).toEqual({ quorum: 'dist/cli/bin.js' })
    expect(pkg.exports).toEqual({ '.': { types: './dist/index.d.ts', default: './dist/index.js' } })
  })

  it('ships the build and the JSON Schema, and nothing else of its own, not the bin/ the binaries are built into', () => {
    // `bun run compile` and `bun run compile:release` write into bin/, which `files` does not name, so a
    // hand-run `npm pack` or `npm publish` never puts an executable in the package.
    expect(pkg.files).toEqual(['dist', 'schema'])
  })

  it('compiles the release binaries with the script that builds the four of them and their checksums', () => {
    expect(scripts['compile:release']).toBe('bun run ./scripts/build-binaries.ts')
  })

  it('keeps the engines the package runs on', () => {
    expect(pkg.engines).toEqual({ node: '^22.18.0 || >=23.6.0', bun: '>=1.3.0' })
  })

  it('builds with tsc into dist/, from a clean directory', () => {
    expect(scripts.build).toMatch(/^rm -rf dist && .*\btsc -p tsconfig\.build\.json\b/)
  })

  it('installs the git hooks only where husky and a git checkout exist, so a tarball or an image build installs', () => {
    // `npm pack` and `npm publish` run `prepare`, as does an install from a tarball or in a build stage.
    expect(scripts.prepare).toBe('husky || true')
  })
})

describe('tsconfig.build.json', () => {
  const build = (): { compilerOptions: Record<string, unknown>, exclude: string[] } => JSON.parse(read('tsconfig.build.json'))

  it('emits JavaScript that Node resolves, and declarations, into dist/', () => {
    expect(build().compilerOptions.rewriteRelativeImportExtensions).toBe(true)
    expect(build().compilerOptions.declaration).toBe(true)
    expect(build().compilerOptions.outDir).toBe('dist')
  })

  it('lays dist/ out as src/ is, so dist/cli/bin.js and the ../../package.json import resolve', () => {
    // Without a rootDir, tsc counts package.json among the sources and emits dist/src/.
    expect(build().compilerOptions.rootDir).toBe('src')
  })

  it('strips what is exported for the specs from the declarations, which then need no Node types', () => {
    expect(build().compilerOptions.stripInternal).toBe(true)
  })

  it('leaves out the specs and the test helpers', () => {
    expect(build().exclude).toContain('**/*.spec.ts')
    expect(build().exclude).toContain('src/testing/**')
  })
})

describe('the CLI entry point', () => {
  it('starts with a Node shebang, the line the npm bin runs under', () => {
    expect(read('src/cli/bin.ts').split('\n')[0]).toBe('#!/usr/bin/env node')
  })
})

describe('release-please-config.json', () => {
  const config = JSON.parse(read('release-please-config.json')) as { packages: Record<string, Record<string, unknown>> }

  it('names the npm package and tags a release v<version>', () => {
    expect(config.packages['.']['package-name']).toBe('@tobi-or-not/quorum')
    expect(config.packages['.']['include-component-in-tag']).toBe(false)
  })
})
