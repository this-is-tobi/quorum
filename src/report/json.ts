import { inertJson } from '../core/sanitize.ts'
import type { Reporter } from './reporter.ts'

/** The JSON result as `inertJson` writes it, indented by two spaces, then a line feed: what the CLI wrote before it had reporters. */
export const json: Reporter = {
  render: result => `${inertJson(result)}\n`,
}
