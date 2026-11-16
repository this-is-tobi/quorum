import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { credentialPlaceholder, fakeCredential, privateKeyBody, privateKeyLine } from '../testing/credentials.ts'
import { diffSections } from './diff.ts'
import type { DiffSection } from './diff.ts'
import { CREDENTIAL_RULES, credentialIn, isSecretName, isWholeDeletion, SECRET_RULES, secretRuleOf } from './secrets.ts'
import type { CredentialKind } from './types.ts'

const HELD_BY_NAME = [
  '.env',
  'apps/web/.env',
  '.ENV',
  '.env.local',
  '.env.production',
  '.env.example.local',
  '.env.defaults',
  'credentials',
  '.aws/credentials',
  'CREDENTIALS.JSON',
  'secrets.json',
  'secrets.toml',
  'deploy/secrets.yaml',
  'config/secrets.yml',
  'templates/x/secrets.yaml',
  'deploy/key.PEM',
  'id_ed25519',
  'prod.tfstate.backup',
  '_netrc',
]

const SENT_BY_NAME = [
  '.env.example',
  '.env.local.example',
  '.env.sample',
  '.env.TEMPLATE',
  '.env.dist',
  'charts/x/templates/secrets.yaml',
  'templates/secrets.yml',
  'src/core/secrets.ts',
  'pkg/secrets.go',
  'docs/secrets.md',
  'secrets.env.example',
  'id_rsa.pub',
  'my.env',
  '.envrc',
  'src/environment.ts',
  'src/testing/credentials.ts',
]

const KINDS = SECRET_RULES.filter((rule): rule is CredentialKind => rule !== 'name')
const PLACEHOLDER_KINDS = KINDS.filter((kind): kind is Exclude<CredentialKind, 'private-key'> => kind !== 'private-key')

/** `value` with `marker` in front of each of its lines, as a diff row carries it. */
function withRow(value: string, marker: string): string {
  return value.split('\n').map(line => `${marker}${line}`).join('\n')
}

/** The only section of `text`, read as the diff does. */
function onlySection(text: string): DiffSection {
  const sections = diffSections(text)
  expect(sections).toHaveLength(1)
  return sections[0] as DiffSection
}

describe('isSecretName', () => {
  it.each(HELD_BY_NAME)('holds %j by its name', (path) => {
    expect(isSecretName(path)).toBe(true)
  })

  it.each(SENT_BY_NAME)('sends %j by its name', (path) => {
    expect(isSecretName(path)).toBe(false)
  })
})

