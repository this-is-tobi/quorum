/**
 * What a result records of a provider's settings, starting with the one field no reader may take on trust:
 * `extraBody`. Quorum sends it as the body of every request, to servers it does not know, and a proxy
 * in front of a model may take a credential or an end user's personal data there (OpenAI's `user` names
 * one). So a record writes a value only when a rule that fails closed finds it safe, and writes
 * `[redacted]` for anything it cannot show safe: a value that is no number, boolean, `null` or short
 * string, a string that holds a credential of the hold rules, an e-mail address, the provider's own key
 * or a long run that mixes letters and digits, a value under a key that names a secret, an entry
 * nested past four levels or holding more than 64 values, and a key that is no safe string, which
 * leaves one entry of `[redacted]` for key and value.
 *
 * @see ../../docs/30-security/10-threat-model.md#what-a-result-records-of-a-provider for what a reader sees.
 */

import { EXTRA_BODY_DEPTH, EXTRA_BODY_STRING, EXTRA_BODY_VALUES, REDACTED } from '../core/result-schema.ts'
import { credentialIn } from '../core/secrets.ts'

/** The fewest characters of a run, with no white space, that mixes letters and digits and so reads as an opaque token: a model id, a UUID, a key's body. */
export const OPAQUE_RUN = 20

/** The words of a key that name a secret, compared whole with the words `keyWords` splits it into. */
export const SECRET_WORDS: readonly string[] = Object.freeze([
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'auth',
  'authorization',
  'credential',
  'cookie',
  'session',
  'bearer',
  'signature',
  'user',
  'email',
])

/** What names a secret when it is anywhere in a key's letters, lower-cased and joined: it catches `apikey` and `userpassword`, which hold no word of `SECRET_WORDS` apart. */
export const SECRET_PARTS: readonly string[] = Object.freeze([
  'apikey',
  'accesskey',
  'privatekey',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'authorization',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'sessionid',
  'sessiontoken',
  'bearer',
  'cookie',
  'username',
  'email',
])

/** An e-mail address anywhere in a text: a name, an `@`, then a domain with a `.` between two of its characters, none of them white space or `@`. */
export const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/

/**
 * The words of a key, lower-cased: it splits where a lower-case letter or a digit meets an upper-case
 * one, before an upper-case letter that starts a word after another (`XAuthToken` is `x`, `auth`, `token`),
 * and on anything that is no letter or digit, so `maxTokens`, `max_tokens` and `max-tokens` are one.
 */
export function keyWords(key: string): string[] {
  return key
    .replaceAll(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replaceAll(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word !== '')
    .map(word => word.toLowerCase())
}

/**
 * Whether a key reads as naming a secret: one of its words is in `SECRET_WORDS`, or its letters,
 * lower-cased and joined with every other character removed, hold a `SECRET_PARTS` entry. So `apiKey`,
 * `X-Auth-Token`, `apikey` and `userpassword` do, and `keyword`, `monkey` and `max_tokens` do not.
 */
export function namesSecret(key: string): boolean {
  if (keyWords(key).some(word => SECRET_WORDS.includes(word))) return true
  const letters = key.replaceAll(/\P{L}/gu, '').toLowerCase()
  return SECRET_PARTS.some(part => letters.includes(part))
}

/** Whether a text holds a run of `OPAQUE_RUN` characters or more, with no white space, that has a letter and a digit. A hidden character is no white space, so it joins the runs it sits between. */
function holdsOpaqueRun(text: string): boolean {
  return text.split(/\s+/u).some(run => run.length >= OPAQUE_RUN && /\p{L}/u.test(run) && /\p{N}/u.test(run))
}

/**
 * Whether a string may be written: at most `EXTRA_BODY_STRING` code points (a surrogate pair is one), and
 * no credential of the hold rules, no e-mail address, not the provider's key (case and all; a missing or
 * empty key is none to look for) and no opaque run. The length is read first, and a text of more than
 * twice the limit in UTF-16 units is refused without another look, so a huge value costs nothing.
 */
export function safeString(text: string, apiKey: string | undefined): boolean {
  if (text.length > 2 * EXTRA_BODY_STRING || Array.from(text).length > EXTRA_BODY_STRING) return false
  const holdsKey = apiKey !== undefined && apiKey !== '' && text.includes(apiKey)
  return !holdsKey && credentialIn(text) === undefined && !EMAIL.test(text) && !holdsOpaqueRun(text)
}

/**
 * Whether an entry's value nests at most `EXTRA_BODY_DEPTH` levels of objects and arrays and holds at most
 * `EXTRA_BODY_VALUES` values, each object and array counted as one, a hole of an array one too. An
 * array or an object whose length passes what is left is refused before any of it is read, so a sparse
 * array of 20 million holes costs one comparison, and a cycle ends at its depth.
 */
function fitsBounds(entry: unknown): boolean {
  let left = EXTRA_BODY_VALUES
  const visit = (value: unknown, depth: number): boolean => {
    if (left-- <= 0) return false
    if (typeof value !== 'object' || value === null) return true
    if (depth > EXTRA_BODY_DEPTH) return false
    const children: readonly unknown[] = Array.isArray(value)
      ? value
      : Object.values(value)
    if (children.length > left) return false
    for (const child of children) {
      if (!visit(child, depth + 1)) return false
    }
    return true
  }
  return visit(entry, 1)
}

/** Whether a value is an object a config holds, made by `{}` or by a parser: any other (a map, a date, a class's) is not walked. */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** An object's entries by the rule: its object redacted whole when a key itself is no safe string, else each value redacted or walked, a value under a key that names a secret redacted whole. */
function walkObject(object: Record<string, unknown>, apiKey: string | undefined): unknown {
  const entries = Object.entries(object)
  if (!entries.every(([key]) => safeString(key, apiKey))) return REDACTED
  return Object.fromEntries(entries.map(([key, value]) => [
    key,
    namesSecret(key)
      ? REDACTED
      : walk(value, apiKey),
  ]))
}

/** One value by the rule: a finite number, a boolean, `null` or a safe string as it is, an array or an object walked, and anything else redacted. */
function walk(value: unknown, apiKey: string | undefined): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value
      : REDACTED
  }
  if (typeof value === 'boolean' || value === null) return value
  if (typeof value === 'string') {
    return safeString(value, apiKey)
      ? value
      : REDACTED
  }
  if (Array.isArray(value)) return Array.from(value, item => walk(item, apiKey))
  if (typeof value === 'object' && isPlainObject(value)) return walkObject(value, apiKey)
  return REDACTED
}

/** One top-level entry by the rule: its value `[redacted]` when its key names a secret or its value nests too deep or holds too many values, else walked. */
function entryValue(key: string, value: unknown, apiKey: string | undefined): unknown {
  return namesSecret(key) || !fitsBounds(value)
    ? REDACTED
    : walk(value, apiKey)
}

/**
 * A provider's `extraBody` as a result records it: each top-level entry whose key is a safe string
 * (`safeString`, and not the redacted word itself) with its key as it is and its value by the rule, or
 * `[redacted]` when its key names a secret or its value nests too deep or holds too many values. An
 * entry whose key is no safe string is dropped, and the record holds one entry, `[redacted]` for key
 * and value, where the first of them stood, however many there were. `apiKey` is the provider's
 * resolved key, which no key and no value may hold, or `undefined`. Each entry is bounded alone.
 */
export function extraBodyRecord(body: Readonly<Record<string, unknown>>, apiKey: string | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).map(([key, value]) => key === REDACTED || !safeString(key, apiKey)
    ? [REDACTED, REDACTED]
    : [
        key,
        entryValue(key, value, apiKey),
      ]))
}
