import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CORE = fileURLToPath(new URL('.', import.meta.url))

/** Every module under `src/core`, specs left out, as a path from `src/core` with `/` separators, in sorted order. */
const modules: string[] = (readdirSync(CORE, { recursive: true }) as string[])
  .map(name => name.replaceAll('\\', '/'))
  .filter(name => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
  .sort()

/**
 * The modules a file loads when it runs: each `import` that is not `import type` and names a relative path. An
 * import ends at its first `from '<path>'`, since the code has no semicolons.
 */
function importsOf(file: string): string[] {
  const source = readFileSync(join(CORE, file), 'utf8')
  return [
    ...source.matchAll(/^import (?!type\b)[\s\S]*?from '([^']+)'/gm),
  ]
    .map(match => match[1])
    .filter(path => path.startsWith('.'))
    .map(path => posix.join(dirname(file), path))
    .filter(path => modules.includes(path))
}

/** Each cycle the imports close, written `a.ts -> b.ts -> a.ts`, found by a depth-first search. */
function cyclesOf(): string[] {
  const cycles: string[] = []
  const done = new Set<string>()
  const stack: string[] = []

  const visit = (file: string): void => {
    const at = stack.indexOf(file)
    if (at !== -1) {
      cycles.push([
        ...stack.slice(at),
        file,
      ].join(' -> '))
      return
    }
    if (done.has(file)) return
    stack.push(file)
    for (const next of importsOf(file)) visit(next)
    stack.pop()
    done.add(file)
  }

  for (const file of modules) visit(file)
  return cycles
}

describe('the core\'s imports', () => {
  it('reads the modules under src/core', () => {
    expect(modules).toContain('tokens.ts')
    expect(modules).toContain('stages/context.ts')
    expect(importsOf('clocks.ts')).toContain('ports.ts')
  })

  it('holds no runtime import cycle among the core\'s modules', () => {
    expect(cyclesOf()).toEqual([])
  })
})
