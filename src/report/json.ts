import { inertJson } from '../core/sanitize.ts'
import type { Reporter } from './reporter.ts'

/** The JSON of its input, the result or its public view, as `inertJson` writes it, indented by two spaces, then a line feed: what the CLI wrote before it had reporters. */
export const json: Reporter = {
  render: input => `${inertJson(input)}\n`,
}
