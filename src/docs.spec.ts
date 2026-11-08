import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

const anchorsOf = (file: string): Set<string> => new Set([...withoutFences(text(file)).matchAll(/^#{1,6} (.+)$/gm)].map(match => slug(match[1])))

/** Every link target in the prose of a file that is not a URL (inline code is code, not a link). */
function links(file: string): string[] {
  const prose = withoutFences(text(file)).replace(/`[^`\n]*`/g, '')
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]).filter(target => !/^[a-z][a-z0-9+.-]*:/i.test(target))
}

/** Bidirectional controls, zero-width and other invisible format characters, variation selectors, and Unicode tags. */
const HIDDEN: ReadonlyArray<readonly [number, number]> = [[0x00AD, 0x00AD], [0x061C, 0x061C], [0x180E, 0x180E], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2064], [0x2066, 0x2069], [0xFE00, 0xFE0F], [0xFEFF, 0xFEFF], [0xE0000, 0xE007F]]
const isHidden = (char: string): boolean => HIDDEN.some(([low, high]) => (char.codePointAt(0) ?? 0) >= low && (char.codePointAt(0) ?? 0) <= high)

describe('the documentation', () => {
  it('resolves every relative link to a file, and every anchor to a heading of that file', () => {
    const broken: string[] = []
    for (const file of files) {
      for (const target of links(file)) {
        const [path, anchor] = target.split('#')
        const resolved = path === '' ? file : relative(ROOT, join(ROOT, dirname(file), path))
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

  it('lists every page in the README table of contents', () => {
    const contents = withoutFences(text('README.md')).split(/^## Documentation$/m)[1]?.split(/^## /m)[0] ?? ''
    const listed = new Set([...contents.replace(/`[^`\n]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1].split('#')[0].replace(/^\.\//, '')))
    expect(pages.filter(page => page !== START && !listed.has(page))).toEqual([])
  })

  it('holds no hidden character in the README or any page', () => {
    const found = files.flatMap(file => text(file).split('\n').flatMap((line, index) => [...line].some(isHidden) ? [`${file}:${index + 1}`] : []))
    expect(found).toEqual([])
  })
})
