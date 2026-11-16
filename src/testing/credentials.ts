/**
 * Credentials for the specs, built at run time from pieces of at most eight characters: no key and no
 * private-key marker is contiguous in a source, so no scanner holds this file, nor does quorum's own
 * rule, which a review of quorum's changes would otherwise find itself in.
 */

import type { CredentialKind } from '../core/types.ts'

/** Sixty-four distinct characters, the letters and digits then `-` and `_`, in an order that holds no keyword of the rules: every slice has a high entropy. */
const ALPHABET = [
  'z9JjcfwG',
  'AR4tDdks',
  'lQXpL73T',
  'xV8vmNYO',
  'HISuUor6',
  'aMB0b1gn',
  'yPEC5Fhq',
  'eWZ2Ki-_',
].join('')

/** `length` characters of the alphabet from `start`, repeated as often as it takes. */
function mixed(length: number, start = 0): string {
  return ALPHABET.repeat(Math.ceil((start + length) / ALPHABET.length)).slice(start, start + length)
}

/** The same characters with `+` and `/` for `-` and `_`: the base64 alphabet, which a key's body is written in. */
const BODY_ALPHABET = ALPHABET.replace('-', '+').replace('_', '/')

/** One armor line, from the kind of key and what ends its name: `-----BEGIN <kind>PRIVATE KEY<tail>-----`. */
const armor = (kind: string, tail = ''): string => `-----BEGIN ${kind}PRIVATE KEY${tail}-----`

/** The armor line of each of the ten markers of the rule, in its order, none contiguous in this source. */
const ARMOR_LINES: readonly string[] = [
  armor('RSA '),
  armor('DSA '),
  armor('EC '),
  armor('OPENSSH '),
  armor(''),
  ['PuTTY-User-', 'Key-File-2: ssh-rsa'].join(''),
  armor('SSH2 ENCRYPTED '),
  armor('PGP ', ' BLOCK'),
  armor('ENCRYPTED '),
  ['-----BEGIN OpenVPN ', 'Static key V1-----'].join(''),
]

/** The armor line of the marker at `index`, 0 to 9, in the rule's order. */
export function privateKeyLine(index: number): string {
  const line = ARMOR_LINES[index]
  if (line === undefined) throw new RangeError(`index must be 0 to ${ARMOR_LINES.length - 1}`)
  return line
}

/** One 64-character line of the base64 alphabet, with digits and letters in it, as a key's body is written: a body run of the rule. */
export function privateKeyBody(): string {
  return BODY_ALPHABET
}

/**
 * One value the rule takes for `kind`, with an entropy above every floor of its rules. For
 * `private-key` it is an armor line and a body line, joined by a line feed.
 */
export function fakeCredential(kind: CredentialKind): string {
  switch (kind) {
    case 'private-key':
      return `${privateKeyLine(0)}\n${privateKeyBody()}`
    case 'aws-key':
      return ['AKIA', 'QWERTYUI', 'OP234567'].join('')
    case 'github-token':
      return [
        'ghp_',
        mixed(8),
        mixed(8, 8),
        mixed(8, 16),
        mixed(8, 24),
        mixed(4, 32),
      ].join('')
    case 'slack-token':
      return [
        'xoxb-',
        '7391028',
        '465',
        '-',
        '5820174',
        '9362',
        mixed(8),
      ].join('')
    case 'google-key':
      return [
        'AIza',
        mixed(35, 5),
      ].join('')
    case 'stripe-key':
      return [
        'sk_live_',
        mixed(8),
        mixed(8, 8),
        mixed(8, 16),
      ].join('')
    case 'anthropic-key':
      return [
        'sk-ant-',
        'api03-',
        mixed(93),
        'AA',
      ].join('')
    case 'openai-key':
      return [
        'sk-',
        mixed(20),
        'T3BlbkFJ',
        mixed(20, 20),
      ].join('')
  }
}

/**
 * A value that starts like the keys of `kind` and that no rule takes: the prefix, then one character
 * repeated to the length of the format, so its entropy is far below every floor. A kind whose rules
 * have no floor, Anthropic's, has the prefix alone.
 */
export function credentialPlaceholder(kind: Exclude<CredentialKind, 'private-key'>): string {
  switch (kind) {
    case 'aws-key':
      return `AKIA${'X'.repeat(16)}`
    case 'github-token':
      return `ghp_${'0'.repeat(36)}`
    case 'slack-token':
      return `xoxb-${'0'.repeat(10)}-${'0'.repeat(10)}`
    case 'google-key':
      return `AIza${'0'.repeat(35)}`
    case 'stripe-key':
      return `sk_live_${'0'.repeat(99)}`
    case 'anthropic-key':
      return 'sk-ant-api03-'
    case 'openai-key':
      return `sk-${'0'.repeat(48)}`
  }
}
