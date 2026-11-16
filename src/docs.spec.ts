import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { hiddenLabels } from './core/sanitize.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Every page under docs/, as a path from the repository root, in sorted order. */
const pages: string[] = (readdirSync(join(ROOT, 'docs'), { recursive: true }) as string[])
  .filter(name => name.endsWith('.md'))
  .map(name => join('docs', name))
  .sort()
const START = join('docs', '01-readme.md')
const files = ['README.md', ...pages]
const text = (file: string): string => readFileSync(join(ROOT, file), 'utf8')

/** The text without fenced code blocks, where a heading or a bracket is code. */
const withoutFences = (markdown: string): string => markdown.replace(/^```[\s\S]+?^```/gm, '')

/** A heading's anchor, the way GitHub and docpress make it: lower case, punctuation dropped, spaces to dashes. */
const slug = (heading: string): string => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')

function anchorsOf(file: string): Set<string> {
  return new Set([
    ...withoutFences(text(file)).matchAll(/^#{1,6} (.+)$/gm),
  ].map(match => slug(match[1])))
}

/** Every link target in the prose of a file that is not a URL (inline code is code, not a link). */
function links(file: string): string[] {
  const prose = withoutFences(text(file)).replace(/`[^`\n]*`/g, '')
  return [
    ...prose.matchAll(/\]\(([^)\s]+)\)/g),
  ].map(match => match[1]).filter(target => !/^[a-z][a-z0-9+.-]*:/i.test(target))
}

/** The code points of the sanitizer's hidden class that a line holds, the tab aside, as `U+XXXX` labels. */
const hiddenIn = (line: string): string[] => hiddenLabels(line.replaceAll('\t', ''))

describe('the documentation', () => {
  it('resolves every relative link to a file, and every anchor to a heading of that file', () => {
    const broken: string[] = []
    for (const file of files) {
      for (const target of links(file)) {
        const [path, anchor] = target.split('#')
        const resolved = path === ''
          ? file
          : relative(ROOT, join(ROOT, dirname(file), path))
        if (!existsSync(join(ROOT, resolved))) broken.push(`${file}: ${target}`)
        else if (anchor !== undefined && resolved.endsWith('.md') && !anchorsOf(resolved).has(anchor)) broken.push(`${file}: ${target}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('ends every page outside the start page and the reference section with a Next section naming one page', () => {
    const next = /\n## Next\n\n\[[^\]]+\]\([^)\s]+\.md(?:#[^)\s]*)?\) — .+\n$/
    expect(pages.filter(page => page !== START && !page.startsWith(join('docs', '95-reference')) && !next.test(text(page)))).toEqual([])
  })

  it('opens the start page with the README\'s title, as the website\'s introduction page of every repository does', () => {
    const title = (file: string): string | undefined => /^# (.+)$/m.exec(withoutFences(text(file)))?.[1]
    expect(title(START)).toBe(title('README.md'))
  })

  it('lists every page in the README table of contents', () => {
    const contents = withoutFences(text('README.md')).split(/^## Documentation$/m)[1]?.split(/^## /m)[0] ?? ''
    const listed = new Set([
      ...contents.replace(/`[^`\n]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g),
    ].map(match => match[1].split('#')[0].replace(/^\.\//, '')))
    expect(pages.filter(page => page !== START && !listed.has(page))).toEqual([])
  })

  it('holds no hidden character in the README or any page, but line feeds and tabs', () => {
    const found = files.flatMap(file => text(file).split('\n').flatMap((line, index) => {
      const labels = hiddenIn(line)
      return labels.length > 0
        ? [`${file}:${index + 1} holds ${labels.join(', ')}`]
        : []
    }))
    expect(found).toEqual([])
  })

  it('holds a reference workflow that keeps the model key, the write token and the pull request\'s code apart', () => {
    interface Step { uses?: string, with?: Record<string, unknown>, run?: string }
    interface Job { if?: string, needs?: string, permissions: Record<string, string>, steps: Step[] }
    const reports = text(join('docs', '20-using', '80-reports.md'))
    const section = reports.split(/^## A GitHub workflow$/m)[1]?.split(/^## /m)[0] ?? ''
    const blocks = [
      ...section.matchAll(/^```yaml\n([\s\S]*?)^```/gm),
    ]
    expect(blocks).toHaveLength(1)
    const workflow = parse(blocks[0][1]) as { on: Record<string, unknown>, permissions: unknown, jobs: Record<string, Job> }
    const { review, post } = workflow.jobs
    const runs = (job: Job): string[] => job.steps.flatMap(step => step.run === undefined
      ? []
      : [step.run])
    const mentions = (job: Job, word: string): boolean => JSON.stringify(job).includes(word)

    expect(Object.keys(workflow.on)).toEqual(['pull_request'])
    expect(workflow.permissions).toEqual({})

    expect(review.if).toContain('github.event.pull_request.head.repo.full_name')
    expect(review.if).toContain('github.repository')
    expect(review.permissions).toEqual({ contents: 'read' })
    const checkout = review.steps.find(step => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with).toEqual({
      ref: '$' + '{{ github.event.pull_request.base.sha }}',
      'fetch-depth': 0,
      'persist-credentials': false,
    })
    const reviewRun = runs(review).find(run => run.includes('quorum --range')) ?? ''
    expect(reviewRun).toContain('--view public')
    expect(reviewRun).toMatch(/--output json="\$RUNNER_TEMP\//)

    expect(post.needs).toBe('review')
    expect(post.permissions['security-events']).toBe('write')
    const writes = Object.entries(post.permissions).filter(([, value]) => value === 'write')
    expect(writes.map(([name]) => name)).toEqual(['security-events'])
    expect(runs(post).some(run => run.includes('quorum report'))).toBe(true)
    const upload = post.steps.find(step => step.uses?.startsWith('github/codeql-action/upload-sarif@'))
    expect(upload?.with?.sha).toBe('$' + '{{ github.event.pull_request.head.sha }}')
    expect(upload?.with?.ref).toBe('refs/pull/$' + '{{ github.event.pull_request.number }}/head')
    expect(post.permissions).toMatchObject({ actions: 'read', contents: 'read' })

    expect(mentions(review, 'secrets.')).toBe(true)
    expect(mentions(post, 'secrets.')).toBe(false)
    expect([
      ...runs(review),
      ...runs(post),
    ].filter(run => run.includes('${{'))).toEqual([])
  })
})
