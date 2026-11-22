import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { defaultStateDirectory } from './default.ts'

const REPOSITORY = '/work/repo'
const KEY = createHash('sha256').update(REPOSITORY).digest('hex').slice(0, 12)

describe('defaultStateDirectory', () => {
  it.each<[string, { readonly env: Record<string, string | undefined>, readonly platform: string }, string | undefined]>([
    [
      'under an absolute XDG_CACHE_HOME',
      {
        env: { XDG_CACHE_HOME: '/xdg/cache', HOME: '/home/me' },
        platform: 'linux',
      },
      `/xdg/cache/quorum/state/${KEY}`,
    ],
    [
      'under an absolute XDG_CACHE_HOME with no HOME',
      {
        env: { XDG_CACHE_HOME: '/xdg/cache' },
        platform: 'linux',
      },
      `/xdg/cache/quorum/state/${KEY}`,
    ],
    [
      'under HOME/.cache when XDG_CACHE_HOME is relative',
      {
        env: { XDG_CACHE_HOME: 'cache', HOME: '/home/me' },
        platform: 'linux',
      },
      `/home/me/.cache/quorum/state/${KEY}`,
    ],
    [
      'under HOME/.cache with no XDG_CACHE_HOME',
      {
        env: { HOME: '/home/me' },
        platform: 'linux',
      },
      `/home/me/.cache/quorum/state/${KEY}`,
    ],
    [
      'under HOME/Library/Caches on macOS',
      {
        env: { HOME: '/Users/me' },
        platform: 'darwin',
      },
      `/Users/me/Library/Caches/quorum/state/${KEY}`,
    ],
    [
      'under HOME/Library/Caches on macOS, whatever XDG_CACHE_HOME says',
      {
        env: { XDG_CACHE_HOME: '/xdg/cache', HOME: '/Users/me' },
        platform: 'darwin',
      },
      `/Users/me/Library/Caches/quorum/state/${KEY}`,
    ],
    [
      'nowhere when HOME is relative',
      {
        env: { HOME: 'me' },
        platform: 'linux',
      },
      undefined,
    ],
    [
      'nowhere with no HOME',
      { env: {}, platform: 'linux' },
      undefined,
    ],
    [
      'nowhere on Windows',
      {
        env: { HOME: '/home/me', XDG_CACHE_HOME: '/xdg/cache' },
        platform: 'win32',
      },
      undefined,
    ],
  ])('places the default state directory %s', (_name, { env, platform }, expected) => {
    expect(defaultStateDirectory({ env, platform, repository: REPOSITORY })).toBe(expected)
  })

  it('keys it by the first 12 hex characters of the SHA-256 of the repository\'s top level', () => {
    const env = { HOME: '/home/me' }
    const one = defaultStateDirectory({ env, platform: 'linux', repository: '/work/one' })
    const other = defaultStateDirectory({ env, platform: 'linux', repository: '/work/other' })
    expect(one).toBe(`/home/me/.cache/quorum/state/${createHash('sha256').update('/work/one').digest('hex').slice(0, 12)}`)
    expect(one).toMatch(/\/[0-9a-f]{12}$/)
    expect(other).not.toBe(one)
    expect(defaultStateDirectory({ env, platform: 'linux', repository: '/work/one' })).toBe(one)
  })
})
