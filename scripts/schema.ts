import { mkdirSync, writeFileSync } from 'node:fs'
import { configJsonSchema } from '../src/config/schema.ts'

// The JSON Schema editors read for a YAML or JSON config. src/config/schema.spec.ts fails when the
// committed file differs from what this writes, so run `bun run schema` after changing the zod schema.
const target = new URL('../schema/quorum.schema.json', import.meta.url)
mkdirSync(new URL('.', target), { recursive: true })
writeFileSync(target, `${JSON.stringify(configJsonSchema(), null, 2)}\n`)
