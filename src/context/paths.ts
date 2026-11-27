/**
 * Where a report's paths stand: the scan root it was written at, and where that root stands below the repository's top level.
 * A report names its files as its scan job saw them, so a path is made the repository's own by these two alone.
 */
export interface ReportPaths {
  /** The scan root, its trailing `/` dropped: an absolute path below it is read relative to it. Absent when the review has neither a scan root nor a top level: an absolute path is then unmapped. */
  readonly root?: string
  /** The scan root's own path below the repository's top level, with a trailing `/`, put in front of every path that is mapped. `''` when the root is the top level, stands outside it or there is no top level. */
  readonly place: string
}

/** A URI's scheme, which a Windows drive letter (`C:`) matches too. */
const SCHEME = /^[A-Z][A-Z0-9+.-]*:/i

/** A path segment that is empty, `.` or `..`: a path holding one names no file quorum places. Linear in the path's length, and never splits it. */
const BAD_SEGMENT = /(?:^|\/)\.{0,2}(?:\/|$)/

/** `directory` without its trailing slashes. */
function withoutTrailingSlash(directory: string): string {
  let end = directory.length
  while (end > 0 && directory[end - 1] === '/') end -= 1
  return directory.slice(0, end)
}

/**
 * Whether `directory` can be a scan root: an absolute path whose segments are none empty, `.` or `..`, its trailing `/` aside, so `/`
 * is one. `reportPathsOf` trusts the root it is given; the flag and the library check it here, and no file system is read.
 */
export function isScanRoot(directory: string): boolean {
  if (!directory.startsWith('/')) return false
  const root = withoutTrailingSlash(directory)
  return root === '' || !BAD_SEGMENT.test(root.slice(1))
}

/**
 * The path rules' two facts, from the scan root a person gave and the repository's top level: the root is the scan root, else the top
 * level, and its place is its path below the top level. A scan root outside the top level (a container's `/src`) stands for the
 * top level itself, and the root is never resolved through the file system.
 */
export function reportPathsOf(scanRoot: string | undefined, top: string | undefined): ReportPaths {
  const given = scanRoot ?? top
  const root = given === undefined
    ? undefined
    : withoutTrailingSlash(given)
  const base = top === undefined
    ? undefined
    : withoutTrailingSlash(top)
  const place = root !== undefined && base !== undefined && root.startsWith(`${base}/`)
    ? `${root.slice(base.length + 1)}/`
    : ''
  return {
    ...(root === undefined
      ? {}
      : { root }),
    place,
  }
}

/** The path a `file` URI names, or one with no scheme, percent-decoded once; undefined for another scheme, a host other than this machine's, or a decoding that fails. */
function uriPath(uri: string): string | undefined {
  let path = uri
  const scheme = SCHEME.exec(uri)
  if (scheme !== null) {
    if (scheme[0].toLowerCase() !== 'file:') return undefined
    path = uri.slice(scheme[0].length)
    if (path.startsWith('//')) {
      const end = path.indexOf('/', 2)
      const host = (end === -1
        ? path.slice(2)
        : path.slice(2, end)).toLowerCase()
      if (host !== '' && host !== 'localhost') return undefined
      path = end === -1
        ? ''
        : path.slice(end)
    }
    if (!path.startsWith('/')) return undefined
  }
  try {
    return decodeURIComponent(path)
  } catch {
    return undefined
  }
}

/**
 * The repository path a report's path names, or undefined when quorum cannot place it. The steps, in order: for a SARIF `uri`, a
 * scheme other than `file` or a `file` host other than this machine's is unmapped, and the URI is decoded once; for every path, an
 * absolute one under the scan root loses that prefix and any other absolute one is unmapped, a leading `./` is dropped, a path
 * with an empty, `.` or `..` segment is unmapped, and the scan root's place below the top level is put in front. The result is
 * compared exactly with the diff's paths: never by suffix, and no path is opened. A backslash is a character like any other.
 */
export function reportPath(written: string, paths: ReportPaths, kind: 'uri' | 'path'): string | undefined {
  const path = kind === 'uri'
    ? uriPath(written)
    : written
  if (path === undefined) return undefined
  let relative = path
  if (path.startsWith('/')) {
    if (paths.root === undefined || !path.startsWith(`${paths.root}/`)) return undefined
    relative = path.slice(paths.root.length + 1)
  }
  if (relative.startsWith('./')) relative = relative.slice(2)
  return BAD_SEGMENT.test(relative)
    ? undefined
    : `${paths.place}${relative}`
}
