import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { printConfig } from '../cli/print-config.ts'
import { documentSha256 } from '../core/documents.ts'
import type { Provider } from '../core/ports.ts'
import { EXTRA_BODY_DEPTH, EXTRA_BODY_STRING, EXTRA_BODY_VALUES, REDACTED, settingsSchema } from '../core/result-schema.ts'
import { SECRET_RULES } from '../core/secrets.ts'
import type { CredentialKind, ReviewSettings, RuntimeRecord } from '../core/types.ts'
import { resolvedConfig } from '../testing/bench.ts'
import { fakeCredential } from '../testing/credentials.ts'
import { SETTINGS } from '../testing/report.ts'
import { fromConfig } from './from-config.ts'
import type { ResolvedConfig, ResolvedProvider } from './resolve.ts'
import { EMAIL, extraBodyRecord, keyWords, namesSecret, objectView, OPAQUE_RUN, providerOrigin, providerView, reviewSettings, safeString, SECRET_PARTS, SECRET_WORDS } from './settings.ts'

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
    'local-coder-480b-a35b-instruct',
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
    { 'local-coder-480b-a35b-instruct': 1 },
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
    ['a 30-character model id', 'local-coder-480b-a35b-instruct'],
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
      model: 'local-coder-480b-a35b-instruct',
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

/** A provider defined as data, as a resolved config holds it. */
type Spec = Exclude<ResolvedProvider, Provider>

/** What ran the reviews of these rows. */
const RUNTIME: RuntimeRecord = {
  name: 'node',
  version: '26.12.0',
  platform: 'linux',
  arch: 'x64',
}

/** A spec with a preset, a base URL whose path holds a token, a key, a header, a query and a body that holds a key's name. */
const GATEWAY: Spec = {
  preset: 'mistral',
  baseUrl: 'https://gw.example/token-SECRET/v1',
  apiKey: API_KEY,
  model: 'gpt-5',
  contextTokens: 131_072,
  headers: { 'x-team': 't' },
  query: { v: '1' },
  extraBody: { reasoning_effort: 'low', api_token: 'abc' },
}

