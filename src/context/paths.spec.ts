import { describe, expect, it } from 'vitest'
import { reportPath, reportPathsOf } from './paths.ts'

const CHECKOUT = '/home/runner/work/app/app'

describe('reportPathsOf', () => {
  it('takes the scan root, else the top level, with its trailing slash dropped', () => {
    expect(reportPathsOf(undefined, '/repo/')).toEqual({ root: '/repo', place: '' })
    expect(reportPathsOf('/scan//', '/repo')).toEqual({ root: '/scan', place: '' })
    expect(reportPathsOf(undefined, undefined)).toEqual({ place: '' })
  })

  it('names the root\'s place below the top level with a trailing slash, and no place at the top, outside it or with no top level', () => {
    expect(reportPathsOf('/repo/packages/app/', '/repo/')).toEqual({ root: '/repo/packages/app', place: 'packages/app/' })
    expect(reportPathsOf('/repo', '/repo')).toEqual({ root: '/repo', place: '' })
    expect(reportPathsOf('/repository/app', '/repo')).toEqual({ root: '/repository/app', place: '' })
    expect(reportPathsOf('/src', '/repo')).toEqual({ root: '/src', place: '' })
    expect(reportPathsOf('/repo/app', undefined)).toEqual({ root: '/repo/app', place: '' })
  })
})

describe('reportPath', () => {
  const checkout = reportPathsOf(CHECKOUT, CHECKOUT)

  it.each([
    ['src/a.js', 'src/a.js', 'path'],
    ['./src/a.js', 'src/a.js', 'path'],
    [`${CHECKOUT}/src/a.js`, 'src/a.js', 'path'],
    ['/elsewhere/src/a.js', undefined, 'path'],
    [CHECKOUT, undefined, 'path'],
    [`${CHECKOUT}/`, undefined, 'path'],
    [`${CHECKOUT}-other/src/a.js`, undefined, 'path'],
    ['src/../a.js', undefined, 'path'],
    ['src/./a.js', undefined, 'path'],
    ['../a.js', undefined, 'path'],
    ['././a.js', undefined, 'path'],
    ['src/a.js/', undefined, 'path'],
    ['src//a.js', undefined, 'path'],
    ['//src/a.js', undefined, 'path'],
    ['', undefined, 'path'],
    ['.', undefined, 'path'],
    ['./', undefined, 'path'],
    ['src/.../a.js', 'src/.../a.js', 'path'],
    ['src/..a.js', 'src/..a.js', 'path'],
    ['src/.hidden', 'src/.hidden', 'path'],
    ['src\\a.js', 'src\\a.js', 'path'],
    ['src/a%20b.js', 'src/a%20b.js', 'path'],
    ['file:///home/runner/work/app/app/src/a%20b.js', 'src/a b.js', 'uri'],
    ['file://localhost/home/runner/work/app/app/src/a.js', 'src/a.js', 'uri'],
    ['FILE:///home/runner/work/app/app/src/a.js', 'src/a.js', 'uri'],
    ['file:/home/runner/work/app/app/src/a.js', 'src/a.js', 'uri'],
    ['file://host/src/a.js', undefined, 'uri'],
    ['file:///elsewhere/src/a.js', undefined, 'uri'],
    ['file:src/a.js', undefined, 'uri'],
    ['file:', undefined, 'uri'],
    ['https://example.invalid/a.js', undefined, 'uri'],
    ['C:/a.js', undefined, 'uri'],
    ['src/%E0%A4%A.js', undefined, 'uri'],
    ['src/%252e%252e/a.js', 'src/%2e%2e/a.js', 'uri'],
    ['src/%2e%2e/a.js', undefined, 'uri'],
    ['src%2Fa.js', 'src/a.js', 'uri'],
    ['src/a%20b.js', 'src/a b.js', 'uri'],
    ['src/a.js', 'src/a.js', 'uri'],
  ] as const)('maps %s to %j', (written, mapped, kind) => {
    expect(reportPath(written, checkout, kind)).toBe(mapped)
  })

  it('puts a scan root\'s place below the top level in front of every path it maps', () => {
    const app = reportPathsOf('/repo/packages/app', '/repo')
    expect(reportPath('src/a.ts', app, 'path')).toBe('packages/app/src/a.ts')
    expect(reportPath('./src/a.ts', app, 'path')).toBe('packages/app/src/a.ts')
    expect(reportPath('/repo/packages/app/src/a.ts', app, 'path')).toBe('packages/app/src/a.ts')
    expect(reportPath('file:///repo/packages/app/src/a.ts', app, 'uri')).toBe('packages/app/src/a.ts')
    expect(reportPath('/repo/src/a.ts', app, 'path')).toBeUndefined()
    expect(reportPath('src/../a.ts', app, 'path')).toBeUndefined()
    const container = reportPathsOf('/src', '/repo')
    expect(reportPath('/src/a.ts', container, 'path')).toBe('a.ts')
    expect(reportPath('b/a.ts', container, 'path')).toBe('b/a.ts')
  })

  it('maps no absolute path with no scan root and no top level', () => {
    const none = reportPathsOf(undefined, undefined)
    expect(reportPath('/x/a.js', none, 'path')).toBeUndefined()
    expect(reportPath('file:///x/a.js', none, 'uri')).toBeUndefined()
    expect(reportPath('a.js', none, 'path')).toBe('a.js')
  })

  it('reads a root of / as the root of every absolute path', () => {
    const everything = reportPathsOf('/', '/repo')
    expect(reportPath('/x/a.js', everything, 'path')).toBe('x/a.js')
    expect(reportPath('//a.js', everything, 'path')).toBeUndefined()
  })

  it('decodes a URI once, so an encoded percent sign stays one', () => {
    expect(reportPath('src/a%2523.js', checkout, 'uri')).toBe('src/a%23.js')
  })

  it('refuses a path of a million slashes', () => {
    const slashes = '/'.repeat(1_000_000)
    expect(reportPath(`a${slashes}b`, checkout, 'path')).toBeUndefined()
    expect(reportPath(`${CHECKOUT}${slashes}`, checkout, 'path')).toBeUndefined()
  })
})
