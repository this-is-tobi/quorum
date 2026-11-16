import type { SkipRule } from '../core/types.ts'

/**
 * What a path review skips by default, as constants a source reads and no tree can change. The lists come
 * from linguist's `vendor.yml` and `generated.rb`, the ecosystems the bench covers (Python, JavaScript and
 * TypeScript, Go, Rust, PHP, Java and Kotlin, Ruby, C#) and the names secret scanners look for. Nothing here
 * reads a `.gitattributes`: a pull request writes it, and a tree can still shape a file to match a rule, which
 * is why each skip is listed and the flag reviews them all.
 *
 * @see ../../docs/20-using/15-sources.md#what-a-path-review-skips for what each rule takes and why.
 */

/** The average line length, in bytes, above which a `.js`, `.mjs`, `.cjs` or `.css` file is minified: linguist's. */
export const MINIFIED_LINE_AVERAGE = 110

/** A Git LFS pointer is shorter than this, in bytes. */
export const LFS_POINTER_BYTES = 1024

/** The directories whose files are another project's, matched on a directory segment of the path and never on the file's own name. */
export const VENDORED_DIRECTORIES: readonly string[] = Object.freeze([
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor',
  'Vendor',
  'vendors',
  'third_party',
  'third-party',
  'thirdparty',
  'Pods',
  'Carthage',
])

/** The names of lockfiles, matched on the file's own name. */
export const LOCKFILES: readonly string[] = Object.freeze([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'poetry.lock',
  'Pipfile.lock',
  'pdm.lock',
  'uv.lock',
  'go.sum',
  'go.work.sum',
  'Cargo.lock',
  'composer.lock',
  'gradle.lockfile',
  'Gemfile.lock',
  'packages.lock.json',
  'paket.lock',
])

/** What a minified file's name ends with, in any case. */
export const MINIFIED_SUFFIXES: readonly string[] = Object.freeze([
  '.min.js',
  '.min.mjs',
  '.min.cjs',
  '.min.css',
  '.js.map',
  '.mjs.map',
  '.cjs.map',
  '.css.map',
])

/** The names of files that hold a secret, matched whole. */
export const SECRET_NAMES: readonly string[] = Object.freeze([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  '.htpasswd',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
])

/** A name that starts with this holds a secret: `.env.local`, and `.env.example` too, since a template can hold a key pasted in. */
export const SECRET_PREFIX = '.env.'

/** What the name of a file that holds a secret ends with, in any case. */
export const SECRET_SUFFIXES: readonly string[] = Object.freeze([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.kdbx',
  '.tfstate',
  '.tfstate.backup',
])

const VENDORED: ReadonlySet<string> = new Set(VENDORED_DIRECTORIES)
const LOCKFILE_NAMES: ReadonlySet<string> = new Set(LOCKFILES)
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set(SECRET_NAMES)
const MINIFIED_CONTENT_SUFFIXES: readonly string[] = ['.js', '.mjs', '.cjs', '.css']

/** The last segment of a path. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function endsWithAny(name: string, suffixes: readonly string[]): boolean {
  const lower = name.toLowerCase()
  return suffixes.some(suffix => lower.endsWith(suffix))
}

/**
 * The rule that skips a file by its path alone, or undefined when none does. The rules are taken in this
 * order, so a file that fits several is listed under the first: `secret` (the file's name is one of the
 * names, starts with `.env.` or ends in one of the suffixes, in any case), `vendored` (a directory of the
 * path, the file's own name aside, is one of the vendored ones: `vendor.go` is reviewed, and so is a file
 * named `vendor`), `lockfile` (the name is a lockfile's) and `minified` (the name ends in a minified
 * suffix, in any case). A secret is taken before anything, so a `vendor/.env` is still flagged.
 */
export function nameRule(path: string): SkipRule | undefined {
  const name = nameOf(path)
  if (SECRET_FILE_NAMES.has(name) || name.startsWith(SECRET_PREFIX) || endsWithAny(name, SECRET_SUFFIXES)) return 'secret'
  if (path.split('/').slice(0, -1).some(directory => VENDORED.has(directory))) return 'vendored'
  if (LOCKFILE_NAMES.has(name)) return 'lockfile'
  if (endsWithAny(name, MINIFIED_SUFFIXES)) return 'minified'
  return undefined
}

const LINE_FEED = 0x0A

/**
 * Whether linguist's rule calls a file minified by its lines, applied to `.js`, `.mjs`, `.cjs` and `.css`
 * files only, in any case of the extension: the bytes of its lines, line feeds left out, average over
 * `MINIFIED_LINE_AVERAGE` by integer division. The lines are the pieces of a split at the line feeds that
 * keeps the empty piece after a last one, as linguist's `split("\n", -1)` does, so one long line that ends
 * with a line feed counts as two. Applied to every kind of file the rule would let an author skip a file
 * by its line length; on these four kinds it costs the narrowest reach. An empty file is no minified one.
 */
export function isMinifiedContent(path: string, content: Uint8Array): boolean {
  if (!endsWithAny(path, MINIFIED_CONTENT_SUFFIXES)) return false
  let lineFeeds = 0
  for (let at = content.indexOf(LINE_FEED); at !== -1; at = content.indexOf(LINE_FEED, at + 1)) lineFeeds++
  const lines = lineFeeds + 1
  return Math.floor((content.length - lineFeeds) / lines) > MINIFIED_LINE_AVERAGE
}

/** A pointer, whole: its version line, any extensions (`ext-<digit>-<name>`), then `oid` and `size`, and nothing else, each line ended by a line feed. */
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:ext-\d-[\w-]+ sha256:[0-9a-f]{64}\n)*oid sha256:[0-9a-f]{64}\nsize \d+\n$/
const POINTER_DECODER = new TextDecoder('utf-8', { ignoreBOM: true })

/**
 * Whether a file is a Git LFS pointer, as strictly as the spec writes one: under `LFS_POINTER_BYTES` bytes,
 * and exactly the version line `version https://git-lfs.github.com/spec/v1`, any `ext-<digit>-<name>
 * sha256:<64 hex>` lines, `oid sha256:<64 hex>` and `size <digits>`, each ended by a line feed, with
 * nothing else. A byte outside printable ASCII and the line feed, a carriage return among them, is no
 * pointer. A pointer holds no code, so skipping one hides none, which is why a path review skips it even
 * with the default skips off; and any file that is not exactly one is reviewed.
 */
export function isLfsPointer(content: Uint8Array): boolean {
  return content.length < LFS_POINTER_BYTES && LFS_POINTER.test(POINTER_DECODER.decode(content))
}
