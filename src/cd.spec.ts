import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// The CD builds and publishes the release: no test runs it, reaches a registry or builds anything. These
// read the workflow as data and pin what the docs promise about a release and what keeps its jobs narrow:
// the permissions each job holds, what runs only when a release is created, and what each `uses:` points at.
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

interface Step {
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

interface Job {
  needs?: string | string[]
  if?: string
  uses?: string
  permissions?: Record<string, string>
  with?: Record<string, unknown>
  secrets?: Record<string, string> | string
  steps?: Step[]
}

interface Workflow {
  on: { push?: { branches?: string[], 'paths-ignore'?: string[] }, workflow_dispatch?: unknown }
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

const workflow = parse(read('.github/workflows/cd.yml')) as Workflow
const jobs = workflow.jobs

function job(name: string): Job {
  const found = jobs[name]
  expect(found, `the job ${name}`).toBeDefined()
  return found
}

/** A GitHub Actions expression, built here because ESLint refuses `${{` in a plain string. */
function expr(body: string): string {
  return `\${{ ${body} }}`
}

const needs = (name: string): string[] => [job(name).needs ?? []].flat()

/** The first step of `name` that runs `uses`, or fails. */
function step(name: string, uses: string): Step {
  const found = job(name).steps?.find(candidate => candidate.uses?.startsWith(`${uses}@`))
  expect(found, `a ${uses} step in ${name}`).toBeDefined()
  return found as Step
}

/** The lines of a `with:` value that lists several: one per line, or separated by commas. */
const list = (value: unknown): string[] => String(value).split(/[\n,]/).map(item => item.trim()).filter(item => item !== '')

const RELEASE_CREATED = expr('needs.release.outputs.release-created == \'true\'')
const ARTIFACT = 'quorum-binaries'
const DIR = 'bin/release'
const BINARIES = ['quorum-linux-x64', 'quorum-linux-arm64', 'quorum-darwin-x64', 'quorum-darwin-arm64']
const CATALOG = 'this-is-tobi/github-workflows/.github/workflows'

describe('the triggers', () => {
  it('runs on every push to main but one that only touches .github, and by hand', () => {
    expect(workflow.on.push?.branches).toEqual(['main'])
    expect(workflow.on.push?.['paths-ignore']).toEqual(['.github/**'])
    expect(workflow.on).toHaveProperty('workflow_dispatch')
  })
})

describe('the permissions', () => {
  it('grants nothing to the workflow itself, so each job holds only what it states', () => {
    expect(workflow.permissions).toEqual({})
  })

  it.each(Object.keys(jobs))('states the permissions of the job %s, a job that calls a reusable workflow included', (name) => {
    expect(job(name).permissions).toBeTypeOf('object')
  })

  it('gives each job the least it uses', () => {
    const granted = Object.fromEntries(Object.entries(jobs).map(([name, { permissions }]) => [name, permissions]))
    expect(granted).toEqual({
      'expose-vars': { contents: 'read' },
      'build-binaries': { contents: 'read' },
      'release-guard': { 'pull-requests': 'read' },
      release: { contents: 'write', issues: 'write', 'pull-requests': 'write' },
      'attest-binaries': { 'id-token': 'write', attestations: 'write' },
      npm: { contents: 'read', 'id-token': 'write' },
      docker: { contents: 'read', packages: 'write' },
      attest: { packages: 'write', 'id-token': 'write', attestations: 'write' },
    })
  })

  it('never interpolates an expression into a script: a value reaches `run:` through `env:`', () => {
    const runs = Object.values(jobs).flatMap(({ steps = [] }) => steps).map(({ run }) => run ?? '')
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs)
      expect(run).not.toContain('${{')
  })

  it('checks out without leaving the job token in .git/config', () => {
    const checkouts = Object.values(jobs).flatMap(({ steps = [] }) => steps).filter(({ uses }) => uses?.startsWith('actions/checkout@'))
    expect(checkouts.length).toBeGreaterThan(0)
    for (const checkout of checkouts)
      expect(checkout.with?.['persist-credentials']).toBe(false)
  })
})

describe('what every uses: points at', () => {
  const uses = Object.values(jobs).flatMap(({ uses: called, steps = [] }) => [called, ...steps.map(({ uses: action }) => action)]).filter((ref): ref is string => ref !== undefined)

  it('finds the calls and the actions of every job', () => {
    expect(uses.length).toBeGreaterThanOrEqual(10)
  })

  it.each(uses)('%s is a catalog workflow at @v0 or an action pinned by commit', (ref) => {
    const catalog = new RegExp(`^${CATALOG}/[a-z-]+\\.yml@v0$`)
    const pinned = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/
    expect(catalog.test(ref) || pinned.test(ref)).toBe(true)
  })

  it('calls the four catalog workflows, each once', () => {
    const called = uses.filter(ref => ref.startsWith(`${CATALOG}/`)).map(ref => ref.slice(CATALOG.length + 1))
    expect(called.toSorted()).toEqual(['attest-docker.yml@v0', 'build-docker.yml@v0', 'release-app.yml@v0', 'release-npm.yml@v0'])
  })
})

describe('the Bun version', () => {
  it('is read from the pin of mise.toml and exposed to the jobs that build and publish', () => {
    expect(job('expose-vars').steps?.some(({ run }) => run?.includes('mise.toml') && run.includes('BUN_VERSION'))).toBe(true)
    expect(job('expose-vars').steps?.some(({ run }) => run?.includes('GITHUB_OUTPUT'))).toBe(true)
  })
})

describe('the binaries', () => {
  const upload = (): Step => step('build-binaries', 'actions/upload-artifact')

  it('are built before the release, on every push, with the Bun that mise.toml pins', () => {
    expect(needs('build-binaries')).toEqual(['expose-vars'])
    expect(job('build-binaries').if).toBeUndefined()
    expect(step('build-binaries', 'oven-sh/setup-bun').with?.['bun-version']).toBe(expr('needs.expose-vars.outputs.BUN_VERSION'))
  })

  it('install the production dependencies from the frozen lockfile, running no lifecycle script, then compile the release', () => {
    const runs = (job('build-binaries').steps ?? []).map(({ run }) => run).filter(run => run !== undefined)
    expect(runs).toEqual(['bun install --frozen-lockfile --production --ignore-scripts', 'bun run compile:release'])
  })

  it('are uploaded flat, as the one artifact the release attaches, which must hold files and expires soon', () => {
    expect(upload().with).toMatchObject({ name: ARTIFACT, path: `${DIR}/`, 'if-no-files-found': 'error' })
    const retention = upload().with?.['retention-days']
    expect(retention).toBeTypeOf('number')
    expect(retention).toBeGreaterThanOrEqual(1)
    expect(retention).toBeLessThanOrEqual(7)
  })

  it('are attached by the release job, which downloads the artifact the build uploads, under its name', () => {
    expect(needs('release')).toContain('build-binaries')
    expect(job('release').with?.RELEASE_ARTIFACT_NAMES).toBe(upload().with?.name)
    expect(job('release').with?.RELEASE_ARTIFACT_NAMES).toBe(ARTIFACT)
  })

  it('get a build provenance attestation each, from the artifact the release attached, and the checksums do not', () => {
    expect(step('attest-binaries', 'actions/download-artifact').with).toMatchObject({ name: ARTIFACT, path: DIR })
    expect(list(step('attest-binaries', 'actions/attest-build-provenance').with?.['subject-path'])).toEqual(BINARIES.map(name => `${DIR}/${name}`))
  })
})

describe('the release', () => {
  it('is release-app, tagging the major and minor versions, as the GitHub App that lets the release pull request run CI', () => {
    expect(job('release').uses).toBe(`${CATALOG}/release-app.yml@v0`)
    expect(job('release').with?.TAG_MAJOR_AND_MINOR).toBe(true)
    expect(job('release').secrets).toEqual({ APP_CLIENT_ID: expr('secrets.APP_CLIENT_ID'), APP_PRIVATE_KEY: expr('secrets.APP_PRIVATE_KEY') })
  })

  it('runs on every push, since whether a push creates a release is what it decides', () => {
    expect(job('release').if).toBeUndefined()
  })
})

describe('the release guard', () => {
  // release-please releases every merged release pull request still labelled `autorelease: pending`, and tags
  // that pull request's merge commit, whatever commit the run is on. The binaries are attached by the release
  // job itself, so only a job that runs before it can keep the artifacts and the tag on one commit.
  const guard = (): Step => {
    const steps = job('release-guard').steps ?? []
    expect(steps).toHaveLength(1)
    return steps[0]
  }

  it('runs before the release, on every push, and the release needs it', () => {
    expect(needs('release-guard')).toEqual([])
    expect(job('release-guard').if).toBeUndefined()
    expect(needs('release').toSorted()).toEqual(['build-binaries', 'release-guard'])
  })

  it('reads pull requests through the API with its own token, with no checkout and nothing else to read', () => {
    expect(job('release-guard').permissions).toEqual({ 'pull-requests': 'read' })
    expect(job('release-guard').steps?.some(({ uses }) => uses?.startsWith('actions/checkout@'))).toBe(false)
    expect(guard().env).toMatchObject({
      GH_TOKEN: expr('github.token'),
      GH_REPO: expr('github.repository'),
      GITHUB_REF_NAME: expr('github.ref_name'),
      GITHUB_SHA: expr('github.sha'),
    })
  })

  it('fails the run on a merged pull request of the branch, still labelled pending, that merged another commit than the run\'s', () => {
    const { run = '' } = guard()
    expect(run).toContain('set -euo pipefail')
    expect(run).toContain('gh pr list --state merged --label "autorelease: pending" --base "$GITHUB_REF_NAME"')
    expect(run).toContain('release-please--branches--$GITHUB_REF_NAME')
    expect(run).toMatch(/\.mergeCommit\.oid != env\.GITHUB_SHA/)
    expect(run).toContain('::error::')
    expect(run).toContain('exit 1')
  })

  it('says how to recover: re-run the release commit\'s own run, which a dispatch does not', () => {
    const { run = '' } = guard()
    expect(run).toContain('Re-run all jobs')
    expect(run).toMatch(/dispatch/i)
  })
})

describe('what runs only when a release is created', () => {
  it.each(['attest-binaries', 'npm', 'docker'])('gates %s on release-created, after the release', (name) => {
    expect(job(name).if).toBe(RELEASE_CREATED)
    expect(needs(name)).toContain('release')
  })

  it('attests the image after it is pushed, and so only when a release was created', () => {
    expect(needs('attest')).toEqual(['docker'])
    expect(job('attest').if).toBeUndefined()
  })

  it('lets nothing run through a skipped job', () => {
    for (const { if: condition } of Object.values(jobs))
      expect(condition ?? '').not.toMatch(/always\(\)|!cancelled\(\)|failure\(\)/)
  })
})

describe('npm', () => {
  it('publishes with the Bun of mise.toml, through trusted publishing and with provenance, so with no token', () => {
    expect(job('npm').uses).toBe(`${CATALOG}/release-npm.yml@v0`)
    expect(needs('npm')).toEqual(['expose-vars', 'release'])
    expect(job('npm').with).toEqual({
      RUNTIME: 'bun',
      RUNTIME_VERSION: expr('needs.expose-vars.outputs.BUN_VERSION'),
      PACKAGE_MANAGER: 'bun',
      BUILD_COMMAND: 'bun run build',
      PROVENANCE: true,
    })
    expect(job('npm').secrets).toBeUndefined()
  })
})

describe('the image', () => {
  it('is built from the Dockerfile at the release commit, named by the release, with its minor, major and latest tags', () => {
    expect(job('docker').uses).toBe(`${CATALOG}/build-docker.yml@v0`)
    expect(job('docker').with).toEqual({
      IMAGE_NAME: `ghcr.io/${expr('github.repository_owner')}/quorum`,
      IMAGE_TAG: expr('needs.release.outputs.version'),
      IMAGE_DOCKERFILE: './Dockerfile',
      IMAGE_CONTEXT: './',
      TAG_MAJOR_AND_MINOR: true,
      LATEST_TAG: true,
    })
    expect(job('docker').secrets).toBeUndefined()
  })

  it('gets its provenance, SBOM and signature, by the digest the build pushed', () => {
    expect(job('attest').uses).toBe(`${CATALOG}/attest-docker.yml@v0`)
    expect(job('attest').with).toEqual({
      IMAGE_NAME: expr('needs.docker.outputs.image'),
      DIGEST: expr('needs.docker.outputs.digest'),
      PROVENANCE: true,
      SBOM: true,
      SIGN: true,
    })
    expect(job('attest').secrets).toBeUndefined()
  })
})
