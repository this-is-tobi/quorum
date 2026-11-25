import { describe, expect, it } from 'vitest'
import { EXTRA_BODY_DEPTH, EXTRA_BODY_STRING, EXTRA_BODY_VALUES, REDACTED } from '../core/result-schema.ts'
import { SECRET_RULES } from '../core/secrets.ts'
import type { CredentialKind } from '../core/types.ts'
import { fakeCredential } from '../testing/credentials.ts'
import { EMAIL, extraBodyRecord, keyWords, namesSecret, OPAQUE_RUN, safeString, SECRET_PARTS, SECRET_WORDS } from './settings.ts'

const KINDS = SECRET_RULES.filter((rule): rule is CredentialKind => rule !== 'name')
/** The resolved key of the provider the rows belong to: 9 characters, no run of 20. */
const API_KEY = ['loc', 'al-', 'k3y'].join('')
const AWS_KEY = fakeCredential('aws-key')
const SENTENCE = 'Reply in 2 short lines and cite 1 file per claim'
const NINETEEN = 'ab12cd34ef56gh78ij9'
const UUID = [
  '123e4567',
  'e89b',
  '12d3',
  'a456',
  '426614174000',
].join('-')
const PAIR = String.fromCodePoint(0x1F600)

/** An array of `length` slots with a value in the first and the last only: the rest are holes. */
function sparse(length: number): unknown[] {
  const holes: unknown[] = []
  holes[0] = 1
  holes[length - 1] = 3
  return holes
}

/** An array whose length is 20 million and that holds no value: building a copy of it would take 160 MB. */
function emptySparse(): unknown[] {
  const holes: unknown[] = []
  holes.length = 20_000_000
  return holes
}
/** Credentials of the hold rules that are shorter than an opaque run, so only the credential check refuses them: a Stripe key and a legacy Slack token. */
const SHORT_CREDENTIALS = [
  ['sk_', 'live_', 'aB3dE6gH9j'].join(''),
  ['xo', 'xa-', 'zJ9fAk3q'].join(''),
]

/** An object nested `levels` deep: `{ a: { a: ... leaf } }`. */
function nested(levels: number, leaf: unknown): unknown {
  return levels === 0
    ? leaf
    : {
        a: nested(levels - 1, leaf),
      }
}

/** `length` copies of one, as one array. */
function ones(length: number): unknown[] {
  return Array.from({ length }).fill(1)
}

/** What the rule writes of one entry under a key, for the provider whose key is `API_KEY`. */
function written(key: string, value: unknown): unknown {
  return extraBodyRecord({ [key]: value }, API_KEY)[key]
}

// The rows are [label, expected, key, value]: the title shows the label and the expected value.
const SAFE: ReadonlyArray<readonly [string, unknown, string, unknown]> = [
  [
    'reasoning_effort: medium',
    'medium',
    'reasoning_effort',
    'medium',
  ],
  [
    'temperature: 0.2',
    0.2,
    'temperature',
    0.2,
  ],
  ['seed: null', null, 'seed', null],
  [
    'stream_options',
    { include_usage: true },
    'stream_options',
    { include_usage: true },
  ],
  [
    'chat_template_kwargs',
    { enable_thinking: false },
    'chat_template_kwargs',
    { enable_thinking: false },
  ],
  [
    'stop: two sequences',
    ['</answer>', '\n\n'],
    'stop',
    ['</answer>', '\n\n'],
  ],
  [
    'keyword: route-a',
    'route-a',
    'keyword',
    'route-a',
  ],
  [
    'monkey: banana',
    'banana',
    'monkey',
    'banana',
  ],
  ['tokens: 12', 12, 'tokens', 12],
  [
    'max_completion_tokens: 4096',
    4096,
    'max_completion_tokens',
    4096,
  ],
  [
    'a sentence of 48 characters with two digits',
    SENTENCE,
    'hint',
    SENTENCE,
  ],
  [
    'a 19-character mixed string',
    NINETEEN,
    'tag',
    NINETEEN,
  ],
  [
    'a four-level object',
    nested(4, 1),
    'options',
    nested(4, 1),
  ],
  [
    'an object with no prototype',
    { a: 1 },
    'options',
    Object.assign(Object.create(null) as object, { a: 1 }),
  ],
  [
    'an array with a hole, which counts as a value and reads as one that is redacted',
    [1, REDACTED, 3],
    'v',
    sparse(3),
  ],
  [
    'an array of 63 numbers, 64 values with the array',
    ones(63),
    'bias',
    ones(63),
  ],
]