describe('credentialIn', () => {
  it.each(KINDS)('finds %s on an added, a removed and a context row, and on a line with no row marker', (kind) => {
    const value = fakeCredential(kind)
    for (const marker of ['+', '-', ' ', '']) {
      expect(credentialIn(withRow(value, marker))).toBe(kind)
    }
  })

  it('reads every match of a line, so a placeholder before a real key does not hide it', () => {
    expect(credentialIn(`+${credentialPlaceholder('github-token')} ${fakeCredential('github-token')}`)).toBe('github-token')
  })

  it('runs the rules on a line that holds a keyword in any case, and takes the dot of a keyword literally', () => {
    const app = [
      'xapp-1-',
      'A1B2C3D4E5-',
      '1234567890-',
      'a1b2c3d4e5f6',
    ].join('')
    const hook = (host: string): string => `https://${host}/services/${privateKeyBody().slice(0, 43)}`
    expect(credentialIn(app)).toBe('slack-token')
    expect(credentialIn(app.toUpperCase())).toBe('slack-token')
    expect(credentialIn(hook(['hooks', 'slack.com'].join('.')))).toBe('slack-token')
    expect(credentialIn(hook(['hooks', 'slack.com'].join('x')))).toBeUndefined()
  })

  it.each([
    ...PLACEHOLDER_KINDS.map((kind): [string, string] => [
      `the placeholder of ${kind}`,
      credentialPlaceholder(kind),
    ]),
    [
      'AWS\'s documented example key',
      ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join(''),
    ],
    ['sk-live-SECRET', 'sk-live-SECRET'],
    ['sk-openai-SECRET', 'sk-openai-SECRET'],
    ['QUORUM_RESEARCH_API_KEY=sk-example', 'QUORUM_RESEARCH_API_KEY=sk-example'],
    ['the source of the first pattern of the table', CREDENTIAL_RULES[0]?.pattern.source ?? ''],
    ['the source of github-pat\'s pattern', CREDENTIAL_RULES.find(rule => rule.id === 'github-pat')?.pattern.source ?? ''],
    ['a line naming the prefixes alone', 'ghp_ gho_ xoxb- AIza sk_live_ sk-ant-api03- T3BlbkFJ ABSK'],
  ])('reads no credential in %s', (_name, text) => {
    expect(text).not.toBe('')
    expect(credentialIn(text)).toBeUndefined()
    expect(credentialIn(`+${text}`)).toBeUndefined()
  })

  it('reads each of the ten markers as a private key when a body line follows, in its exact case only', () => {
    const lines = Array.from({ length: 10 }, (_, index) => privateKeyLine(index))
    expect(new Set(lines).size).toBe(10)
    for (const line of lines) {
      expect(credentialIn(`${line}\n${privateKeyBody()}`)).toBe('private-key')
      expect(credentialIn(`${line.toLowerCase()}\n${privateKeyBody()}`)).toBeUndefined()
    }
  })

  it('reads a marker with no body within six lines as no credential, as code that parses keys spells one', () => {
    const marker = privateKeyLine(0)
    const code = ['const parsed = parse(input)', 'if (!parsed) throw new Error(\'no key\')', 'return parsed']
    const others = Array.from({ length: 6 }, (_, index) => `line ${index}`)
    expect(credentialIn(marker)).toBeUndefined()
    expect(credentialIn([marker, ...code].join('\n'))).toBeUndefined()
    expect(credentialIn([
      marker,
      privateKeyBody().slice(0, 31),
    ].join('\n'))).toBeUndefined()
    expect(credentialIn([
      marker,
      privateKeyBody().slice(0, 32),
    ].join('\n'))).toBe('private-key')
    expect(credentialIn([
      marker,
      ...others,
      privateKeyBody(),
    ].join('\n'))).toBeUndefined()
    expect(credentialIn([
      marker,
      ...others.slice(0, 5),
      privateKeyBody(),
    ].join('\n'))).toBe('private-key')
  })

  describe('a body run', () => {
    const marker = privateKeyLine(4)
    const body = privateKeyBody()
    const end = ['-----END ', 'PRIVATE KEY-----'].join('')
    const value = `${marker}\n${body}\n${end}\n`

    it.each([
      [
        'indented two spaces, as in a YAML block scalar',
        [
          `key: |`,
          `  ${marker}`,
          `  ${body}`,
          `  ${end}`,
        ].join('\n'),
      ],
      [
        'indented with tabs',
        [`\t${marker}`, `\t${body}`, `\t${end}`].join('\n'),
      ],
      [
        'in a one-line JSON string with its line feeds escaped',
        JSON.stringify({ private_key: value }),
      ],
      [
        'in a pretty-printed JSON string',
        JSON.stringify({ private_key: value }, undefined, 2),
      ],
      [
        'quoted on lines of their own',
        [`  "${marker}",`, `  "${body}",`].join('\n'),
      ],
      ['on the marker\'s own line', `${marker}${body}`],
    ])('reads a key %s as a private key', (_name, text) => {
      expect(credentialIn(text)).toBe('private-key')
    })

    it.each([
      [
        'a marker, then an identifier of forty letters',
        [marker, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'].join('\n'),
      ],
      ['a marker in code, then an identifier of a method', `if (pem.startsWith('${marker}')) return parsePrivateKeyFromPemFormattedString(pem)`],
      ['a marker, then a run of 31 characters on its own line', `${marker}${body.slice(0, 31)}`],
      ['a run before the marker on its own line', `${body} ${marker}`],
      [
        'a marker, then a run of forty digits',
        [
          marker,
          '1234567890'.repeat(4),
        ].join('\n'),
      ],
      [
        'a marker, then a digit, a space and forty letters',
        [marker, `7 ${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN'}`].join('\n'),
      ],
      [
        'a marker, then a letter, a space and forty digits',
        [marker, `a ${'1234567890'.repeat(4)}`].join('\n'),
      ],
    ])('reads %s as no credential', (_name, text) => {
      expect(credentialIn(text)).toBeUndefined()
    })

    it('ends a run at a space, a tab, a quote, a backslash or a comma, and reads one across a +, a / or an =', () => {
      const half = body.slice(0, 16)
      for (const separator of [' ', '\t', '"', '\\', ',']) {
        expect(credentialIn([marker, `${half}${separator}${half}`].join('\n'))).toBeUndefined()
      }
      for (const character of ['+', '/', '=']) {
        expect(credentialIn([marker, `${half}${character}${half}`].join('\n'))).toBe('private-key')
      }
    })
  })

  it('reads a line of any length and with a CRLF end', () => {
    for (const kind of KINDS.filter(candidate => candidate !== 'private-key')) {
      const value = fakeCredential(kind)
      expect(credentialIn(`${'x'.repeat(100_000)} ${value}`)).toBe(kind)
      expect(credentialIn(`+${value}\r`)).toBe(kind)
    }
    const marker = privateKeyLine(0)
    expect(credentialIn(`${marker}\n${privateKeyBody().repeat(1_600)}`)).toBe('private-key')
    expect(credentialIn(`+${marker}\r\n+${privateKeyBody()}\r`)).toBe('private-key')
  })
})

describe('secretRuleOf', () => {
  const envLines = [
    'diff --git a/.env b/.env',
    '--- a/.env',
    '+++ b/.env',
    'rename from .env',
    'rename to .env',
    'copy from .env',
    'copy to .env',
  ]
  const otherLines = envLines.map(line => line.replaceAll('.env', 'x.txt'))

  it.each(envLines.map((line, at): [string, number] => [line, at]))('holds a section named .env on its %s line only', (line, at) => {
    const lines = otherLines.map((other, index) => index === at
      ? line
      : other)
    expect(secretRuleOf(onlySection(lines.join('\n')))).toBe('name')
  })

  it('decodes a quoted path, and reads a --- or +++ path up to its tab', () => {
    const lines = [
      '--- "a/caf\\303\\251/.env"',
      '+++ b/my dir/.env\t',
      '--- .env\t2026-01-01 00:00:00.000000000 +0000',
    ]
    for (const line of lines) {
      expect(secretRuleOf(onlySection(`diff --git a/x.txt b/x.txt\n${line}`))).toBe('name')
    }
  })

  it.each([
    ['a header of one name and no --- or +++ line', 'diff --git a/.env\n@@ -0,0 +1 @@\n+A=1'],
    ['a header of a pair of names and a third', 'diff --git a/.env b/.env c\n@@ -0,0 +1 @@\n+A=1'],
    ['a header whose second name is quoted and decoded', 'diff --git a/x.txt "b/caf\\303\\251/.env" y\n@@ -0,0 +1 @@\n+A=1'],
    ['a header that ends with a carriage return', 'diff --git a/.env\r\n@@ -0,0 +1 @@\n+A=1'],
  ])('holds a forged header by the secret name it spells: %s', (_name, text) => {
    expect(secretRuleOf(onlySection(text))).toBe('name')
  })

  it('holds nothing in a header whose names are all ordinary or templates', () => {
    const rows = '@@ -0,0 +1 @@\n+A=1'
    const headers = [
      'diff --git a/x.txt b/x.txt y',
      'diff --git a/src/x.ts',
      'diff --git a/.env.example b/.env.example',
      'diff --git  a/x.txt   b/x.txt',
    ]
    for (const header of headers) {
      expect(secretRuleOf(onlySection(`${header}\n${rows}`))).toBeUndefined()
    }
  })

  it('takes the name before the content', () => {
    const section = onlySection(`diff --git a/.env b/.env\n+${fakeCredential('aws-key')}`)
    expect(section.path).toBe('.env')
    expect(secretRuleOf(section)).toBe('name')
  })

  it('holds a section by a credential on its header, a row or a line outside the hunks', () => {
    const value = fakeCredential('github-token')
    const body = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old'
    expect(secretRuleOf(onlySection(`diff --git a/${value}.txt b/${value}.txt`))).toBe('github-token')
    expect(secretRuleOf(onlySection(`${body}\n+${value}`))).toBe('github-token')
    expect(secretRuleOf(onlySection(`${body}\n+new\n${value}`))).toBe('github-token')
  })

  it('holds nothing in a section that names no secret and holds no credential', () => {
    const text = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new'
    expect(secretRuleOf(onlySection(text))).toBeUndefined()
  })

  it('reads the text before the first header as a section of the empty name', () => {
    const text = [
      'From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001',
      'From: A Dev <dev@example.com>',
      'Subject: [PATCH] x',
      '',
      fakeCredential('stripe-key'),
    ].join('\n')
    expect(secretRuleOf({ path: '', text })).toBe('stripe-key')
  })
})

describe('isWholeDeletion', () => {
  const deletion = [
    'diff --git a/.env b/.env',
    'deleted file mode 100644',
    'index c241285f543067afc58b3606ffda618b9bb4e52d..0000000000000000000000000000000000000000',
    '--- a/.env',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-A=1',
    '-B=2',
    '-C=3',
  ]

  it.each([
    [
      'the deletion of a .env',
      deletion.join('\n'),
    ],
    ['the same with CRLF ends and a final line feed', `${deletion.join('\r\n')}\r\n`],
    ['the deletion of an empty file', 'diff --git a/e b/e\ndeleted file mode 100644\nindex e69de29..0000000'],
    ['the deletion of a binary file', 'diff --git a/k.jks b/k.jks\ndeleted file mode 100644\nindex 1a2b3c4..0000000\nBinary files a/k.jks and /dev/null differ'],
    [
      'a deletion that ends with a no-newline marker',
      [...deletion, '\\ No newline at end of file'].join('\n'),
    ],
    [
      'a deletion whose names are quoted',
      deletion.map(line => line.replaceAll('a/.env', '"a/caf\\303\\251/.env"').replaceAll('b/.env', '"b/caf\\303\\251/.env"')).join('\n'),
    ],
    [
      'a deletion whose name holds a space, its --- line ended with a tab',
      deletion.map(line => line.replaceAll('.env', 'my dir/.env')).join('\n').replace('--- a/my dir/.env', '--- a/my dir/.env\t'),
    ],
    [
      'a deletion with a removed row that reads like a --- line of another name',
      [...deletion, '--- a/src/auth.ts'].join('\n'),
    ],
  ])('reads %s as a whole deletion', (_name, text) => {
    expect(isWholeDeletion(text)).toBe(true)
  })

  it.each([
    ['a truncation to empty', 'diff --git a/x b/x\nindex 1a2b3c4..5d6e7f8 100644\n--- a/x\n+++ b/x\n@@ -1,2 +0,0 @@\n-a\n-b'],
    ['a mode change', 'diff --git a/x b/x\nold mode 100644\nnew mode 100755'],
    ['a deletion with a + row after its hunk', `${deletion.join('\n')}\n+D=4`],
    ['a deletion with a context row', `${deletion.join('\n')}\n D=4`],
    [
      'a deletion whose hunk keeps lines',
      deletion.map(line => line.replace('+0,0', '+1,3')).join('\n'),
    ],
    ['a deletion followed by a format-patch mail', `${deletion.join('\n')}\nFrom 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001\nSubject: [PATCH 2/2] x`],
    ['a deletion of a GIT binary patch', 'diff --git a/k.jks b/k.jks\ndeleted file mode 100644\nindex 1a2b3c4..0000000\nGIT binary patch\nliteral 0\nHcmV?d00001\n\nliteral 12\nTcmZQzU|?VZVE_OC\n'],
    ['a section with +++ /dev/null and no deleted file mode', 'diff --git a/x b/x\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-a'],
    [
      'a deletion that starts with another line than its header',
      [
        'From x',
        ...deletion.slice(1),
      ].join('\n'),
    ],
    [
      'a deletion with a blank line in the middle',
      [
        ...deletion.slice(0, 6),
        '',
        ...deletion.slice(6),
      ].join('\n'),
    ],
    [
      'a forged .env deletion whose --- line names another file',
      deletion.map(line => line.replace('--- a/.env', '--- a/src/auth.ts')).join('\n'),
    ],
    [
      'a forged deletion whose --- line has no name',
      deletion.map(line => line.replace('--- a/.env', '--- ')).join('\n'),
    ],
    [
      'a forged deletion whose --- line names the header\'s new side',
      deletion.map(line => line.replace('--- a/.env', '--- b/.env')).join('\n'),
    ],
    [
      'a deletion whose header names two different paths, its --- line one of them',
      deletion.map(line => line.replace('diff --git a/.env b/.env', 'diff --git a/.env b/src/auth.ts')).join('\n'),
    ],
    [
      'a deletion whose header holds a third name',
      deletion.map(line => line.replace('diff --git a/.env b/.env', 'diff --git a/.env b/.env c')).join('\n'),
    ],
  ])('reads %s as no whole deletion', (_name, text) => {
    expect(isWholeDeletion(text)).toBe(false)
  })
})

describe('quorum\'s own tree', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const directories = [
    'src',
    'scripts',
    'schema',
    'docs',
    'bench',
    '.github',
  ]

  it('finds no credential and no secret name in quorum\'s own sources, specs, scripts, schema, docs and bench, so a review of its own changes holds nothing', () => {
    const files = [
      ...directories.flatMap(directory => readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(root, join(entry.parentPath, entry.name)))),
      'README.md',
      'CHANGELOG.md',
    ]
    expect(files).toContain('src/core/secrets.ts')
    expect(files).toContain('src/core/secrets.spec.ts')
    const held = files.filter(file => isSecretName(file) || credentialIn(readFileSync(join(root, file), 'utf8')) !== undefined)
    expect(held).toEqual([])
  })

  it('carries both MIT notices in a legal comment', () => {
    const source = readFileSync(new URL('./secrets.ts', import.meta.url), 'utf8')
    expect(source.startsWith('/*!')).toBe(true)
    expect(source).toContain('Copyright (c) 2019 Zachary Rice')
    expect(source).toContain('Copyright (c) 2014 pre-commit dev team: Anthony Sottile, Ken Struys')
  })
})
