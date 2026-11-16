import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import packageJson from '../../package.json' with { type: 'json' }
import { MCP_SDK_NAME, MCP_SDK_VERSION, SDK_ABSENT, SDK_OTHER, sdkProblem } from './sdk.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A fake install: the entry's URL, and a `package.json` beside `dist/` holding `manifest` when it is given. */
function fakeInstall(manifest: string | undefined): (specifier: string) => string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quorum-sdk-')))
  roots.push(root)
  const directory = join(root, 'node_modules', '@modelcontextprotocol', 'server')
  mkdirSync(join(directory, 'dist'), { recursive: true })
  writeFileSync(join(directory, 'dist', 'index.mjs'), 'export {}\n')
  if (manifest !== undefined) writeFileSync(join(directory, 'package.json'), manifest)
  const entry = pathToFileURL(join(directory, 'dist', 'index.mjs')).href
  return specifier => specifier === MCP_SDK_NAME
    ? entry
    : ''
}

const manifestOf = (name: string, version: string): string => JSON.stringify({ name, version })

describe('the MCP SDK', () => {
  it('reads the pin from package.json\'s peer dependency', () => {
    expect(MCP_SDK_VERSION).toBe(packageJson.peerDependencies[MCP_SDK_NAME])
    expect(MCP_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('accepts the installed SDK at the pin, found above the file the resolution names', async () => {
    expect(await sdkProblem(fakeInstall(manifestOf(MCP_SDK_NAME, MCP_SDK_VERSION)))).toBeUndefined()
  })

  it.each([
    [
      'of another version',
      manifestOf(MCP_SDK_NAME, '2.3.1'),
    ],
    ['whose package.json is not JSON', '{ not json'],
    [
      'whose package.json names another package',
      manifestOf('@example/other', MCP_SDK_VERSION),
    ],
    ['with no package.json above its entry', undefined],
  ])('refuses an installed SDK %s, naming the command that installs the pin', async (_name, manifest) => {
    const problem = await sdkProblem(fakeInstall(manifest))
    expect(problem).toBe(SDK_OTHER)
    expect(problem).toContain(`npm install -g ${MCP_SDK_NAME}@${MCP_SDK_VERSION}`)
    expect(problem).not.toBe(SDK_ABSENT)
  })

  it('leaves to the import an SDK that nothing on disk resolves: a binary\'s bundled copy, or none', async () => {
    expect(await sdkProblem(() => {
      throw new Error('Cannot find package')
    })).toBeUndefined()
  })

  it('finds the development dependency at the pin with the default resolver', async () => {
    expect(await sdkProblem()).toBeUndefined()
  })
})
