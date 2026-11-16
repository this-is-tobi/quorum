import { afterEach, describe, expect, it, vi } from 'vitest'
import { controlProblems, corpusHash } from '../src/testing/github-corpus.ts'
import { CONTEXT, FIXTURE, GITHUB_MARKDOWN, markdownRequest, renderCorpus } from './github-markdown.ts'

const MENTION = '<a class="user-mention notranslate" href="https://github.com/octocat">@octocat</a>'
const ISSUE = '<a class="issue-link js-issue-link" href="https://github.com/this-is-tobi/quorum/issues/1">#1</a>'
const COMMIT = '<a class="commit-link" href="https://github.com/this-is-tobi/quorum/commit/dd2775b">dd2775b</a>'
const EMOJI = '<g-emoji class="g-emoji" alias="smile">x</g-emoji>'
const IMAGE = '<img src="https://e.example/x.png">'
const MATH = '<math-renderer class="js-inline-math">x</math-renderer>'
const CONTROL = `<p>${MENTION} ${ISSUE} ${COMMIT} ${EMOJI} ${IMAGE} ${MATH}</p>`
const CLEAN = '<p><code>text</code></p>'

const DOCUMENTS = [
  { name: 'control', markdown: '@octocat #1' },
  { name: 'summary', markdown: '### quorum review' },
  { name: 'comment-1', markdown: 'one' },
]

/** A fetch that answers each request from the document it posts, by its text. */
function answering(html: (text: string) => string, status = 200): typeof fetch {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    const { text } = JSON.parse(init?.body as string) as { text: string }
    return Promise.resolve(new Response(html(text), { status }))
  }) as unknown as typeof fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('github-markdown', () => {
  it('asks GitHub to render a document in gfm mode in this repository\'s context, with the token only when one is set', () => {
    const bare = markdownRequest('hello', undefined)
    expect(bare.url).toBe(GITHUB_MARKDOWN)
    expect(GITHUB_MARKDOWN).toBe('https://api.github.com/markdown')
    expect(CONTEXT).toBe('this-is-tobi/quorum')
    expect(FIXTURE).toBe('src/testing/fixtures/github-markdown.json')
    expect(bare.init.method).toBe('POST')
    expect(bare.init.headers).toEqual({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'quorum-corpus',
      'content-type': 'application/json',
    })
    expect(JSON.parse(bare.init.body as string)).toEqual({ text: 'hello', mode: 'gfm', context: 'this-is-tobi/quorum' })

    const withToken = markdownRequest('hello', 't0k3n-x')
    const headers = withToken.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer t0k3n-x')
    expect(Object.entries(headers).filter(([, value]) => value.includes('t0k3n-x')).map(([key]) => key)).toEqual(['authorization'])
    expect(withToken.init.body).toBe(bare.init.body)
    expect(withToken.init.body as string).not.toContain('t0k3n-x')
  })

  it('writes the fixture only when every document renders without a problem', async () => {
    const clean = answering(text => text === '@octocat #1'
      ? CONTROL
      : CLEAN)
    const rendered = await renderCorpus(DOCUMENTS, clean, undefined)
    expect(rendered.problems).toEqual([])
    expect(clean).toHaveBeenCalledTimes(3)
    const fixture = JSON.parse(rendered.fixture as string) as { renderer: string, markdownHash: string, documents: Array<{ name: string, html: string }> }
    expect(fixture.markdownHash).toBe(corpusHash(DOCUMENTS))
    expect(fixture.documents).toEqual([
      { name: 'control', html: CONTROL },
      { name: 'summary', html: CLEAN },
      { name: 'comment-1', html: CLEAN },
    ])
    expect(controlProblems(fixture.documents[0].html)).toEqual([])
    expect(rendered.fixture).toBe(`${JSON.stringify(fixture, null, 2)}\n`)

    const linking = await renderCorpus(DOCUMENTS, answering(text => text === '### quorum review'
      ? MENTION
      : text === '@octocat #1'
        ? CONTROL
        : CLEAN), undefined)
    expect(linking.fixture).toBeUndefined()
    expect(linking.problems).toContain('summary: a mention')

    const refused = await renderCorpus(DOCUMENTS, answering(() => 'forbidden', 403), 't0k3n-x')
    expect(refused.fixture).toBeUndefined()
    expect(refused.problems).toContain('summary: GitHub answered 403')
    expect(refused.problems.join('\n')).not.toContain('t0k3n-x')
  })

  it('makes no request when imported', async () => {
    const stub = vi.fn()
    vi.stubGlobal('fetch', stub)
    vi.resetModules()
    await import('./github-markdown.ts')
    expect(stub).not.toHaveBeenCalled()
  })
})