describe('providerView', () => {
  it('records a provider as print-config prints it, less its origin, command, args and key, and its extraBody by the rule', () => {
    // What 0.13.0's `specView` gave for the spec, field for field, written out.
    expect(providerView(GATEWAY, 'print-config')).toEqual({
      preset: 'mistral',
      origin: 'https://gw.example',
      model: 'gpt-5',
      contextTokens: 131_072,
      apiKey: '[redacted]',
      headers: { 'x-team': '[redacted]' },
      query: { v: '[redacted]' },
      extraBody: { reasoning_effort: '[redacted]', api_token: '[redacted]' },
    })
    expect(Object.keys(providerView(GATEWAY, 'print-config'))).toEqual([
      'preset',
      'origin',
      'model',
      'contextTokens',
      'apiKey',
      'headers',
      'query',
      'extraBody',
    ])
    const recorded = providerView(GATEWAY, 'result')
    expect(recorded).toEqual({
      preset: 'mistral',
      model: 'gpt-5',
      contextTokens: 131_072,
      headers: { 'x-team': '[redacted]' },
      query: { v: '[redacted]' },
      extraBody: { reasoning_effort: 'low', api_token: '[redacted]' },
    })
    expect(Object.keys(recorded)).toEqual([
      'preset',
      'model',
      'contextTokens',
      'headers',
      'query',
      'extraBody',
    ])
    // Neither holds the base URL's host, nor its path, nor the key.
    for (const view of [
      providerView(GATEWAY, 'print-config'),
      recorded,
    ]) {
      const text = JSON.stringify(view)
      expect(text).not.toContain('gw.example/')
      expect(text).not.toContain('SECRET')
      expect(text).not.toContain(API_KEY)
    }
    expect(JSON.stringify(recorded)).not.toContain('gw.example')
    expect(settingsSchema.safeParse({
      ...SETTINGS,
      providers: { gateway: recorded },
    }).success).toBe(true)
  })

  it('records a claude-code provider with no origin, command, args or key, and the auth it runs with', () => {
    const cli: Spec = {
      protocol: 'claude-code',
      command: '/opt/claude/bin/claude',
      model: 'sonnet',
      contextTokens: 1_000_000,
      apiKey: API_KEY,
      args: ['--effort', 'high'],
    }
    expect(providerView(cli, 'print-config')).toEqual({
      protocol: 'claude-code',
      command: '/opt/claude/bin/claude',
      model: 'sonnet',
      contextTokens: 1_000_000,
      apiKey: '[redacted]',
      auth: 'inherit',
      args: ['--effort', 'high'],
    })
    expect(providerView(cli, 'result')).toEqual({
      protocol: 'claude-code',
      model: 'sonnet',
      contextTokens: 1_000_000,
      auth: 'inherit',
    })
  })

  it('records an auth style, a prompt as its hash and the timeouts the spec sets, which print-config prints too', () => {
    const spec: Spec = {
      protocol: 'openai-compatible',
      baseUrl: 'https://gw.example/v1',
      model: 'm',
      contextTokens: 131_072,
      auth: { header: 'x-gateway-key', prefix: 'Key ' },
      systemPrompt: 'Always answer in French.' as never,
      timeoutMs: 60_000,
      stallTimeoutMs: 120_000,
      retries: 2,
      thinking: 'low',
      temperature: null,
    }
    for (const sink of ['print-config', 'result'] as const) {
      expect(providerView(spec, sink)).toMatchObject({
        auth: { header: 'x-gateway-key', prefix: 'Key ' },
        systemPrompt: `sha256:${documentSha256('Always answer in French.')}`,
        timeoutMs: 60_000,
        stallTimeoutMs: 120_000,
        retries: 2,
        thinking: 'low',
        temperature: null,
      })
    }
    expect(JSON.stringify(providerView(spec, 'result'))).not.toContain('French')
    expect(settingsSchema.safeParse({
      ...SETTINGS,
      providers: {
        p: providerView(spec, 'result'),
      },
    }).success).toBe(true)
    // An auth style with no prefix records none, and no field holds `undefined`, which a copy of the record would keep.
    const bare = providerView({
      ...spec,
      auth: { header: 'x-gateway-key' },
    }, 'result')
    expect(bare.auth).toEqual({ header: 'x-gateway-key' })
    expect(Object.values(bare)).not.toContain(undefined)
    expect(settingsSchema.safeParse({
      ...SETTINGS,
      providers: { p: bare },
    }).success).toBe(true)
  })

  // One refused key in each of the three maps, among safe ones, with a second refused key after it: the maps keep the safe ones in their places and write one [redacted] entry where the first refused one stood.
  it.each([
    [
      'print-config',
      'extraBody',
      { before: '[redacted]', [REDACTED]: REDACTED, after: '[redacted]' },
    ],
    [
      'print-config',
      'query',
      { before: '[redacted]', [REDACTED]: REDACTED, after: '[redacted]' },
    ],
    [
      'print-config',
      'headers',
      { before: '[redacted]', [REDACTED]: REDACTED, after: '[redacted]' },
    ],
    [
      'result',
      'extraBody',
      { before: 'a', [REDACTED]: REDACTED, after: 'c' },
    ],
    [
      'result',
      'query',
      { before: '[redacted]', [REDACTED]: REDACTED, after: '[redacted]' },
    ],
    [
      'result',
      'headers',
      { before: '[redacted]', [REDACTED]: REDACTED, after: '[redacted]' },
    ],
  ] as const)('writes a key that safeString refuses as one [redacted] entry in the %s sink\'s %s', (sink, field, expected) => {
    const spec: Spec = {
      protocol: 'openai-compatible',
      baseUrl: 'https://gw.example/v1',
      model: 'm',
      contextTokens: 131_072,
      apiKey: API_KEY,
      [field]: {
        before: 'a',
        [AWS_KEY]: 'b',
        after: 'c',
        [API_KEY]: 'd',
        'dev@example.org': 'e',
      },
    }
    const map = providerView(spec, sink)[field] as Record<string, unknown>
    expect(map).toEqual(expected)
    expect(Object.keys(map)).toEqual(['before', REDACTED, 'after'])
    expect(JSON.stringify(map)).not.toContain(AWS_KEY)
    expect(JSON.stringify(map)).not.toContain(API_KEY)
    expect(JSON.stringify(map)).not.toContain('dev@example.org')
  })

  it.each(['extraBody', 'query', 'headers'] as const)('writes the redacted word as a key of the %s once, whichever sink writes it', (field) => {
    const spec: Spec = {
      protocol: 'openai-compatible',
      baseUrl: 'https://gw.example/v1',
      model: 'm',
      contextTokens: 131_072,
      [field]: { [REDACTED]: 'x', 'x-team': 'y' },
    }
    for (const sink of ['print-config', 'result'] as const) {
      expect(Object.keys(providerView(spec, sink)[field] as object)).toEqual([REDACTED, 'x-team'])
      expect((providerView(spec, sink)[field] as Record<string, unknown>)[REDACTED]).toBe(REDACTED)
    }
  })

  it('keeps a key that names a secret as a key, in both sinks, since only its value is withheld', () => {
    const spec: Spec = {
      protocol: 'openai-compatible',
      baseUrl: 'https://gw.example/v1',
      model: 'm',
      contextTokens: 131_072,
      headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'abc' },
    }
    for (const sink of ['print-config', 'result'] as const) {
      expect(providerView(spec, sink).headers).toEqual({ Authorization: '[redacted]', 'X-Api-Key': '[redacted]' })
    }
  })

  it('reads own fields only, so a polluted prototype fills none, in both sinks', () => {
    const proto = Object.prototype as Record<string, unknown>
    proto.extraBody = { reasoning_effort: 'low' }
    proto.headers = { 'x-polluted': 'SECRET' }
    proto.apiKey = 'SECRET'
    try {
      const spec: Spec = {
        protocol: 'openai-compatible',
        baseUrl: 'https://gw.example/v1',
        model: 'm',
        contextTokens: 131_072,
      }
      expect(Object.keys(providerView(spec, 'print-config'))).toEqual([
        'protocol',
        'origin',
        'model',
        'contextTokens',
      ])
      expect(Object.keys(providerView(spec, 'result'))).toEqual(['protocol', 'model', 'contextTokens'])
    } finally {
      delete proto.extraBody
      delete proto.headers
      delete proto.apiKey
    }
  })

  // The rule's output, under each row's key, as a record holds it: whatever the rule writes, the schema of a result reads.
  it('records every extraBody row of the rule as the schema of a result reads it, the deepest and the largest it writes included', () => {
    for (const [label, _expected, key, value] of [
      ...SAFE,
      ...REDACTED_ROWS,
    ]) {
      const view = providerView({
        protocol: 'openai-compatible',
        baseUrl: 'https://gw.example/v1',
        model: 'm',
        contextTokens: 131_072,
        apiKey: API_KEY,
        extraBody: { [key]: value },
      }, 'result')
      expect(settingsSchema.safeParse({
        ...SETTINGS,
        providers: { p: view },
      }).success, label).toBe(true)
    }
  })

  it('records an extraBody whose refused keys collapse into one entry as the schema of a result reads it', () => {
    const view = providerView({
      ...GATEWAY,
      extraBody: {
        before: 1,
        [AWS_KEY]: 'x',
        [API_KEY]: 2,
        after: 3,
      },
    }, 'result')
    expect(view.extraBody).toEqual({ before: 1, [REDACTED]: REDACTED, after: 3 })
    expect(settingsSchema.safeParse({
      ...SETTINGS,
      providers: { p: view },
    }).success).toBe(true)
  })
})

