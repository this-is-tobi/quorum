import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const scripts = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }).scripts

describe('package.json', () => {
  it('builds a binary that loads no .env or bunfig.toml from the directory it runs in', () => {
    // By default a Bun-compiled binary loads both from its working directory, a pull request's checkout
    // in CI: a bunfig.toml can preload code, and a .env can set the variables that choose the endpoints.
    const compile = scripts.compile.split(/\s+/)
    expect(compile.slice(0, 3)).toEqual(['bun', 'build', '--compile'])
    expect(compile).toContain('--no-compile-autoload-dotenv')
    expect(compile).toContain('--no-compile-autoload-bunfig')
  })
})
