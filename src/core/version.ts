import packageJson from '../../package.json' with { type: 'json' }

/** The version of this quorum, read from `package.json`: what a review writes as `meta.version` and what `readResult` compares it with. */
export const VERSION: string = packageJson.version
