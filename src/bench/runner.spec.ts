import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputError, ProviderError } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { EXEC_FINDING, fakeConfig, writeSuite } from '../testing/bench.ts'
import type { FakeModel } from '../testing/bench.ts'
import { parseRecord } from './records.ts'
import type { Denial, ResultRecord } from './records.ts'
import { denialOf, planReviews, runReviews } from './runner.ts'
import type { BenchReview, RunnerEvent, RunReviewsOptions } from './runner.ts'
import { loadSuite } from './suite.ts'
import type { Suite } from './suite.ts'

let root = ''
let suite: Suite
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'quorum-runner-'))
  writeSuite(join(root, 'demo'))
  suite = await loadSuite(join(root, 'demo'), 'demo')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const review = (caseId: string, configuration = 0, trial = 1): BenchReview => ({ trial, caseId, configuration })
const isResearch = (request: CompletionRequest): boolean => request.output.name === 'research_findings'
const FILES: Readonly<Record<string, string>> = { 'a.js': 'exec', 'db.py': 'sql', 'README.md': 'docs' }
/** The case of the fixture suite a request reviews, by the file its diff names. */
const caseOf = (request: CompletionRequest): string => Object.entries(FILES).find(([file]) => request.messages[0].content.includes(`diff --git a/${file}`))?.[1] ?? ''

/** An onCall that counts the research calls a fake receives. */
function researchCounter(): { calls: number, onCall: (request: CompletionRequest) => void } {
  const counter = {
    calls: 0,
    onCall: (request: CompletionRequest): void => {
      if (isResearch(request)) counter.calls += 1
    },
  }
  return counter
}

