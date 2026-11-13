/**
 * The fingerprint of a configuration: the HMAC-SHA-256, under a salt the run keeps, of a canonical form
 * of the resolved settings that names no provider. The bench keys its records by it, and refuses two
 * configurations that resolve alike.
 *
 * The form holds every setting a review uses but the key: the profiles that run, in run order, each with
 * its id, prompts, lenses, policy and gating, and its research provider and each lens's provider written
 * out in place of their names; every field of a provider defined as data but its key, the values of
 * `headers`, `query` and `extraBody` and the whole base URL included; a provider object as its config key
 * and its model; `concurrency` and `maxFindings` as the review applies them, defaults filled in. It holds
 * no config-file path, no warning and no provider name, so the same settings under other names are one
 * configuration, and a rotated key keeps a run. A `claude-code` provider's resolved command path is one
 * of its settings, so it is in the form.
 *
 * The form can hold a secret (a credential kept in a header, a query parameter or the base path), so it
 * never leaves this module: not written, not logged, not put in an error message. Only the HMAC does.
 *
 * What it cannot see: a provider object's code (a changed implementation under the same key and model
 * needs a new run directory), and the environment a `claude-code` provider inherits.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { isPlainObject } from '../config/load.ts'
import type { ResolvedConfig, ResolvedProvider } from '../config/resolve.ts'
import { isProvider } from '../config/schema.ts'
import { DEFAULT_CONCURRENCY } from '../core/concurrency.ts'
import { DEFAULT_MAX_FINDINGS } from '../core/stages/research.ts'

const SALT = /^[0-9a-f]{64}$/

/** A fresh salt: 32 random bytes as 64 lowercase hex digits. */
export function newSalt(): string {
  return randomBytes(32).toString('hex')
}

/** A provider as the form holds it: a provider object by its config key and model, a spec by its fields less the key. */
function providerForm(provider: ResolvedProvider): unknown {
  if (isProvider(provider)) return { object: provider.id, model: provider.model }
  return Object.fromEntries(Object.entries(provider).filter(([field]) => field !== 'apiKey'))
}

/** The form of the provider a profile binds by `name`; a name the config holds no provider under is a RangeError, never a silent gap. */
function boundForm(config: ResolvedConfig, name: string): unknown {
  if (!Object.hasOwn(config.providers, name)) throw new RangeError('a profile names a provider the config does not hold')
  return providerForm(config.providers[name])
}

/** A plain object with its keys in code-unit order, so the text does not depend on the order the config wrote. */
function sortKeys(_key: string, value: unknown): unknown {
  return isPlainObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value
}

/**
 * The canonical text of a configuration's settings: JSON with the keys of every object sorted, arrays in
 * their order. It can hold a secret: hash it with `fingerprint`, and never write, log or print it.
 *
 * @throws {RangeError} when a profile names a provider the config does not hold.
 */
export function canonicalSettings(config: ResolvedConfig): string {
  const profiles = config.profiles.map(({ profile, research, voters }) => ({
    profile,
    research: boundForm(config, research),
    voters: Object.fromEntries(Object.entries(voters).map(([lens, name]) => [
      lens,
      boundForm(config, name),
    ])),
  }))
  return JSON.stringify({
    concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
    maxFindings: config.maxFindings ?? DEFAULT_MAX_FINDINGS,
    profiles,
  }, sortKeys)
}

/**
 * The fingerprint of a configuration under a run's salt: the HMAC-SHA-256 of its canonical settings, as 64
 * lowercase hex digits.
 *
 * @throws {RangeError} when `salt` is not 64 lowercase hex digits (the message never holds it), or a profile names a provider the config does not hold.
 */
export function fingerprint(config: ResolvedConfig, salt: string): string {
  if (!SALT.test(salt)) throw new RangeError('the salt must be 64 lowercase hex digits')
  return createHmac('sha256', Buffer.from(salt, 'hex')).update(canonicalSettings(config)).digest('hex')
}
