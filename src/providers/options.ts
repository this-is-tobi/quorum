import type { ConfigIssue } from '../core/errors.ts'

const HTTP_URL_WITH_HOST = /^https?:\/\/[^/\\?#\s]/i

/** A scheme, then a host: URL parsing skips extra slashes, so `https:///v1` would otherwise send the request to a host named `v1`. */
function isHttpUrlWithHost(baseUrl: string): boolean {
  if (!HTTP_URL_WITH_HOST.test(baseUrl)) return false
  try {
    return new URL(baseUrl).host !== ''
  } catch {
    return false
  }
}

/**
 * The problems of a base URL, at `path`. No message repeats the value: a base URL can carry credentials.
 * Credentials in the URL are refused, since runtimes disagree on them (Bun sends them, Node refuses
 * the request) and a key belongs in the adapter's key option, which redaction knows about. A query or a
 * fragment is refused, since the endpoint's path is appended to the base URL.
 */
export function baseUrlIssues(path: string, baseUrl: string): ConfigIssue[] {
  if (!isHttpUrlWithHost(baseUrl)) return [{ path, message: 'must be an http:// or https:// URL with a host' }]
  const url = new URL(baseUrl)
  const issues: ConfigIssue[] = []
  if (url.username !== '' || url.password !== '') issues.push({ path, message: 'must not hold a user name or password: send a key with apiKey' })
  if (/[?#]/.test(baseUrl)) issues.push({ path, message: 'must not hold a query or a fragment' })
  return issues
}
