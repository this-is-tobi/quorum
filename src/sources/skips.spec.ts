import { describe, expect, it } from 'vitest'
import type { SkipRule } from '../core/types.ts'
import { isLfsPointer, isMinifiedContent, LFS_POINTER_BYTES, MINIFIED_LINE_AVERAGE, nameRule } from './skips.ts'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

const OID = 'a'.repeat(64)
const VERSION = 'version https://git-lfs.github.com/spec/v1\n'
const POINTER = `${VERSION}oid sha256:${OID}\nsize 12345\n`

describe('nameRule', () => {
  it.each<[string, SkipRule]>([
    ['src/.env', 'secret'],
    ['.env.local', 'secret'],
    // Any case.
    ['deploy/key.PEM', 'secret'],
    ['id_ed25519', 'secret'],
    ['prod.tfstate.backup', 'secret'],
    ['deploy/prod.tfstate', 'secret'],
    ['config/CREDENTIALS.json', 'secret'],
    ['secrets.toml', 'secret'],
    ['node_modules/x/a.js', 'vendored'],
    ['lib/vendor/b.go', 'vendored'],
    ['go.sum', 'lockfile'],
    ['web/package-lock.json', 'lockfile'],
    ['dist/app.min.js', 'minified'],
    ['app.CSS.MAP', 'minified'],
  ])('skips %s by its name as %s', (path, rule) => {
    expect(nameRule(path)).toBe(rule)
  })

  it.each([
    // A file named like a directory, and one at the top.
    'vendor.go',
    'vendor',
    // Names a secret rule does not take.
    'src/environment.ts',
    '.envrc',
    'my.env',
    'go.summary',
    'id_rsa.pub',
    'appmin.js',
    // A template the core sends once its content is clean, a .env's and a Helm chart's, and code named secrets.
    '.env.example',
    'charts/x/templates/secrets.yaml',
    'src/secrets.ts',
  ])('reviews %s', (path) => {
    expect(nameRule(path)).toBeUndefined()
  })

  it('takes secret before vendored, vendored before lockfile, lockfile before minified', () => {
    expect(nameRule('vendor/.env')).toBe('secret')
    expect(nameRule('node_modules/yarn.lock')).toBe('vendored')
    expect(nameRule('vendor/package-lock.json')).toBe('vendored')
    expect(nameRule('package-lock.json')).toBe('lockfile')
  })

  it('passes the secret rule over for a file the operator sends, to the next rule', () => {
    expect(nameRule('vendor/.env', false)).toBe('vendored')
    expect(nameRule('.env', false)).toBeUndefined()
  })
})

describe('isMinifiedContent', () => {
  it('reads linguist\'s minified rule on .js, .mjs, .cjs and .css only: lines averaging over 110 bytes', () => {
    const line = (bytes: number): Uint8Array => encode('x'.repeat(bytes))
    expect(MINIFIED_LINE_AVERAGE).toBe(110)
    expect(isMinifiedContent('a.js', line(111))).toBe(true)
    expect(isMinifiedContent('a.js', line(110))).toBe(false)
    expect(isMinifiedContent('a.ts', line(111))).toBe(false)
    for (const path of ['a.mjs', 'dir/a.cjs', 'a.css', 'a.CSS']) expect(isMinifiedContent(path, line(111))).toBe(true)
    // The mean of the lines' bytes, line feeds left out, by integer division: 220 over two lines is 110, and so is 221.
    expect(isMinifiedContent('a.js', encode(`${'x'.repeat(111)}\n${'x'.repeat(109)}`))).toBe(false)
    expect(isMinifiedContent('a.js', encode(`${'x'.repeat(111)}\n${'x'.repeat(110)}`))).toBe(false)
    expect(isMinifiedContent('a.js', encode(`${'x'.repeat(222)}\n${'x'.repeat(10)}`))).toBe(true)
    // The empty text after a last line feed is a line of no bytes, as linguist's split keeps it.
    expect(isMinifiedContent('a.js', encode(`${'x'.repeat(200)}\n`))).toBe(false)
    expect(isMinifiedContent('a.js', new Uint8Array(0))).toBe(false)
  })
})

describe('isLfsPointer', () => {
  /** A pointer of `bytes` bytes, its one extension's name padded to reach them. */
  function pointerOf(bytes: number): string {
    const head = `${VERSION}ext-0-`
    const tail = ` sha256:${OID}\noid sha256:${OID}\nsize 12345\n`
    return `${head}${'f'.repeat(bytes - head.length - tail.length)}${tail}`
  }

  it.each<[string, string, boolean]>([
    ['the three-line pointer', POINTER, true],
    ['one with an ext-0-foo line', `${VERSION}ext-0-foo sha256:${OID}\noid sha256:${OID}\nsize 12345\n`, true],
    ['one with an extra key', `${POINTER}note hi\n`, false],
    [
      'one of 1024 bytes',
      pointerOf(LFS_POINTER_BYTES),
      false,
    ],
    [
      'one with CRLF line ends',
      POINTER.replaceAll('\n', '\r\n'),
      false,
    ],
    [
      'one whose first line differs',
      POINTER.replace('spec/v1', 'spec/v2'),
      false,
    ],
  ])('reads %s as a Git LFS pointer: %s', (_name, text, expected) => {
    expect(isLfsPointer(encode(text))).toBe(expected)
  })

  it('takes a pointer one byte under the cap, and none that holds a byte outside printable ASCII', () => {
    expect(pointerOf(LFS_POINTER_BYTES - 1)).toHaveLength(LFS_POINTER_BYTES - 1)
    expect(isLfsPointer(encode(pointerOf(LFS_POINTER_BYTES - 1)))).toBe(true)
    expect(isLfsPointer(encode(`${String.fromCharCode(0xFEFF)}${POINTER}`))).toBe(false)
    expect(isLfsPointer(Uint8Array.of(...encode(POINTER), 0))).toBe(false)
    expect(isLfsPointer(encode(POINTER.replace('oid', 'oid\t')))).toBe(false)
    expect(isLfsPointer(new Uint8Array(0))).toBe(false)
  })
})