function deferred() {
  let open = (): void => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** Run the reviews with these fakes, by configuration, and keep the lines and events it gives. */
async function run(fakes: readonly FakeModel[], reviews: readonly BenchReview[], options: Partial<RunReviewsOptions> = {}) {
  const lines: string[] = []
  const events: RunnerEvent[] = []
  const outcome = await runReviews({
    suite,
    configurations: fakes.map((fake, index) => ({
      config: fakeConfig(fake),
      fingerprint: [A, B][index],
    })),
    reviews,
    jobs: 1,
    env: {},
    append: async (line) => {
      lines.push(line)
    },
    events: event => events.push(event),
    ...options,
  })
  return { outcome, lines, events }
}

describe('planReviews', () => {
  it('orders the reviews by trial, then case, then configuration', () => {
    expect(planReviews({
      trials: 2,
      cases: ['exec', 'sql'],
      configurations: 2,
    })).toEqual([
      review('exec', 0, 1),
      review('exec', 1, 1),
      review('sql', 0, 1),
      review('sql', 1, 1),
      review('exec', 0, 2),
      review('exec', 1, 2),
      review('sql', 0, 2),
      review('sql', 1, 2),
    ])
  })
})

describe('denialOf', () => {
  it.each<[string, unknown, Denial | undefined]>([
    [
      'an unusable reply',
      new OutputError('research', 'reply contains no JSON object', 'no'),
      'unusable-reply',
    ],
    [
      'a refusal',
      new ProviderError({ providerId: 'p', kind: 'refusal', message: 'model refused' }),
      'refusal',
    ],
    [
      'a reply cut off',
      new ProviderError({ providerId: 'p', kind: 'truncated', message: 'cut off' }),
      'truncated',
    ],
    [
      'an HTTP error',
      new ProviderError({
        providerId: 'p',
        kind: 'http',
        status: 500,
        message: 'HTTP 500',
      }),
      undefined,
    ],
    [
      'a network error',
      new ProviderError({ providerId: 'p', kind: 'network', message: 'down' }),
      undefined,
    ],
    [
      'a timeout',
      new ProviderError({ providerId: 'p', kind: 'timeout', message: 'slow' }),
      undefined,
    ],
    [
      'a reply the server shaped wrong',
      new ProviderError({ providerId: 'p', kind: 'invalid-response', message: 'no text' }),
      undefined,
    ],
    [
      'any other error',
      new Error('research failed'),
      undefined,
    ],
  ])('classifies %s: %s', (_name, error, denial) => {
    expect(denialOf(error)).toBe(denial)
  })
})

describe('runReviews', () => {
  it('records a review with its calls, its usage, its cost, its latency and its full result', async () => {
    const { outcome, lines, events } = await run([
      {
        findings: [EXEC_FINDING],
      },
    ], [
      review('exec'),
    ])
    expect(outcome).toEqual({ recorded: 1, failed: 0, interrupted: false })
    const record = parseRecord(lines[0].slice(0, -1)) as ResultRecord | undefined
    expect(record).toMatchObject({
      fingerprint: A,
      case: 'exec',
      trial: 1,
      calls: 4,
      failedCalls: 0,
      usage: { inputTokens: 40, outputTokens: 20 },
      costComplete: true,
    })
    expect(record?.usage?.costUsd).toBeCloseTo(0.004, 10)
    expect(Number.isInteger(record?.latencyMs) && (record?.latencyMs ?? -1) >= 0).toBe(true)
    expect(record?.result.kept.map(({ file, line }) => [file, line])).toEqual([
      ['a.js', 2],
    ])
    expect(events).toEqual([
      {
        type: 'recorded',
        review: review('exec'),
        record,
      },
    ])
  })

  it('records that a call reported no cost', async () => {
    const { lines } = await run([
      { cost: false },
    ], [
      review('exec'),
    ])
    expect(parseRecord(lines[0].slice(0, -1))?.costComplete).toBe(false)
  })

  it('does not record a review that rejects, reports its error, and runs the others', async () => {
    const { outcome, lines, events } = await run([
      { failResearch: true },
      {},
    ], [
      review('exec', 0),
      review('exec', 1),
    ])
    expect(outcome).toEqual({ recorded: 1, failed: 1, interrupted: false })
    expect(lines.map(line => parseRecord(line.slice(0, -1))?.fingerprint)).toEqual([B])
    expect(events[0]).toEqual({
      type: 'failed',
      review: review('exec', 0),
      error: expect.objectContaining({ message: 'research failed' }),
    })
  })

  it('records a review whose research reply cannot be used as denied, with its calls and its usage, and runs the others', async () => {
    const { outcome, lines, events } = await run([
      { researchText: 'I cannot help with that.' },
      {},
    ], [
      review('exec', 0),
      review('exec', 1),
    ])
    expect(outcome).toEqual({ recorded: 2, failed: 0, interrupted: false })
    const denied = parseRecord(lines[0].slice(0, -1))
    expect(denied).toMatchObject({
      fingerprint: A,
      case: 'exec',
      denied: 'unusable-reply',
      calls: 1,
      failedCalls: 0,
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    expect(denied).not.toHaveProperty('result')
    expect(lines[0]).not.toContain('help with that')
    expect(events.map(({ type }) => type)).toEqual(['recorded', 'recorded'])
  })

  it('records no denial that an interrupt cut', async () => {
    const controller = new AbortController()
    const { outcome, lines } = await run([
      {
        researchText: 'no JSON here',
        onCall: () => controller.abort(),
      },
    ], [
      review('exec'),
    ], { signal: controller.signal })
    expect(outcome).toEqual({ recorded: 0, failed: 0, interrupted: true })
    expect(lines).toEqual([])
  })

  it('records no denial even when the interrupt\'s own reason is the error of a denial', async () => {
    const controller = new AbortController()
    const { outcome, lines } = await run([
      {
        researchText: 'no JSON here',
        onCall: () => controller.abort(new OutputError('research', 'reply contains no JSON object', 'no')),
      },
    ], [
      review('exec'),
    ], { signal: controller.signal })
    expect(outcome).toEqual({ recorded: 0, failed: 0, interrupted: true })
    expect(lines).toEqual([])
  })

  it('gives each review a quorum of its own, so its record counts only its own calls', async () => {
    const second = {
      ...EXEC_FINDING,
      line: 1,
      category: 'CWE-20',
      quote: 'const cmd = input()',
      summary: 'unchecked input',
    }
    const { lines } = await run([
      {
        findings: [EXEC_FINDING],
      },
      {
        findings: [EXEC_FINDING, second],
      },
    ], [
      review('exec', 0),
      review('exec', 1),
    ], { jobs: 2 })
    const calls = Object.fromEntries(lines.map(line => parseRecord(line.slice(0, -1))).map(entry => [entry?.fingerprint, entry?.calls]))
    expect(calls).toEqual({ [A]: 4, [B]: 7 })
  })

  it('runs at most --jobs reviews at once, starting them in the order given', async () => {
    const gate = deferred()
    const second = deferred()
    let opened = false
    const started: Array<[string, boolean]> = []
    const onCall = (request: CompletionRequest): void => {
      if (!isResearch(request)) return
      started.push([
        caseOf(request),
        opened,
      ])
      if (started.length === 2) second.open()
    }
    const running = run([
      { gate: gate.promise, onCall },
    ], [
      review('exec'),
      review('sql'),
      review('docs'),
    ], { jobs: 2 })
    await second.promise
    expect(started).toEqual([
      ['exec', false],
      ['sql', false],
    ])
    opened = true
    gate.open()
    expect((await running).outcome.recorded).toBe(3)
    expect(started).toEqual([
      ['exec', false],
      ['sql', false],
      ['docs', true],
    ])
  })

  it('starts no review once interrupted, and keeps the records written', async () => {
    const controller = new AbortController()
    const counter = researchCounter()
    const { outcome, lines } = await run([
      { onCall: counter.onCall },
    ], [
      review('exec'),
      review('sql'),
      review('docs'),
    ], {
      signal: controller.signal,
      events: () => controller.abort(),
    })
    expect(outcome).toEqual({ recorded: 1, failed: 0, interrupted: true })
    expect(lines).toHaveLength(1)
    expect(counter.calls).toBe(1)
  })

  it('counts no review an interrupt cut as failed', async () => {
    const controller = new AbortController()
    const gate = deferred()
    const second = deferred()
    let calls = 0
    const onCall = (): void => {
      calls += 1
      if (calls === 2) second.open()
    }
    const running = run([
      { gate: gate.promise, onCall },
    ], [
      review('exec'),
      review('sql'),
    ], { jobs: 2, signal: controller.signal })
    await second.promise
    controller.abort()
    const { outcome, events } = await running
    expect(outcome).toEqual({ recorded: 0, failed: 0, interrupted: true })
    expect(events).toEqual([])
  })

  it('stops the run on a write that fails, and rejects with its error', async () => {
    const counter = researchCounter()
    const append = async (): Promise<void> => {
      throw new Error('results.jsonl: cannot be written (ENOSPC)')
    }
    await expect(run([
      { onCall: counter.onCall },
    ], [
      review('exec'),
      review('sql'),
    ], { append })).rejects.toThrow('results.jsonl: cannot be written (ENOSPC)')
    expect(counter.calls).toBe(1)
  })

  it('appends nothing after a write fails while another review runs, and rejects with its error', async () => {
    const gate = deferred()
    const append = vi.fn(async (): Promise<void> => {
      gate.open()
      throw new Error('results.jsonl: cannot be written (ENOSPC)')
    })
    await expect(run([
      {},
      { gate: gate.promise },
    ], [
      review('exec', 0),
      review('exec', 1),
    ], { jobs: 2, append })).rejects.toThrow('results.jsonl: cannot be written (ENOSPC)')
    expect(append).toHaveBeenCalledTimes(1)
  })

  it('gives each trial of one configuration a quorum of its own when they run at once', async () => {
    const { lines } = await run([
      {
        findings: [EXEC_FINDING],
      },
    ], [
      review('exec', 0, 1),
      review('exec', 0, 2),
    ], { jobs: 2 })
    expect(lines.map(line => parseRecord(line.slice(0, -1))).map(entry => [entry?.trial, entry?.calls]).sort()).toEqual([
      [1, 4],
      [2, 4],
    ])
  })

  it('fails a review whose record is over the line cap, without writing it', async () => {
    const { outcome, lines, events } = await run([{}], [
      review('exec'),
    ], { maxRecordBytes: 100 })
    expect(outcome).toEqual({ recorded: 0, failed: 1, interrupted: false })
    expect(lines).toEqual([])
    expect(events).toEqual([
      {
        type: 'failed',
        review: review('exec'),
        error: expect.objectContaining({ message: 'its record is over the size a line of results.jsonl holds' }),
      },
    ])
  })

  it('counts the cap in bytes before the line break: a record of exactly that size is written, one a byte over fails', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    try {
      const wide = { ...EXEC_FINDING, summary: `injection${String.fromCharCode(0xE9).repeat(50)}` }
      const { lines } = await run([
        {
          findings: [wide],
        },
      ], [
        review('exec'),
      ])
      const size = Buffer.byteLength(lines[0]) - 1
      expect(size).toBeGreaterThan(lines[0].length)
      expect((await run([
        {
          findings: [wide],
        },
      ], [
        review('exec'),
      ], { maxRecordBytes: size })).outcome).toEqual({ recorded: 1, failed: 0, interrupted: false })
      expect((await run([
        {
          findings: [wide],
        },
      ], [
        review('exec'),
      ], { maxRecordBytes: size - 1 })).outcome).toEqual({ recorded: 0, failed: 1, interrupted: false })
    } finally {
      clock.mockRestore()
    }
  })

  it('stops the run on an events callback that throws, and rejects with its error', async () => {
    const counter = researchCounter()
    const events = (): void => {
      throw new Error('the sink failed')
    }
    await expect(run([
      { onCall: counter.onCall },
    ], [
      review('exec'),
      review('sql'),
    ], { events })).rejects.toThrow('the sink failed')
    expect(counter.calls).toBe(1)
  })

  it('fails a review of a case or a configuration the run does not have', async () => {
    const message = 'its case or its configuration is not in the run'
    const { outcome, lines, events } = await run([{}], [
      review('nope'),
      review('exec', 3),
    ])
    expect(outcome).toEqual({ recorded: 0, failed: 2, interrupted: false })
    expect(lines).toEqual([])
    expect(events.map(event => event.type === 'failed' && (event.error as Error).message)).toEqual([message, message])
  })
})