describe('providerOrigin', () => {
  it('names the origin of a provider\'s own base URL, else of its preset\'s, never a path or a query', () => {
    expect(providerOrigin({ preset: 'mistral', model: 'm', contextTokens: 131_072 })).toBe('https://api.mistral.ai')
    expect(providerOrigin(GATEWAY)).toBe('https://gw.example')
    expect(providerOrigin({ ...GATEWAY, baseUrl: 'http://localhost:11434/v1?key=SECRET' })).toBe('http://localhost:11434')
  })

  it('reads a base URL as an own field, never the one a polluted prototype holds', () => {
    const proto = Object.prototype as Record<string, unknown>
    proto.baseUrl = 'https://attacker.example/v1'
    try {
      expect(providerOrigin({ preset: 'mistral', model: 'mistral-small-latest', contextTokens: 131_072 })).toBe('https://api.mistral.ai')
    } finally {
      delete proto.baseUrl
    }
  })
})

describe('objectView', () => {
  it('records a provider object as print-config prints one', () => {
    const complete: Provider['complete'] = async () => ({ text: '', model: 'm' })
    const stated = {
      id: 'mine',
      model: 'm',
      complete,
      timeoutMs: 60_000,
      stallTimeoutMs: 120_000,
      retries: 2,
    }
    expect(objectView(stated)).toEqual({
      implements: 'Provider',
      model: 'm',
      timeoutMs: 60_000,
      stallTimeoutMs: 120_000,
      retries: 2,
    })
    expect(Object.keys(objectView(stated))).toEqual([
      'implements',
      'model',
      'timeoutMs',
      'stallTimeoutMs',
      'retries',
    ])
    // A model that is no string, and the timeouts it states not, leave their fields out, and the function is never written.
    expect(objectView({ id: 'mine', model: 7 as never, complete })).toEqual({ implements: 'Provider' })
    expect(JSON.stringify(objectView(stated))).not.toContain('complete')
  })
})

