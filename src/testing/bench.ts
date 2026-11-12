/** Test helpers for the bench: a small suite and the writer that puts it on disk. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'

/** Three patches: exec adds an exec(cmd) call at new line 2 of a.js, sql builds SQL text at new lines 2 and 3 of db.py, docs renames the README's title. */
export const PATCHES = {
  exec: [
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1,2 +1,3 @@',
    ' const cmd = input()',
    '+exec(cmd)',
    ' done()',
    '',
  ].join('\n'),
  sql: [
    'diff --git a/db.py b/db.py',
    '--- a/db.py',
    '+++ b/db.py',
    '@@ -1,2 +1,3 @@',
    ' def find(db, name):',
    '-    return db.execute("SELECT * FROM users WHERE name = ?", [name])',
    '+    sql = "SELECT * FROM users WHERE name = \'" + name + "\'"',
    '+    return db.execute(sql)',
    '',
  ].join('\n'),
  docs: [
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1 +1 @@',
    '-# Demo',
    '+# Demo app',
    '',
  ].join('\n'),
}

/** The suite the bench specs start from: two bugs, on exec and sql, and a control, on docs. */
export const SUITE = {
  name: 'demo',
  cases: [
    {
      id: 'exec',
      kind: 'bug',
      patch: 'exec.patch',
      locations: [
        { file: 'a.js', start: 2, end: 2 },
      ],
    },
    {
      id: 'sql',
      kind: 'bug',
      patch: 'sql.patch',
      locations: [
        { file: 'db.py', start: 2, end: 3 },
      ],
    },
    { id: 'docs', kind: 'control', patch: 'docs.patch' },
  ],
}

/**
 * Write a suite into `directory`, which it makes with its `cases/`: `suite.yaml` from `suite`, then the
 * three patches of `PATCHES` as `exec.patch`, `sql.patch` and `docs.patch`, then each of `patches` over
 * them by name, as given, so a spec can replace a patch or add one.
 */
export function writeSuite(directory: string, suite: object = SUITE, patches: Readonly<Record<string, string | Uint8Array>> = {}): void {
  mkdirSync(join(directory, 'cases'), { recursive: true })
  writeFileSync(join(directory, 'suite.yaml'), stringify(suite))
  const files: Readonly<Record<string, string | Uint8Array>> = {
    'exec.patch': PATCHES.exec,
    'sql.patch': PATCHES.sql,
    'docs.patch': PATCHES.docs,
    ...patches,
  }
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, 'cases', name), content)
}
