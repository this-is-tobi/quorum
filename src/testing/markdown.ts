/** What the specs of the Markdown reporters read a document through: the text a reporter wrote itself, with the text a model or a diff wrote taken out. */

import { expect } from 'vitest'
import type { Verdict } from '../core/types.ts'
import { SQL } from './report.ts'

/** A right-to-left override, built from its code point so no file holds it raw. */
export const RLO = String.fromCharCode(0x202E)

/** A kept finding whose every text holds what a viewer would act on: a mention, a reference, an emoji, math, an image, a workflow command, a marker, a fence and a `|`. */
export const HOSTILE: Verdict = {
  ...SQL,
  file: 'src/`x`|y.js',
  category: '@octocat #1 :smile: `',
  summary: `<!-- quorum:summary:v1 --> ![x](https://e.example/x.png) $x$\n${RLO} ##[add-mask]e`,
  evidence: ' a()\n+::error::x ~~~ ``` \n b()',
  evidenceRow: 1,
}

/** The run of backticks that starts at `from`: its length. */
function runLength(line: string, from: number): number {
  let end = from
  while (line[end] === '`') end += 1
  return end - from
}

/**
 * The line with its code spans removed, as CommonMark matches them: a run of backticks closes at the next run of
 * exactly its length, and a run with no match stays in the text.
 */
function withoutSpans(line: string): string {
  let kept = ''
  let index = 0
  while (index < line.length) {
    if (line[index] !== '`') {
      kept += line[index]
      index += 1
      continue
    }
    const length = runLength(line, index)
    let close = index + length
    let closed = -1
    while (close < line.length) {
      if (line[close] !== '`') {
        close += 1
        continue
      }
      const next = runLength(line, close)
      if (next === length) {
        closed = close + next
        break
      }
      close += next
    }
    if (closed === -1) {
      kept += line.slice(index, index + length)
      index += length
    } else {
      index = closed
    }
  }
  return kept
}

/** The length of the fence a line opens, 0 when it opens none: a run of three backticks or more after white space, then an info string holding none. */
function fenceOf(line: string): number {
  const trimmed = line.trimStart()
  const length = runLength(trimmed, 0)
  return length >= 3 && !trimmed.slice(length).includes('`')
    ? length
    : 0
}

/** Whether a line closes a block fenced by `length` backticks: a run of that length or more, and nothing else. */
function closesFence(line: string, length: number): boolean {
  const trimmed = line.trim()
  return trimmed.length >= length && /^`+$/.test(trimmed)
}

/**
 * The lines of a Markdown text that quorum's code wrote: each line with its code spans removed, and the lines of
 * each fenced block, its fences included, dropped. What is left is words, numbers and the Markdown quorum
 * writes, so a spec checks that no text of a model or a diff is left outside a span or a block. A block that
 * is never closed runs to the end, as CommonMark has it.
 */
export function codeFree(markdown: string): string[] {
  const lines: string[] = []
  let fence = 0
  for (const line of markdown.split('\n')) {
    if (fence > 0) {
      if (closesFence(line, fence)) fence = 0
      continue
    }
    fence = fenceOf(line)
    if (fence === 0) lines.push(withoutSpans(line))
  }
  return lines
}

/** The check of a document no text of a model or a diff is in outside a span or a block: `marker` first, then only the words, numbers and Markdown quorum writes. */
export function expectCodeWritten(document: string, marker: string): void {
  expect(document.split('\n')[0]).toBe(marker)
  const written = codeFree(document).slice(1)
  expect(written.filter(line => !/^(?:#{3,4} )?[\w .,:;()'·*|-]*$/u.test(line) || /:[\w+-]+:/.test(line))).toEqual([])
}