const REDACTED_ROWS: ReadonlyArray<readonly [string, unknown, string, unknown]> = [
  ...KINDS.map(kind => [
    `a ${kind}`,
    REDACTED,
    'v',
    fakeCredential(kind),
  ] as const),
  [
    'an object with a key that names a secret',
    { a: 1, api_key: REDACTED },
    'options',
    { a: 1, api_key: 'abc' },
  ],
  [
    'an object that holds an AWS key',
    { owner: 'team', note: REDACTED },
    'metadata',
    { owner: 'team', note: AWS_KEY },
  ],
  [
    'the provider\'s key under an innocent name',
    REDACTED,
    'innocent',
    API_KEY,
  ],
  [
    'the provider\'s key inside a longer string',
    REDACTED,
    'v',
    `x-${API_KEY}-y`,
  ],
  [
    'the provider\'s key two levels down',
    {
      a: { b: REDACTED },
    },
    'v',
    {
      a: { b: API_KEY },
    },
  ],
  [
    'the provider\'s key in a list',
    [REDACTED, 'ok'],
    'v',
    [API_KEY, 'ok'],
  ],
  ['apiKey', REDACTED, 'apiKey', 'abc'],
  [
    'X-Auth-Token',
    REDACTED,
    'X-Auth-Token',
    'abc',
  ],
  [
    'sessionId',
    REDACTED,
    'sessionId',
    'abc',
  ],
  [
    'clientSecret',
    REDACTED,
    'clientSecret',
    'abc',
  ],
  ['a UUID', REDACTED, 'v', UUID],
  [
    'a 30-character model id',
    REDACTED,
    'v',
    'qwen3-coder-480b-a35b-instruct',
  ],
  [
    '65 characters',
    REDACTED,
    'v',
    'a'.repeat(65),
  ],
  [
    'Infinity',
    REDACTED,
    'v',
    Number.POSITIVE_INFINITY,
  ],
  ['NaN', REDACTED, 'v', Number.NaN],
  ['undefined', REDACTED, 'v', undefined],
  [
    'a function',
    REDACTED,
    'v',
    () => 1,
  ],
  ['a bigint', REDACTED, 'v', 10n],
  [
    'a date',
    REDACTED,
    'v',
    new Date(0),
  ],
  [
    'a map',
    REDACTED,
    'v',
    new Map([
      ['a', 1],
    ]),
  ],
  [
    'a five-level object',
    REDACTED,
    'v',
    nested(5, 1),
  ],
  [
    'a 70-entry array',
    REDACTED,
    'v',
    ones(70),
  ],
  [
    'a sparse array of 20 million holes',
    REDACTED,
    'v',
    emptySparse(),
  ],
  [
    'a sparse array of 64 slots, 65 values with the array',
    REDACTED,
    'v',
    sparse(64),
  ],
  [
    'an array of 64 numbers, 65 values with the array',
    REDACTED,
    'v',
    ones(64),
  ],
  [
    'an object whose array and entries make 65 values',
    REDACTED,
    'v',
    {
      a: ones(61),
      b: 1,
      c: 1,
    },
  ],
  [
    'an object keyed by an AWS key',
    REDACTED,
    'v',
    { [AWS_KEY]: true },
  ],
  [
    'an object keyed by the provider\'s key',
    REDACTED,
    'v',
    { [API_KEY]: 1 },
  ],
  [
    'an object keyed by a long model id',
    REDACTED,
    'v',
    { 'qwen3-coder-480b-a35b-instruct': 1 },
  ],
  ['user', REDACTED, 'user', 'ci-bot'],
  [
    'email_hint',
    REDACTED,
    'email_hint',
    'x',
  ],
  ['apikey', REDACTED, 'apikey', 'abc'],
  [
    'userpassword',
    REDACTED,
    'userpassword',
    'abc',
  ],
  [
    'sessionid',
    REDACTED,
    'sessionid',
    'abc',
  ],
  [
    'a number under a key that names a secret',
    REDACTED,
    'secret_seed',
    12,
  ],
  [
    'an e-mail address under an innocent key',
    REDACTED,
    'owner',
    'dev@example.org',
  ],
  [
    'an e-mail address inside a sentence',
    REDACTED,
    'note',
    'mail dev@example.org now',
  ],
]

