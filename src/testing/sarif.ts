/**
 * What GitHub's code scanning reads of a SARIF file, as a schema the specs of the `sarif` reporter parse its
 * documents with: strict where GitHub requires a field, so a document that misses one fails, and open elsewhere,
 * since GitHub ignores the rest. One result that breaks it makes GitHub refuse the whole upload.
 */

import { z } from 'zod'

/** A text GitHub requires non-empty: `{ text }`. */
const required = z.looseObject({
  text: z.string().min(1),
})

/** An artifact's URI: relative, so no scheme and no leading slash, and never empty. */
const uri = z.string().min(1).regex(/^(?![a-z][a-z0-9+.-]*:)(?!\/)/i)

const line = z.number().int().min(1)

const region = z.looseObject({
  startLine: line,
  startColumn: line,
  endLine: line,
  endColumn: line,
}).refine(({ startLine, startColumn, endLine, endColumn }) => endLine > startLine || (endLine === startLine && endColumn >= startColumn), {
  message: 'the region ends before it starts',
})

const rule = z.looseObject({
  id: z.string().min(1),
  shortDescription: required,
  fullDescription: required,
  help: required,
})

const result = z.looseObject({
  message: required,
  level: z.enum(['note', 'warning', 'error']).optional(),
  locations: z.array(z.looseObject({
    physicalLocation: z.looseObject({
      artifactLocation: z.looseObject({ uri }),
      region,
    }),
  })).min(1),
  partialFingerprints: z.record(z.string(), z.string().min(1)),
})

/** The fields of a SARIF document that GitHub's code scanning reads. */
export const githubSarif = z.looseObject({
  $schema: z.string().min(1),
  version: z.literal('2.1.0'),
  runs: z.array(z.looseObject({
    tool: z.looseObject({
      driver: z.looseObject({
        name: z.string().min(1),
        rules: z.array(rule),
      }),
    }),
    results: z.array(result),
  })).min(1),
})
