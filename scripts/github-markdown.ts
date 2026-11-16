import { writeFileSync } from 'node:fs'
import { controlProblems, corpusDocuments, corpusHash, renderingProblems } from '../src/testing/github-corpus.ts'

// A check of quorum's Markdown against GitHub's own renderer, run by hand: `bun run live:github-markdown`. No test
// or CI job runs it. It sends the hostile corpus (`src/testing/github-corpus.ts`), which holds no secret, to
// GitHub's public Markdown API, one request per document: the summary and the line comments quorum writes for a
// review of hostile findings, and a control of raw Markdown that GitHub must render, so that a renderer that stopped
// would not pass quorum's documents for nothing. It needs no token: one request per document stays within the 60
// an hour that are allowed without one. A GITHUB_TOKEN raises that limit, and no line prints it.
//
// It checks the HTML GitHub answers with: no image, mention, issue or commit link, emoji, math, alert, footnote, raw
// HTML or link but to a heading of the page in a quorum document, and a mention, an issue link, a commit link, an
// emoji, an image and math in the control. It writes the fixture the suite pins its hash against only when every
// check passes, and exits 1 otherwise.

export const GITHUB_MARKDOWN = 'https://api.github.com/markdown'
export const CONTEXT = 'this-is-tobi/quorum'
export const FIXTURE = 'src/testing/fixtures/github-markdown.json'

const API_VERSION = '2022-11-28'

type Documents = ReadonlyArray<{ readonly name: string, readonly markdown: string }>

/** The request that renders `text` as GitHub-flavored Markdown in this repository's context; the token, when there is one, is the bearer of the call and nowhere else. */
export function markdownRequest(text: string, token: string | undefined): { readonly url: string, readonly init: RequestInit } {
  return {
    url: GITHUB_MARKDOWN,
    init: {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        'user-agent': 'quorum-corpus',
        'content-type': 'application/json',
        ...token === undefined
          ? {}
          : { authorization: `Bearer ${token}` },
      },
      body: JSON.stringify({ text, mode: 'gfm', context: CONTEXT }),
    },
  }
}

/**
 * Renders each document, one request at a time, and checks the HTML: the control must render what `controlProblems`
 * lists, every other document must hold nothing GitHub acts on. A problem is `<name>: <words>`, in fixed words that quote
 * neither the HTML, nor an error, nor the token. The fixture, the JSON text to write, is there only when no problem
 * was found.
 */
export async function renderCorpus(documents: Documents, fetchFn: typeof fetch, token: string | undefined): Promise<{ readonly fixture?: string, readonly problems: readonly string[] }> {
  const problems: string[] = []
  const rendered: Array<{ name: string, html: string }> = []
  for (const { name, markdown } of documents) {
    const { url, init } = markdownRequest(markdown, token)
    let html: string
    try {
      const response = await fetchFn(url, init)
      if (response.status !== 200) {
        problems.push(`${name}: GitHub answered ${response.status}`)
        continue
      }
      html = await response.text()
    } catch {
      problems.push(`${name}: the request failed`)
      continue
    }
    rendered.push({ name, html })
    const found = name === 'control'
      ? controlProblems(html)
      : renderingProblems(html)
    problems.push(...found.map(problem => `${name}: ${problem}`))
  }
  if (problems.length > 0) return { problems }
  const fixture = {
    renderer: `${GITHUB_MARKDOWN}, mode gfm, context ${CONTEXT}, API version ${API_VERSION}`,
    markdownHash: corpusHash(documents),
    documents: rendered,
  }
  return { fixture: `${JSON.stringify(fixture, null, 2)}\n`, problems }
}

async function main(): Promise<void> {
  const documents = corpusDocuments()
  const { fixture, problems } = await renderCorpus(documents, fetch, process.env.GITHUB_TOKEN)
  for (const { name } of documents) {
    const own = problems.filter(problem => problem.startsWith(`${name}: `))
    if (own.length === 0) console.log(`ok ${name}`)
    for (const problem of own) console.log(`FAIL ${problem}`)
  }
  if (fixture === undefined) process.exit(1)
  writeFileSync(new URL(`../${FIXTURE}`, import.meta.url), fixture)
  console.log(`wrote ${FIXTURE}`)
}

if (import.meta.main) await main()
