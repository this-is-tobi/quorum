import type { QuorumConfig } from './schema.ts'

/**
 * The config it is given, as it is: a TS config that imports quorum as a library wraps its default
 * export in it, so the editor checks every field. A config the binary runs cannot import the package, and
 * types its object with `import type { QuorumConfig }` and `satisfies QuorumConfig` instead.
 *
 * @example
 * export default defineConfig({ providers: { local: { preset: 'ollama', model: 'qwen3.6:27b' } } })
 */
export function defineConfig(config: QuorumConfig): QuorumConfig {
  return config
}