describe('extraBodyRecord', () => {
  it.each(SAFE)('writes the extraBody value %s as %j', (_label, expected, key, value) => {
    expect(written(key, value)).toEqual(expected)
  })

  it.each(REDACTED_ROWS)('writes the extraBody value %s as %j', (_label, expected, key, value) => {
    expect(written(key, value)).toEqual(expected)
  })

  it('keeps each top-level key as it is and in order, whatever its value becomes', () => {
    const record = extraBodyRecord({
      b: 1,
      apiKey: 'abc',
      a: 'medium',
      'x-y': Infinity,
    }, API_KEY)

    expect(Object.entries(record)).toEqual([
      ['b', 1],
      ['apiKey', REDACTED],
      ['a', 'medium'],
      ['x-y', REDACTED],
    ])
  })

  it.each([
    ['the AWS test key', AWS_KEY],
    ['the provider\'s key', API_KEY],
    ['an e-mail address', 'dev@example.org'],
    ['a 30-character model id', 'qwen3-coder-480b-a35b-instruct'],
    [
      'a key of 1000 characters',
      'k'.repeat(1000),
    ],
    [
      'a private key\'s armor line and body',
      fakeCredential('private-key'),
    ],
    ['the redacted word itself', REDACTED],
  ])('writes a top-level key that is %s as one [redacted] entry, in the place it stood', (_label, key) => {
    const record = extraBodyRecord({
      before: 1,
      [key]: 'medium',
      reasoning_effort: 'medium',
    }, API_KEY)

    expect(Object.entries(record)).toEqual([
      ['before', 1],
      [REDACTED, REDACTED],
      ['reasoning_effort', 'medium'],
    ])
  })

  it('writes one [redacted] entry however many keys are refused, where the first stood', () => {
    const record = extraBodyRecord({
      [AWS_KEY]: 1,
      ok: 2,
      [API_KEY]: 3,
      'dev@example.org': { a: 4 },
      reasoning_effort: 'medium',
    }, API_KEY)

    expect(Object.entries(record)).toEqual([
      [REDACTED, REDACTED],
      ['ok', 2],
      ['reasoning_effort', 'medium'],
    ])
  })

  it('reads the provider\'s key as a top-level key only when it has one', () => {
    expect(extraBodyRecord({ [API_KEY]: 1 }, undefined)).toEqual({ [API_KEY]: 1 })
    expect(extraBodyRecord({ [API_KEY]: 1 }, '')).toEqual({ [API_KEY]: 1 })
  })

  it('refuses an array by its length without reading one of its elements', () => {
    const reads: string[] = []
    const huge = new Proxy(emptySparse(), {
      get(target, property, receiver): unknown {
        if (typeof property === 'string') reads.push(property)
        return Reflect.get(target, property, receiver)
      },
    })

    expect(written('v', huge)).toBe(REDACTED)
    expect(reads.filter(property => /^\d+$/.test(property))).toEqual([])
  })

  it('counts the values of each entry alone, never those of the whole body', () => {
    expect(extraBodyRecord({
      a: ones(63),
      b: ones(63),
    }, API_KEY)).toEqual({
      a: ones(63),
      b: ones(63),
    })
  })

  it('redacts every value of a provider with no key the same way, the key check skipped', () => {
    const body = {
      effort: 'medium',
      tag: NINETEEN,
      model: 'qwen3-coder-480b-a35b-instruct',
      token: AWS_KEY,
      options: { a: AWS_KEY, b: 2, api_key: 'abc' },
      user: 'ci-bot',
    }
    const withKey = extraBodyRecord(body, API_KEY)

    expect(extraBodyRecord(body, undefined)).toEqual(withKey)
    expect(extraBodyRecord(body, '')).toEqual(withKey)
    expect(withKey).toEqual({
      effort: 'medium',
      tag: NINETEEN,
      model: REDACTED,
      token: REDACTED,
      options: { a: REDACTED, b: 2, api_key: REDACTED },
      user: REDACTED,
    })
    // With no key to compare with, the 9 characters that were the key are only a short string.
    expect(extraBodyRecord({ innocent: API_KEY }, undefined)).toEqual({ innocent: API_KEY })
    expect(extraBodyRecord({ innocent: API_KEY }, '')).toEqual({ innocent: API_KEY })
  })

  it('writes an own __proto__ key as a plain entry and never as a prototype', () => {
    const body = JSON.parse('{"x":{"__proto__":{"polluted":1}}}') as Record<string, unknown>
    const record = extraBodyRecord(body, API_KEY)
    const inner = record.x as Record<string, unknown>

    expect(Object.getPrototypeOf(inner)).toBe(Object.prototype)
    expect(Object.hasOwn(inner, '__proto__')).toBe(true)
    expect(inner.polluted).toBeUndefined()
  })

  it('redacts a cycle, the depth bound ending its walk', () => {
    const loop: Record<string, unknown> = {}
    loop.again = loop

    expect(written('v', loop)).toBe(REDACTED)
  })
})

describe('keyWords', () => {
  it.each([
    [
      'max_tokens',
      ['max', 'tokens'],
    ],
    [
      'maxTokens',
      ['max', 'tokens'],
    ],
    [
      'XAuthToken',
      ['x', 'auth', 'token'],
    ],
    [
      'x-api-key',
      ['x', 'api', 'key'],
    ],
    [
      'OAuthToken',
      ['o', 'auth', 'token'],
    ],
    [
      'keyword',
      ['keyword'],
    ],
    [
      'top_k',
      ['top', 'k'],
    ],
    [
      'HTTPServer2Key',
      ['http', 'server2', 'key'],
    ],
    [
      '__a..b  c__',
      ['a', 'b', 'c'],
    ],
    ['', []],
  ])('splits the key %s into %j', (key, words) => {
    expect(keyWords(key)).toEqual(words)
  })
})

