import { describe, expect, it } from 'vitest'
import { OutputError, ProviderError } from '../errors.ts'
import type { NoAnswer, ProviderErrorKind } from '../errors.ts'
import { badReplyOf } from './resend.ts'
import type { BadReply } from './resend.ts'

function failed(kind: ProviderErrorKind, noAnswer?: NoAnswer, cutAfterMs?: number): { readonly failure: ProviderError } {
  return {
    failure: new ProviderError({
      providerId: 'p',
      kind,
      message: 'failed',
      ...noAnswer === undefined
        ? {}
        : { noAnswer },
      ...cutAfterMs === undefined
        ? {}
        : { cutAfterMs },
    }),
  }
}

const unreadable = {
  unread: new OutputError('research', 'reply contains a JSON object that repeats a key', 'bad'),
}

describe('the replies a call sends once more', () => {
  it.each<[string, 'research' | 'vote', Parameters<typeof badReplyOf>[1], BadReply | undefined]>([
    [
      'a research call\'s reply of only reasoning',
      'research',
      failed('no-answer', 'thinking'),
      'only-reasoning',
    ],
    [
      'a vote\'s reply of only reasoning',
      'vote',
      failed('no-answer', 'thinking'),
      'only-reasoning',
    ],
    [
      'a vote cut off at its reply budget',
      'vote',
      failed('truncated', 'reply'),
      'cut-off',
    ],
    [
      'a vote cut off at the server\'s window',
      'vote',
      failed('truncated', 'window'),
      'cut-off',
    ],
    [
      'a vote cut on the way at a learned length, for which a shorter reply is the fix',
      'vote',
      failed('truncated', 'reply', 600_000),
      undefined,
    ],
    [
      'a vote cut on the way at a learned length while it reasoned',
      'vote',
      failed('truncated', 'thinking', 900_000),
      undefined,
    ],
    [
      'a research reply the stage could not read',
      'research',
      unreadable,
      'unreadable',
    ],
    [
      'a vote the stage could not read',
      'vote',
      unreadable,
      'unreadable',
    ],
    [
      'a research reply cut off, which recovery splits',
      'research',
      failed('truncated', 'reply'),
      undefined,
    ],
    [
      'an empty reply, which the prompt mode answers',
      'vote',
      failed('no-answer', 'empty'),
      undefined,
    ],
    [
      'a network failure, which a retry answers',
      'research',
      failed('network'),
      undefined,
    ],
    [
      'a reply no check read that is no output error: a bug',
      'vote',
      {
        unread: new TypeError('a bug in a check'),
      },
      undefined,
    ],
    [
      'no end',
      'research',
      undefined,
      undefined,
    ],
  ])('reads %s as %s', (_name, role, end, expected) => {
    expect(badReplyOf(role, end)).toBe(expected)
  })
})