describe('reviewSettings', () => {
  const provider = {
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen',
    contextTokens: 131_072,
    headers: { 'x-team': 't' },
    extraBody: { reasoning_effort: 'low', api_token: 'abc' },
  } as const

  /** The config of these rows: one provider on the loopback, the security profile, and the profile `naming` beside it with its own prompts and one lens. */
  function configOf(more: Record<string, unknown> = {}): ResolvedConfig {
    return resolvedConfig({
      providers: { local: provider },
      profiles: {
        security: {},
        naming: {
          prompts: { research: 'Review this diff for names that mislead.', vote: 'Judge {{lens.id}}: {{lens.question}}' },
          lenses: [
            { id: 'clarity', question: 'Does the name mislead?' },
          ],
        },
      },
      ...more,
    })
  }

  /** The record a review of `config` is given when nothing is derived: the quorum's budgets are the config's own. */
  async function recorded(config: ResolvedConfig, bounds?: Parameters<typeof reviewSettings>[1]['bounds']): Promise<ReviewSettings> {
    const quorum = await fromConfig(config, { env: {} })
    return reviewSettings(config, {
      budgets: quorum.budgets,
      runtime: RUNTIME,
      ...bounds === undefined
        ? {}
        : { bounds },
    })
  }

  it('records every profile of the config, security and naming alike, each provider as the result sink writes it, and the runtime', async () => {
    const config = configOf()
    const settings = await recorded(config)
    expect(Object.keys(settings)).toEqual([
      'runtime',
      'strict',
      'concurrency',
      'exclude',
      'partTokens',
      'maxFindings',
      'findingsCap',
      'maxReviewTokens',
      'reviewTimeoutMs',
      'providers',
      'profiles',
    ])
    expect(settings.runtime).toEqual(RUNTIME)
    expect(Object.keys(settings.profiles)).toEqual(['security', 'naming'])
    expect(settings.providers).toEqual({
      local: {
        protocol: 'openai-compatible',
        model: 'qwen',
        contextTokens: 131_072,
        headers: { 'x-team': '[redacted]' },
        extraBody: { reasoning_effort: 'low', api_token: '[redacted]' },
      },
    })
    expect(settingsSchema.safeParse(settings).success).toBe(true)
    expect(JSON.parse(JSON.stringify(settings))).toEqual(settings)
    // No origin, no base URL, no key, whatever the config holds.
    expect(JSON.stringify(settings)).not.toMatch(/127\.0\.0\.1|11434|http/)
  })

  it('records each profile\'s prompts and lens questions by the hashes print-config prints, and its budgets', async () => {
    const config = configOf()
    const quorum = await fromConfig(config, { env: {} })
    const settings = reviewSettings(config, { budgets: quorum.budgets, runtime: RUNTIME })
    const printed = parse(printConfig(config, undefined)) as { profiles: Record<string, { prompts: { research: string, vote: string } }> }
    for (const id of ['security', 'naming']) expect(settings.profiles[id].prompts).toEqual(printed.profiles[id].prompts)
    expect(settings.profiles.naming.prompts.research).toBe(`sha256:${documentSha256('Review this diff for names that mislead.')}`)
    expect(settings.profiles.naming).toEqual({
      research: 'local',
      lenses: {
        clarity: { provider: 'local', question: `sha256:${documentSha256('Does the name mislead?')}` },
      },
      prompts: printed.profiles.naming.prompts,
      findings: quorum.budgets.naming.research.findings,
      replyTokens: {
        research: quorum.budgets.naming.research.replyTokens,
        votes: { clarity: quorum.budgets.naming.lenses.clarity.replyTokens },
      },
    })
    expect(Object.keys(settings.profiles.security.lenses)).toEqual(['reachability', 'impact', 'defenses'])
    expect(settings.profiles.security.findings).toBe(quorum.budgets.security.research.findings)
    expect(Object.keys(settings.profiles.security.replyTokens.votes)).toEqual(['reachability', 'impact', 'defenses'])
    // A prompt's text and a lens's question never reach the record.
    expect(JSON.stringify(settings)).not.toContain('names that mislead')
    expect(JSON.stringify(settings)).not.toContain('Does the name')
  })

  it('records a reply budget as null where nothing is stated to size it by, and a research one as absent', async () => {
    // A provider object states no window and no reply limit, so nothing sizes a reply by.
    const complete: Provider['complete'] = async () => ({ text: '{"findings":[]}', model: 'm' })
    const config = resolvedConfig({
      providers: {
        mine: { model: 'm', complete },
      },
    })
    const quorum = await fromConfig(config, { env: {} })
    const settings = reviewSettings(config, { budgets: quorum.budgets, runtime: RUNTIME })
    expect(settings.profiles.security.replyTokens).toEqual({
      votes: { reachability: null, impact: null, defenses: null },
    })
    expect(settingsSchema.safeParse(settings).success).toBe(true)
  })

  // The rows are [what, config, setting, expected]: the origin says where the value came from.
  it.each([
    [
      'maxReviewTokens set by the config',
      { maxReviewTokens: 500_000 },
      'maxReviewTokens',
      { value: 500_000, origin: 'config' },
    ],
    [
      'maxReviewTokens unset',
      {},
      'maxReviewTokens',
      { value: 2_000_000, origin: 'default' },
    ],
    [
      'reviewTimeoutMs set by the config',
      { reviewTimeoutMs: 60_000 },
      'reviewTimeoutMs',
      { value: 60_000, origin: 'config' },
    ],
    [
      'reviewTimeoutMs unset',
      {},
      'reviewTimeoutMs',
      { value: 1_800_000, origin: 'default' },
    ],
    [
      'partTokens set by the config',
      { partTokens: 4096 },
      'partTokens',
      { value: 4096, origin: 'config' },
    ],
    [
      'partTokens unset',
      {},
      'partTokens',
      { value: 32_768, origin: 'default' },
    ],
    [
      'maxFindings set by the config',
      { maxFindings: 30 },
      'maxFindings',
      { value: 30, origin: 'config' },
    ],
    [
      'maxFindings unset',
      {},
      'maxFindings',
      { value: 50, origin: 'default' },
    ],
    [
      'findingsCap set by the config',
      { findingsCap: 7 },
      'findingsCap',
      { value: 7, origin: 'config' },
    ],
    [
      'findingsCap from the config\'s findingsCap over its maxFindings',
      { findingsCap: 7, maxFindings: 30 },
      'findingsCap',
      { value: 7, origin: 'config' },
    ],
    [
      'findingsCap from the config\'s maxFindings',
      { maxFindings: 30 },
      'findingsCap',
      { value: 30, origin: 'config' },
    ],
    [
      'findingsCap with neither set',
      {},
      'findingsCap',
      { value: 50, origin: 'default' },
    ],
  ] as const)('records %s as %j with its origin', async (_what, more, setting, expected) => {
    const settings = await recorded(configOf(more))
    expect(settings[setting]).toEqual(expected)
  })

  it('records the bounds a path review derived, with their origins, over the config\'s and the defaults', async () => {
    const bounds = {
      maxReviewTokens: { value: 6_500_000, origin: 'derived' },
      reviewTimeoutMs: { value: 86_400_000, origin: 'default' },
      findingsCap: { value: 436, origin: 'derived' },
    } as const
    const settings = await recorded(configOf({ partTokens: 4096, maxFindings: 30 }), bounds)
    expect(settings.maxReviewTokens).toEqual({ value: 6_500_000, origin: 'derived' })
    expect(settings.reviewTimeoutMs).toEqual({ value: 86_400_000, origin: 'default' })
    expect(settings.findingsCap).toEqual({ value: 436, origin: 'derived' })
    // What a path review does not derive stays the config's.
    expect(settings.partTokens).toEqual({ value: 4096, origin: 'config' })
    expect(settings.maxFindings).toEqual({ value: 30, origin: 'config' })
    expect(settingsSchema.safeParse(settings).success).toBe(true)
  })

  it('records the config\'s strict, concurrency and exclude, and their defaults when it sets none', async () => {
    const set = await recorded(configOf({
      strict: true,
      concurrency: 2,
      exclude: ['dist/**', '*.min.js'],
    }))
    expect(set).toMatchObject({
      strict: true,
      concurrency: 2,
      exclude: ['dist/**', '*.min.js'],
    })
    const unset = await recorded(configOf())
    expect(unset).toMatchObject({ strict: false, concurrency: 'auto', exclude: [] })
  })

  it('records a copy: the record shares no list with the config', async () => {
    const config = configOf({
      exclude: ['dist/**'],
    })
    const settings = await recorded(config)
    settings.exclude.push('src/**')
    expect(config.exclude).toEqual(['dist/**'])
  })

  it('records a provider object as print-config prints one, beside a provider defined as data', async () => {
    const complete: Provider['complete'] = async () => ({ text: '{"findings":[]}', model: 'm' })
    const config = resolvedConfig({
      providers: {
        local: provider,
        mine: { model: 'm', complete, timeoutMs: 60_000 },
      },
      roles: { research: 'local', voter: 'mine' },
    })
    const settings = await recorded(config)
    expect(settings.providers.mine).toEqual({ implements: 'Provider', model: 'm', timeoutMs: 60_000 })
    expect(Object.keys(settings.providers)).toEqual(['local', 'mine'])
    expect(settings.profiles.security.lenses.impact.provider).toBe('mine')
    expect(settingsSchema.safeParse(settings).success).toBe(true)
  })
})
