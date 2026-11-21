import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputError, ProviderDownError, ProviderError } from '../core/errors.ts'
import type { CompletionRequest } from '../core/ports.ts'
import { EXEC_FINDING, fakeConfig, fakeProvider, resolvedConfig, writeSuite } from '../testing/bench.ts'
import type { FakeModel } from '../testing/bench.ts'
import { parseRecord } from './records.ts'
import type { ResultRecord } from './records.ts'
import { planReviews, runReviews } from './runner.ts'
import type { BenchReview, RunnerEvent, RunReviewsOptions, RunReviewsOutcome } from './runner.ts'
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

/** The outcome of a run that records and fails what `fields` say and counts nothing else: nothing unrun, not interrupted, a spend of any size unless `fields` says it. */
function outcomeOf(fields: Partial<Record<keyof RunReviewsOutcome, unknown>>) {
  return {
    recorded: 0,
    failed: 0,
    notRun: 0,
    spent: expect.any(Number),
    interrupted: false,
    ...fields,
  }
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

describe('runReviews', () => {
  it('records a review with its calls, its usage, its cost, its latency and its full result', async () => {
    const { outcome, lines, events } = await run([
      {
        findings: [EXEC_FINDING],
      },
    ], [
      review('exec'),
    ])
    expect(outcome).toEqual(outcomeOf({ recorded: 1, spent: 60 }))
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
    expect(outcome).toEqual(outcomeOf({ recorded: 1, failed: 1 }))
    expect(lines.map(line => parseRecord(line.slice(0, -1))?.fingerprint)).toEqual([B])
    expect(events[0]).toEqual({
      type: 'failed',
      review: review('exec', 0),
      error: expect.objectContaining({ message: 'fake: its one call failed (http 500): lower concurrency or wait' }),
    })
  })

  it('fails a review that rejects with ProviderDownError, records nothing of it, and runs the others', async () => {
    const { outcome, lines, events } = await run([
      { failResearch: true },
      {},
    ], [
      review('exec', 0),
      review('exec', 1),
    ])
    expect(outcome).toEqual(outcomeOf({ recorded: 1, failed: 1 }))
    expect(lines.map(line => parseRecord(line.slice(0, -1))?.fingerprint)).toEqual([B])
    expect(events[0]).toMatchObject({
      type: 'failed',
      review: review('exec', 0),
    })
    expect((events[0] as { error: unknown }).error).toBeInstanceOf(ProviderDownError)
    expect(events.map(({ type }) => type)).toEqual(['failed', 'recorded'])
  })

  it('records a review whose advisory profile\'s research failed with its gap, as no failure', async () => {
    const { outcome, lines } = await run([], [
      review('exec'),
    ], {
      configurations: [
        {
          config: resolvedConfig({
            providers: {
              fake: fakeProvider({
                onCall: (request) => {
                  if (isResearch(request)) throw new Error('research failed')
                },
              }),
            },
            profiles: {
              security: { gating: false },
            },
          }),
          fingerprint: A,
        },
      ],
    })
    expect(outcome).toEqual(outcomeOf({ recorded: 1 }))
    const recorded = parseRecord(lines[0].slice(0, -1))
    expect(recorded).not.toHaveProperty('denied')
    expect(recorded).toMatchObject({
      calls: 1,
      failedCalls: 1,
      result: {
        meta: {
          incomplete: [
            { profile: 'security', reason: 'research-failed', detail: 'the research call failed' },
          ],
        },
      },
    })
  })

  it('reviews each case with its configuration\'s send', async () => {
    const patch = [
      'diff --git a/.env b/.env',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/.env',
      '@@ -0,0 +1 @@',
      '+MODE=production',
      '',
    ].join('\n')
    writeSuite(join(root, 'held'), undefined, { 'docs.patch': patch })
    suite = await loadSuite(join(root, 'held'), 'demo')
    const requests: string[][] = [[], []]
    const providerFor = (index: number) => fakeProvider({
      onCall: (request) => {
        if (isResearch(request)) requests[index].push(request.messages[0].content)
      },
    })
    const { outcome, lines } = await run([], [
      review('docs', 0),
      review('docs', 1),
    ], {
      configurations: [
        {
          config: resolvedConfig({
            providers: {
              fake: providerFor(0),
            },
          }),
          fingerprint: A,
        },
        {
          config: resolvedConfig({
            providers: {
              fake: providerFor(1),
            },
            send: ['.env'],
          }),
          fingerprint: B,
        },
      ],
    })
    expect(outcome).toEqual(outcomeOf({
      recorded: 2,
      spent: expect.any(Number),
    }))
    const [held, sent] = lines.map(line => parseRecord(line.slice(0, -1)) as ResultRecord)
    expect(held.result.meta.leftOut).toEqual([
      { file: '.env', reason: 'secret', rule: 'name' },
    ])
    expect(requests[0]).toEqual([])
    expect(sent.result.meta.leftOut).toEqual([])
    expect(requests[1]).toHaveLength(1)
    expect(requests[1][0]).toContain('+MODE=production')
  })

  it('records a review whose research reply cannot be used as a result with the research-failed gap, with its calls and its usage, and runs the others', async () => {
    const { outcome, lines, events } = await run([
      { researchText: 'I cannot help with that.' },
      {},
    ], [
      review('exec', 0),
      review('exec', 1),
    ])
    expect(outcome).toEqual(outcomeOf({ recorded: 2, spent: 30 }))
    const recorded = parseRecord(lines[0].slice(0, -1))
    expect(recorded).toMatchObject({
      fingerprint: A,
      case: 'exec',
      calls: 1,
      failedCalls: 0,
      usage: { inputTokens: 10, outputTokens: 5 },
      result: {
        meta: {
          incomplete: [
            {
              profile: 'security',
              reason: 'research-failed',
              detail: expect.stringContaining('the research reply could not be read: '),
            },
          ],
        },
      },
    })
    expect(recorded).not.toHaveProperty('denied')
    expect(lines[0]).not.toContain('help with that')
    expect(events.map(({ type }) => type)).toEqual(['recorded', 'recorded'])
  })

  it('records a review whose research reply was cut off as a result with the research-failed gap, with the usage its error carries', async () => {
    const { lines } = await run([
      {
        onCall: (request) => {
          if (!isResearch(request)) return
          throw new ProviderError({
            providerId: 'p',
            kind: 'truncated',
            message: 'reply was cut off by the token limit',
            usage: { inputTokens: 900, outputTokens: 16000, costUsd: 0.02 },
          })
        },
      },
    ], [
      review('exec'),
    ])
    expect(parseRecord(lines[0].slice(0, -1))).toMatchObject({
      calls: 1,
      failedCalls: 1,
      usage: { inputTokens: 900, outputTokens: 16000, costUsd: 0.02 },
      costComplete: true,
      result: {
        meta: {
          incomplete: [
            { profile: 'security', reason: 'research-failed', detail: 'the research call failed (truncated)' },
          ],
        },
      },
    })
  })

  it('records nothing that an interrupt cut', async () => {
    const controller = new AbortController()
    const { outcome, lines } = await run([
      {
        researchText: 'no JSON here',
        onCall: () => controller.abort(),
      },
    ], [
      review('exec'),
    ], { signal: controller.signal })
    expect(outcome).toEqual(outcomeOf({ interrupted: true }))
    expect(lines).toEqual([])
  })

  it('records nothing even when the interrupt\'s own reason is an error that once denied a review', async () => {
    const controller = new AbortController()
    const { outcome, lines } = await run([
      {
        researchText: 'no JSON here',
        onCall: () => controller.abort(new OutputError('research', 'reply contains no JSON object', 'no')),
      },
    ], [
      review('exec'),
    ], { signal: controller.signal })
    expect(outcome).toEqual(outcomeOf({ interrupted: true }))
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

  it('starts no review once the run has spent maxRunTokens, and records the ones it ran', async () => {
    const counter = researchCounter()
    const { outcome, lines } = await run([
      { onCall: counter.onCall },
    ], [
      review('exec'),
      review('sql'),
    ], { maxRunTokens: 15 })
    expect(outcome).toEqual({
      recorded: 1,
      failed: 0,
      notRun: 1,
      spent: 15,
      interrupted: false,
    })
    expect(lines).toHaveLength(1)
    expect(counter.calls).toBe(1)
  })

  it('counts the calls of a review that failed', async () => {
    const counter = researchCounter()
    const { outcome, lines, events } = await run([
      { failResearch: true },
      { onCall: counter.onCall },
    ], [
      review('exec', 0),
      review('exec', 1),
    ], { maxRunTokens: 1 })
    expect(events.map(({ type }) => type)).toEqual(['failed'])
    expect(outcome).toEqual({
      recorded: 0,
      failed: 1,
      notRun: 1,
      spent: expect.any(Number),
      interrupted: false,
    })
    expect(outcome.spent).toBeGreaterThanOrEqual(16_000)
    expect(lines).toEqual([])
    expect(counter.calls).toBe(0)
  })

  it('lets the reviews in flight finish once the count reaches the cap', async () => {
    const gate = deferred()
    const second = deferred()
    const counter = researchCounter()
    const onCall = (request: CompletionRequest): void => {
      counter.onCall(request)
      if (counter.calls === 2) second.open()
    }
    const running = run([
      { gate: gate.promise, onCall },
    ], [
      review('exec'),
      review('sql'),
      review('docs'),
    ], { jobs: 2, maxRunTokens: 15 })
    await second.promise
    gate.open()
    const { outcome, lines } = await running
    expect(outcome).toEqual({
      recorded: 2,
      failed: 0,
      notRun: 1,
      spent: 30,
      interrupted: false,
    })
    expect(lines).toHaveLength(2)
    expect(counter.calls).toBe(2)
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
    expect(outcome).toEqual(outcomeOf({ recorded: 1, spent: 15, interrupted: true }))
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
    expect(outcome).toEqual(outcomeOf({ interrupted: true }))
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
    expect(outcome).toEqual(outcomeOf({ failed: 1, spent: 15 }))
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
      ], { maxRecordBytes: size })).outcome).toEqual(outcomeOf({ recorded: 1, spent: 60 }))
      expect((await run([
        {
          findings: [wide],
        },
      ], [
        review('exec'),
      ], { maxRecordBytes: size - 1 })).outcome).toEqual(outcomeOf({ failed: 1, spent: 60 }))
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
    expect(outcome).toEqual(outcomeOf({ failed: 2, spent: 0 }))
    expect(lines).toEqual([])
    expect(events.map(event => event.type === 'failed' && (event.error as Error).message)).toEqual([message, message])
  })
})
