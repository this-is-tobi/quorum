import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The image is built by the CD and by hand: no test builds one or reaches a registry. These read the text
// of the two files and pin what the image promises, a binary run by a non-root user and nothing else.
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const dockerfile = read('Dockerfile')
const lines = dockerfile.split('\n')

const DIGEST = '@sha256:[0-9a-f]{64}'
const bunVersion = /^bun = "([^"]+)"$/m.exec(read('mise.toml'))?.[1] ?? ''

/** The instructions of the stage that starts at the `FROM` line matching `from`, up to the next `FROM`. */
function stage(from: RegExp): string[] {
  const start = lines.findIndex(line => line.startsWith('FROM ') && from.test(line))
  const end = lines.findIndex((line, index) => index > start && line.startsWith('FROM '))
  return lines.slice(start, end === -1
    ? undefined
    : end).filter(line => line.trim() !== '' && !line.startsWith('#'))
}

describe('the base images', () => {
  it('pins the build image by the Bun version of mise.toml and by digest, as an ARG default Renovate updates', () => {
    expect(bunVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(dockerfile).toMatch(new RegExp(`^ARG BUN_IMAGE=docker\\.io/oven/bun:${bunVersion.replaceAll('.', '\\.')}${DIGEST}$`, 'm'))
  })

  it('pins the distroless cc base, its nonroot tag, by digest, as an ARG default Renovate updates', () => {
    expect(dockerfile).toMatch(new RegExp(`^ARG RUNTIME_IMAGE=gcr\\.io/distroless/cc-debian\\d+:nonroot${DIGEST}$`, 'm'))
  })

  it('starts every stage from one of those two ARGs, never from an unpinned image', () => {
    const froms = lines.filter(line => line.startsWith('FROM '))
    expect(froms).toEqual([`FROM \${BUN_IMAGE} AS build`, `FROM \${RUNTIME_IMAGE}`])
  })
})

describe('the build stage', () => {
  const build = stage(/AS build$/)

  it('installs the production dependencies from the frozen lockfile, running no lifecycle script', () => {
    expect(build).toContain('RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache bun install --frozen-lockfile --production --ignore-scripts')
  })

  it('compiles with the compile script, whose flags package.spec.ts holds, and not with a command of its own', () => {
    expect(build).toContain('RUN bun run compile')
    expect(dockerfile).not.toMatch(/\bbun build\b/)
  })

  it('copies only what the compile needs, so the image never holds the rest of the build context', () => {
    const copies = build.filter(line => line.startsWith('COPY '))
    expect(copies).toEqual(['COPY package.json bun.lock ./', 'COPY src ./src'])
    expect(dockerfile).not.toMatch(/^COPY (--\S+ )*\. /m)
  })

  it('installs before it copies the sources, so the dependency layer is cached until the lockfile changes', () => {
    const at = (needle: string): number => build.findIndex(line => line.includes(needle))
    expect(at('bun install')).toBeGreaterThan(at('COPY package.json'))
    expect(at('bun install')).toBeLessThan(at('COPY src'))
  })
})

describe('the final stage', () => {
  const final = stage(/^FROM \$\{RUNTIME_IMAGE\}$/)

  it('holds the binary at /usr/local/bin/quorum, copied from the build stage, and nothing else', () => {
    expect(final.filter(line => line.startsWith('COPY '))).toEqual(['COPY --from=build /app/bin/quorum /usr/local/bin/quorum'])
  })

  it('runs as the nonroot user, in /work, with the binary as the entrypoint', () => {
    expect(final).toContain('USER nonroot')
    expect(final).toContain('WORKDIR /work')
    expect(final).toContain('ENTRYPOINT ["/usr/local/bin/quorum"]')
    expect(final.findIndex(line => line === 'USER nonroot')).toBeLessThan(final.findIndex(line => line.startsWith('ENTRYPOINT')))
  })

  it('runs no command, since the base has no shell, and sets no CMD that an argument would have to override', () => {
    expect(final.filter(line => /^(?:RUN|CMD|ENV|ADD) /.test(line))).toEqual([])
  })
})

describe('.dockerignore', () => {
  const ignored = read('.dockerignore').split('\n').map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))

  it.each([
    '.git',
    'node_modules',
    'dist',
    'bin',
    '.local',
    '.superpowers',
    'bench',
    'quorum-bench',
  ])('keeps %s out of the build context', (entry) => {
    expect(ignored).toContain(entry)
  })

  it('keeps the environment files and the coverage reports out of the build context too', () => {
    expect(ignored).toContain('.env*')
    expect(ignored).toContain('coverage')
  })
})