describe('namesSecret', () => {
  it.each([
    ['apikey', true],
    ['userpassword', true],
    ['sessionid', true],
    ['useremail', true],
    ['x-api-key', true],
    ['OAuthToken', true],
    ['api2key', true],
    ['API_KEY', true],
    ['Authorization', true],
    ['pass_phrase', true],
    ['max_tokens', false],
    ['maxTokens', false],
    ['keyword', false],
    ['monkey', false],
    ['top_k', false],
    ['author', false],
    ['reasoning_effort', false],
  ])('reads the key %s as naming a secret: %s', (key, named) => {
    expect(namesSecret(key)).toBe(named)
  })

  it('reads a word of the key that a hidden character splits', () => {
    expect(namesSecret(`api${String.fromCharCode(0x200B)}key`)).toBe(true)
  })
})

describe('safeString', () => {
  it('writes a value of 64 code points and redacts one of 65, counting a surrogate pair as one', () => {
    expect(EXTRA_BODY_STRING).toBe(64)
    expect(safeString('a'.repeat(64), undefined)).toBe(true)
    expect(safeString('a'.repeat(65), undefined)).toBe(false)
    expect(safeString(`${'a'.repeat(63)}${PAIR}`, undefined)).toBe(true)
    expect(safeString(`${'a'.repeat(64)}${PAIR}`, undefined)).toBe(false)
    expect(safeString(PAIR.repeat(64), undefined)).toBe(true)
    expect(safeString(PAIR.repeat(65), undefined)).toBe(false)
  })

  it('refuses a string far past the limit without reading it', () => {
    expect(safeString('a1'.repeat(5_000_000), undefined)).toBe(false)
  })

  it.each([
    ['a run of 20 that mixes letters and digits', `${'a'.repeat(19)}1`, false],
    ['a run of 19 that mixes letters and digits', `${'a'.repeat(18)}1`, true],
    [
      'a run of 40 with letters alone',
      'a'.repeat(40),
      true,
    ],
    [
      'a run of 40 with digits alone',
      '1'.repeat(40),
      true,
    ],
    ['two runs of 19 that white space splits', `${'a'.repeat(18)}1 ${'b'.repeat(18)}2`, true],
    ['a run that punctuation joins', `${'a'.repeat(9)}-${'1'.repeat(10)}`, false],
    ['a run that a hidden character joins', `${'a'.repeat(9)}${String.fromCharCode(0x200B)}${'1'.repeat(10)}`, false],
  ])('reads %s: written %s', (_label, text, safe) => {
    expect(OPAQUE_RUN).toBe(20)
    expect(safeString(text, undefined)).toBe(safe)
  })

  it.each([
    ['an address', 'dev@example.org', false],
    ['an address inside a sentence', 'mail dev@example.org now', false],
    ['the shortest address', 'a@b.c', false],
    ['an @ with no dot after it', 'dev@localhost', true],
    ['an @ with nothing before it', '@example.org', true],
    ['an @ that white space cuts from its name', 'dev @example.org', true],
  ])('reads %s: written %s', (_label, text, safe) => {
    expect(safeString(text, undefined)).toBe(safe)
    expect(EMAIL.test(text)).toBe(!safe)
  })

  it('refuses a string that holds the key, in its case, and no empty key refuses anything', () => {
    expect(safeString(`see ${API_KEY}`, API_KEY)).toBe(false)
    expect(safeString(`see ${API_KEY.toUpperCase()}`, API_KEY)).toBe(true)
    expect(safeString('see', '')).toBe(true)
    expect(safeString('see', undefined)).toBe(true)
  })

  it.each(KINDS)('refuses a %s whatever its length', (kind) => {
    expect(safeString(fakeCredential(kind), undefined)).toBe(false)
  })

  it.each(SHORT_CREDENTIALS)('refuses the credential %s, which no opaque run holds', (credential) => {
    expect(credential.length).toBeLessThan(OPAQUE_RUN)
    expect(safeString(credential, undefined)).toBe(false)
    expect(safeString(`see ${credential} now`, undefined)).toBe(false)
  })
})

describe('the rule\'s values', () => {
  it('holds the values the plan states', () => {
    expect([
      REDACTED,
      EXTRA_BODY_STRING,
      OPAQUE_RUN,
      EXTRA_BODY_DEPTH,
      EXTRA_BODY_VALUES,
    ]).toEqual(['[redacted]', 64, 20, 4, 64])
    expect(SECRET_WORDS).toEqual([
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
    expect(SECRET_PARTS).toEqual([
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
  })
})
