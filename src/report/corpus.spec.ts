import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { inertLine, showHidden } from '../core/sanitize.ts'
import { controlProblems, corpusDocuments, corpusHash, HOSTILE, renderingProblems } from '../testing/github-corpus.ts'
import { codeFree, expectCodeWritten } from '../testing/markdown.ts'

describe('corpus', () => {
  it('writes every hostile text only inside code spans and fenced blocks of quorum\'s documents', () => {
    const documents = corpusDocuments()
    expect(documents.map(({ name }) => name)).toEqual([
      'control',
      'summary',
      ...HOSTILE.map((_, index) => `comment-${index + 1}`),
    ])
    for (const { name, markdown } of documents.slice(1)) {
      const [first] = markdown.split('\n')
      expect(first, name).toMatch(name === 'summary'
        ? /^<!-- quorum:summary:v1 -->$/
        : /^<!-- quorum:finding:v1 [0-9a-f]{16}:[1-9]\d* -->$/)
      expectCodeWritten(markdown, first)
      const outside = codeFree(markdown)
        .flatMap((line, index) => line.includes('<!--')
          ? [index]
          : [])
      expect(outside, name).toEqual([0])
    }
  })

  it('carries every hostile text into the summary, hidden characters as labels', () => {
    const summary = corpusDocuments()[1].markdown
    for (const text of HOSTILE) expect(summary, JSON.stringify(text)).toContain(inertLine(showHidden(text)))
  })

  it.each([
    [
      ['an image'],
      '<img src="x">',
    ],
    [
      ['a mention', 'a link'],
      '<a class="user-mention notranslate" href="https://github.com/octocat">@octocat</a>',
    ],
    [
      ['an issue or pull request link', 'a link'],
      '<a class="issue-link js-issue-link" href="https://github.com/this-is-tobi/quorum/issues/1">#1</a>',
    ],
    [
      ['a commit link', 'a link'],
      '<a class="commit-link" href="https://github.com/this-is-tobi/quorum/commit/dd2775b">dd2775b</a>',
    ],
    [
      ['an emoji'],
      '<g-emoji>x</g-emoji>',
    ],
    [
      ['math'],
      '<math-renderer>x</math-renderer>',
    ],
    [
      ['raw HTML'],
      '<details><summary>x</summary></details>',
    ],
    [
      ['a link'],
      '<a href="https://e.example">x</a>',
    ],
    [
      ['an alert'],
      '<div class="markdown-alert markdown-alert-warning" dir="auto"><p>x</p></div>',
    ],
    [
      ['a footnote'],
      '<section data-footnotes class="footnotes"><ol></ol></section>',
    ],
  ])('names %s in the HTML %j', (problems, html) => {
    for (const problem of problems) expect(renderingProblems(html)).toContain(problem)
  })

  it('finds nothing in HTML that shows the text as code, and allows a link to a heading of the page', () => {
    expect(renderingProblems('<p><code>@octocat #1</code></p><a href="#quorum-review">')).toEqual([])
  })

  it('finds nothing in a code span that holds a tag or an attribute as text, whose quotes GitHub leaves unescaped', () => {
    expect(renderingProblems('<code>&lt;a href="https://e.example"&gt;x&lt;/a&gt;</code>')).toEqual([])
    expect(renderingProblems('<code>class="issue-link js-issue-link"</code>')).toEqual([])
    expect(renderingProblems('<code>&lt;a class="user-mention commit-link js-inline-math"&gt;</code>')).toEqual([])
    expect(renderingProblems('<code>class="markdown-alert markdown-alert-warning"</code>')).toEqual([])
    expect(renderingProblems('<code>&lt;section data-footnotes&gt;</code>')).toEqual([])
  })

  it('requires a mention, an issue link, a commit link, an emoji, an image and math in the control\'s HTML', () => {
    const rendered = {
      mention: '<a class="user-mention notranslate" href="https://github.com/octocat">@octocat</a>',
      issue: '<a class="issue-link js-issue-link" href="https://github.com/this-is-tobi/quorum/issues/1">#1</a>',
      commit: '<a class="commit-link" href="https://github.com/this-is-tobi/quorum/commit/dd2775b">dd2775b</a>',
      emoji: '<g-emoji class="g-emoji" alias="smile">x</g-emoji>',
      image: '<img src="https://e.example/x.png">',
      math: '<math-renderer class="js-inline-math">x</math-renderer>',
    }
    const words = {
      mention: 'no mention',
      issue: 'no issue link',
      commit: 'no commit link',
      emoji: 'no emoji',
      image: 'no image',
      math: 'no math',
    }
    expect(controlProblems('<p>@octocat #1</p>')).toEqual(Object.values(words))
    expect(controlProblems(Object.values(rendered).join(' '))).toEqual([])
    for (const [name, word] of Object.entries(words)) {
      const without = Object.entries(rendered).filter(([key]) => key !== name).map(([, html]) => html)
      expect(controlProblems(without.join(' '))).toEqual([word])
    }
  })

  it('holds a commit link, an emoji, an image and math in the control\'s Markdown', () => {
    const [{ markdown }] = corpusDocuments()
    expect(markdown).toContain('$x^2$')
    expect(markdown).toContain(':smile:')
    expect(markdown).toContain('<img src=')
    expect(markdown).toMatch(/\b[0-9a-f]{40}\b/)
  })

  it('hashes the documents in order, so a change to any of them changes the hash', () => {
    const documents = [
      { name: 'a', markdown: 'x' },
      { name: 'b', markdown: 'y' },
    ]
    const expected = createHash('sha256').update(JSON.stringify([
      ['a', 'x'],
      ['b', 'y'],
    ])).digest('hex')
    expect(corpusHash(documents)).toBe(`sha256:${expected}`)
    expect(corpusHash([...documents].reverse())).not.toBe(corpusHash(documents))
    expect(corpusHash([
      documents[0],
      { name: 'b', markdown: 'z' },
    ])).not.toBe(corpusHash(documents))
    expect(corpusHash([
      documents[0],
      { name: 'c', markdown: 'y' },
    ])).not.toBe(corpusHash(documents))
    expect(corpusHash(corpusDocuments())).toBe(corpusHash(corpusDocuments()))
  })
})
