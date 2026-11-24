import { describe, expect, it } from 'vitest'
import { securityProfile } from '../profiles/security.ts'
import { profileBudgets, replyBudget, roomIssues } from './budgets.ts'
import type { BudgetSettings, ReplyFacts } from './budgets.ts'
import type { CompletionRequest, Provider } from './ports.ts'
import { thresholdsFor } from './profile.ts'
import { doNotReportInstructions, renderTemplate, researchRequest } from './prompts.ts'
import { targetOf } from './stages/context.ts'
import type { ProfileRun } from './stages/context.ts'
import { rulesBlock } from './rules.ts'
import { replyLimit, requestTokens, utf8Length } from './tokens.ts'
import type { Profile, ReviewRule } from './types.ts'

const UNSET: ReplyFacts = { thinking: 'default' }

describe('replyBudget', () => {
  it.each([
    [8192, 2048, 3, 7, 2048],
    [16_384, 4096, 7, 15, 4096],
    [32_768, 8192, 15, 31, 8192],
    [65_536, 16_384, 31, 50, 9216],
    [200_000, 21_024, 50, 50, 9216],
  ])('sizes a research reply and its findings at a window of %i', (window, research, findings, withoutThinking, vote) => {
    expect(replyBudget(UNSET, window, 50)).toEqual({
      research,
      vote,
      findings,
      findingsWithoutThinking: withoutThinking,
    })
  })

  it('takes maxTokens as the research budget and as a vote\'s ceiling', () => {
    expect(replyBudget({ ...UNSET, maxTokens: 100_000 }, 240_000, 50)).toMatchObject({ research: 100_000, vote: 9216, findings: 50 })
    expect(replyBudget({ ...UNSET, maxTokens: 1000 }, 32_768, 50)).toMatchObject({ research: 1000, vote: 1000 })
    expect(replyBudget({ ...UNSET, maxTokens: 4000 }, undefined, 50)).toEqual({
      research: 4000,
      vote: 4000,
      findings: 7,
      findingsWithoutThinking: 15,
    })
  })

  it('lowers the allowance with thinking low or off', () => {
    expect(replyBudget({ thinking: 'low' }, 200_000, 50)).toMatchObject({ research: 16_928, findings: 50 })
    expect(replyBudget({ thinking: 'off' }, 200_000, 50)).toMatchObject({ research: 12_832, findings: 50 })
  })

  it('asks for maxFindings, and sizes nothing, for a provider that states no window and no maxTokens', () => {
    expect(replyBudget(UNSET, undefined, 50)).toEqual({
      research: undefined,
      vote: undefined,
      findings: 50,
      findingsWithoutThinking: 50,
    })
    expect(replyBudget(UNSET, undefined, 12)).toMatchObject({ findings: 12 })
  })

  it('asks for at least one finding when the budget holds none', () => {
    expect(replyBudget({ ...UNSET, maxTokens: 600 }, undefined, 50)).toMatchObject({ research: 600, findings: 1 })
    expect(replyBudget({ ...UNSET, maxTokens: 10 }, undefined, 50)).toMatchObject({ findings: 1, findingsWithoutThinking: 1 })
  })
})

describe('a ceiling on a reply budget', () => {
  it('lowers a derived research and vote budget to a ceiling, and asks fewer findings, never a set maxTokens', () => {
    // At a window of 200000 the budgets are 21024 and 9216: a ceiling of 6000 holds both, and the thinking keeps half of it at most.
    expect(replyBudget({ ...UNSET, ceiling: 6000 }, 200_000, 50)).toEqual({
      research: 6000,
      vote: 6000,
      findings: 11,
      findingsWithoutThinking: 23,
    })
    // A ceiling is the least a verdict may hold at the floor, and it lowers nothing it is above.
    expect(replyBudget({ ...UNSET, ceiling: 1024 }, 200_000, 50)).toMatchObject({ research: 1024, vote: 1024, findings: 1 })
    expect(replyBudget({ ...UNSET, ceiling: 50_000 }, 200_000, 50)).toEqual(replyBudget(UNSET, 200_000, 50))
    // A provider that states no window has no derived budget: the ceiling is its budget.
    expect(replyBudget({ ...UNSET, ceiling: 6000 }, undefined, 50)).toMatchObject({ research: 6000, vote: 6000, findings: 11 })
    // A maxTokens the provider sets is the owner's decision, and the ceiling leaves it as it is.
    const set = { ...UNSET, maxTokens: 100_000 }
    expect(replyBudget({ ...set, ceiling: 6000 }, 240_000, 50)).toEqual(replyBudget(set, 240_000, 50))
  })
})

describe('profileBudgets', () => {
  const settings: BudgetSettings = { maxFindings: 50, partTokens: 32_768, maxReviewTokens: 2_000_000 }

  function provider(id: string, facts: Partial<Pick<Provider, 'window' | 'maxTokens' | 'thinking'>> = {}): Provider {
    return {
      id,
      model: `${id}-model`,
      ...facts,
      complete: () => Promise.reject(new Error('never called')),
    }
  }

  function runOf(research: Provider, voters: Record<string, Provider>): ProfileRun {
    return {
      id: securityProfile.id,
      research: {
        instructions: 'R',
        ...targetOf(research),
      },
      lenses: securityProfile.lenses.map(lens => ({
        id: lens.id,
        instructions: 'V',
        ...targetOf(voters[lens.id]),
      })),
      thresholds: thresholdsFor(securityProfile),
      failOn: 'high',
      gating: true,
      texts: {
        prompt: 'R',
        guidelines: [],
        doNotReport: [],
        rules: [],
        records: [],
      },
      rules: [],
    }
  }

  it('sizes each profile\'s research and lenses from their own providers\' facts and windows', () => {
    const [first, second, third] = securityProfile.lenses.map(lens => lens.id)
    const run = runOf(provider('big', { window: 200_000 }), {
      [first]: provider('big', { window: 200_000 }),
      [second]: provider('small', { window: 8192, thinking: 'off' }),
      [third]: provider('plain'),
    })
    const budgets = profileBudgets(run, target => target.window, settings)
    expect(budgets.research).toEqual({
      provider: 'big',
      window: 200_000,
      replyTokens: 21_024,
      findings: 50,
      findingsWithoutThinking: 50,
    })
    expect(budgets.lenses[first]).toEqual({ provider: 'big', window: 200_000, replyTokens: 9216 })
    expect(budgets.lenses[second]).toEqual({ provider: 'small', window: 8192, replyTokens: 1024 })
    expect(budgets.lenses[third]).toEqual({ provider: 'plain' })
    // The window comes from `windowOf`, not from the stated one: a smaller one for a lens sizes its vote smaller.
    const narrowed = profileBudgets(run, target => target === run.lenses[0]
      ? 4096
      : target.window, settings)
    expect(narrowed.lenses[first]).toEqual({ provider: 'big', window: 4096, replyTokens: 1024 })
    expect(narrowed.research.replyTokens).toBe(21_024)
    // maxTokens and thinking are read as the provider stated them.
    const stated = Object.fromEntries(securityProfile.lenses.map(lens => [
      lens.id,
      provider('voter', { maxTokens: 500 }),
    ]))
    const capped = profileBudgets(runOf(provider('api', { window: 240_000, maxTokens: 100_000, thinking: 'low' }), stated), target => target.window, settings)
    expect(capped.research).toMatchObject({ window: 240_000, replyTokens: 100_000, findings: 50 })
    expect(capped.lenses[first]).toEqual({ provider: 'voter', replyTokens: 500 })
  })

  /** A provider that states its window, and a room and a worst case as a size guard counts them with `template` tokens kept for the chat template. */
  function guarded(id: string, window: number, template = 512): Provider {
    const reply = (request: CompletionRequest): number => replyLimit(request, undefined) ?? 16_000
    return {
      ...provider(id, { window }),
      room: request => window - requestTokens(request) - template - reply(request),
      worstCase: request => requestTokens(request) + template + reply(request),
    }
  }

  /** The security profile with its real instructions, the one the figures of the design are for. */
  function realRun(research: Provider, voter: Provider): ProfileRun {
    const panel = String(securityProfile.lenses.length)
    return {
      ...runOf(research, Object.fromEntries(securityProfile.lenses.map(lens => [lens.id, voter]))),
      research: {
        instructions: securityProfile.prompts.research,
        ...targetOf(research),
      },
      lenses: securityProfile.lenses.map(lens => ({
        id: lens.id,
        instructions: renderTemplate(securityProfile.prompts.vote, { 'lens.id': lens.id, 'lens.question': lens.question, 'panel.size': panel }),
        ...targetOf(voter),
      })),
    }
  }

  it('states the rooms of a one-request research, a part and a vote, and the worst part with how many the cap holds', () => {
    const run = realRun(guarded('local', 8192), guarded('local', 8192))
    const budgets = profileBudgets(run, target => target.window, { ...settings, maxReviewTokens: 100_000 })
    // The figures computed from the real prompts at a window of 8192: 3841 tokens of diff for one request, 3529 for a part with three digits of position, and for each vote of the longest finding what its lens's text leaves of 8192 less 2048 for the reply and 512 for the template.
    expect(budgets.research.rooms).toEqual({ one: 3841, part: 3529 })
    expect(Object.values(budgets.lenses).map(lens => lens.room)).toEqual([1610, 1658, 1662])
    // A part holding the 3529 tokens the room leaves reserves the whole window, and the cap of 100000 holds 12 of them.
    expect(budgets.research.worstPart).toEqual({ tokens: 8192, holds: 12 })
    // A provider that states no room has none of it.
    const plain = profileBudgets(realRun(provider('plain', { window: 8192 }), provider('plain', { window: 8192 })), target => target.window, settings)
    expect(plain.research).not.toHaveProperty('rooms')
    expect(plain.research).not.toHaveProperty('worstPart')
    expect(Object.values(plain.lenses)).toEqual([
      { provider: 'plain', window: 8192, replyTokens: 2048 },
      { provider: 'plain', window: 8192, replyTokens: 2048 },
      { provider: 'plain', window: 8192, replyTokens: 2048 },
    ])
  })

  it('reads the template reserve from what the stated room leaves', () => {
    const run = realRun(guarded('cli', 8192, 4096), guarded('local', 200_000))
    const budgets = profileBudgets(run, target => target.window, settings)
    const [issue, ...rest] = roomIssues('security', budgets, run, settings.maxFindings)
    expect(rest).toEqual([])
    expect(issue.path).toBe('profiles.security')
    // 8192 less 1791 for the text, 4096 for the template and 2048 for the reply leaves 257.
    expect(issue.message).toBe('the research request on cli leaves 257 tokens for the diff, less than the 1024 a hunk may need: contextTokens 8192 counts 1791 for the instructions, 4096 for the chat template and 2048 for the reply: lower maxTokens, or state a larger window')
    // The same window with the usual 512 leaves room.
    const usual = realRun(guarded('local', 8192), guarded('local', 200_000))
    expect(roomIssues('security', profileBudgets(usual, target => target.window, settings), usual, settings.maxFindings)).toEqual([])
  })

  it('says there are no tokens for the diff, and how far over the window the other tokens are, below a room of 0', () => {
    /** The refusal of a research request whose provider has `window` tokens, a reply of 2000 and 512 for the chat template. */
    const refused = (window: number): string => {
      const run = realRun({
        ...guarded('local', window),
        maxTokens: 2000,
      }, guarded('big', 200_000))
      const [issue, ...rest] = roomIssues('security', profileBudgets(run, target => target.window, settings), run, settings.maxFindings)
      expect(rest).toEqual([])
      return issue.message
    }
    // 1791 tokens of text, 512 for the template and 2000 for the reply fill a window of 4303, which leaves a room of 0.
    expect(refused(4303)).toBe('the research request on local leaves 0 tokens for the diff, less than the 1024 a hunk may need: contextTokens 4303 counts 1791 for the instructions, 512 for the chat template and 2000 for the reply: lower maxTokens, or state a larger window')
    // One token fewer is a room of -1: the other tokens are 1 over, and every figure stays exact.
    expect(refused(4302)).toBe('the research request on local leaves no tokens for the diff, its other tokens 1 over the window, where a hunk may need 1024: contextTokens 4302 counts 1791 for the instructions, 512 for the chat template and 2000 for the reply: lower maxTokens, or state a larger window')
    // A voter's refusal reads the same way.
    const run = realRun(guarded('local', 200_000), {
      ...guarded('small', 1000),
    })
    const messages = roomIssues('security', profileBudgets(run, target => target.window, settings), run, settings.maxFindings).map(issue => issue.message)
    expect(messages).toHaveLength(3)
    for (const message of messages) expect(message).toMatch(/^the vote request on small for the longest finding leaves no tokens for the diff, its other tokens \d+ over the window, where a hunk may need 1024: contextTokens 1000 counts \d+ for the instructions and the finding, 512 for the chat template and \d+ for the reply: lower maxTokens, or state a larger window$/)
  })

  /** A program's profile with two lenses, which the tests below give guidelines and do-not-report text. */
  const naming: Profile = {
    id: 'naming',
    prompts: { research: 'Review this diff for names that mislead.', vote: 'Judge {{lens.id}}: {{lens.question}}' },
    lenses: [
      { id: 'clarity', question: 'Does the name mislead?' },
      { id: 'brevity', question: 'Is the name longer than it needs to be?' },
    ],
  }

  /** The run `createQuorum` compiles for `naming`, `documents` being its joined guidelines and do-not-report text and its rules: the research instructions end with the do-not-report paragraph, a vote carries the guidelines alone, and a profile that lists rules sends every one of them. */
  function documented(research: Provider, voter: Provider, documents: { readonly guidelines?: string, readonly doNotReport?: string, readonly rules?: readonly ReviewRule[] } = {}): ProfileRun {
    const prompt = naming.prompts.research
    const panel = String(naming.lenses.length)
    return {
      id: naming.id,
      research: {
        instructions: doNotReportInstructions(prompt, documents.doNotReport),
        ...targetOf(research),
      },
      lenses: naming.lenses.map(lens => ({
        id: lens.id,
        instructions: renderTemplate(naming.prompts.vote, { 'lens.id': lens.id, 'lens.question': lens.question, 'panel.size': panel }),
        ...targetOf(voter),
      })),
      thresholds: thresholdsFor(naming),
      failOn: 'high',
      gating: true,
      texts: {
        prompt,
        guidelines: documents.guidelines === undefined
          ? []
          : [documents.guidelines],
        doNotReport: documents.doNotReport === undefined
          ? []
          : [documents.doNotReport],
        rules: documents.rules ?? [],
        records: [],
      },
      rules: documents.rules ?? [],
      ...documents.rules === undefined || documents.rules.length === 0
        ? {}
        : { sent: documents.rules },
      ...documents.guidelines === undefined
        ? {}
        : { guidelines: documents.guidelines },
      ...documents.doNotReport === undefined
        ? {}
        : { doNotReport: documents.doNotReport },
    }
  }

  /** The messages of `run`'s refusals at a quorum's default settings. */
  const refusals = (run: ProfileRun): string[] => roomIssues(run.id, profileBudgets(run, target => target.window, settings), run, settings.maxFindings).map(issue => issue.message)

  /** The number each figure of a refusal that names its parts is, as `(\d+)` groups of `pattern`, after the window. */
  const figuresOf = (message: string, pattern: RegExp): number[] => {
    const found = pattern.exec(message)
    if (found === null) throw new Error(`no match in: ${message}`)
    return found.slice(1).map(Number)
  }

  it('refuses a profile whose guidelines leave its research less than 1024 tokens, naming their tokens and the fix', () => {
    const run = documented(guarded('local', 32_768), guarded('big', 200_000), {
      guidelines: 'g'.repeat(16_000),
      doNotReport: 'd'.repeat(5228),
    })
    const [message, ...rest] = refusals(run)
    expect(rest).toEqual([])
    // 32768 less 512 for the template and 8192 for the reply leaves 24064 for the instructions and the documents: the guidelines' 16000 bytes and their block's words, the do-not-report text's 5228 and the line that opens its paragraph.
    expect(message).toBe('the research request on local leaves 812 tokens for the diff, less than the 1024 a hunk may need: contextTokens 32768 counts 23252 for the instructions (1685), the guidelines (16308) and the do-not-report text (5259), 512 for the chat template and 8192 for the reply: shorten the guidelines or the do-not-report text, lower maxTokens, or state a larger window')
    const [room, window, fixed, instructions, guidelines, doNotReport, template, reply] = figuresOf(message, /leaves (\d+) tokens.*contextTokens (\d+) counts (\d+) for the instructions \((\d+)\), the guidelines \((\d+)\) and the do-not-report text \((\d+)\), (\d+) for the chat template and (\d+) for the reply/)
    // The figures add up: the three parts to the fixed tokens, and every term to the window.
    expect(instructions + guidelines + doNotReport).toBe(fixed)
    expect(room + fixed + template + reply).toBe(window)
    // The same profile with no document has the instructions alone in its figures.
    expect(requestTokens(researchRequest(run.texts.prompt, '', undefined, undefined, { findings: 50, replyTokens: 8192 }))).toBe(instructions)
  })

  it('names the instructions alone, and no document to shorten, for a profile with none', () => {
    const run = documented(guarded('local', 3200), guarded('big', 200_000))
    const [message, ...rest] = refusals(run)
    expect(rest).toEqual([])
    const [fixed] = figuresOf(message, /counts (\d+) for the instructions, \d+ for the chat template/)
    expect(message).toBe(`the research request on local leaves ${3200 - fixed - 512 - 800} tokens for the diff, less than the 1024 a hunk may need: contextTokens 3200 counts ${fixed} for the instructions, 512 for the chat template and 800 for the reply: lower maxTokens, or state a larger window`)
  })

  it('names the largest document first in the fix, and only the documents present', () => {
    const voter = guarded('big', 200_000)
    // The do-not-report text is the larger: it comes first, and the guidelines are named after it.
    const [both] = refusals(documented(guarded('local', 16_384), voter, {
      guidelines: 'g'.repeat(3000),
      doNotReport: 'd'.repeat(6000),
    }))
    expect(both).toMatch(/the instructions \(\d+\), the guidelines \(\d+\) and the do-not-report text \(\d+\), \d+ for the chat template/)
    expect(both).toMatch(/: shorten the do-not-report text or the guidelines, lower maxTokens, or state a larger window$/)
    // One document alone is named in the parts and in the fix, and the other is never mentioned.
    const [alone] = refusals(documented(guarded('local', 8192), voter, {
      doNotReport: 'd'.repeat(4500),
    }))
    expect(alone).toMatch(/counts \d+ for the instructions \(\d+\) and the do-not-report text \(\d+\), \d+ for the chat template/)
    expect(alone).toMatch(/: shorten the do-not-report text, lower maxTokens, or state a larger window$/)
    expect(alone).not.toContain('guidelines')
    const [guidelinesAlone] = refusals(documented(guarded('local', 8192), voter, {
      guidelines: 'g'.repeat(4500),
    }))
    expect(guidelinesAlone).toMatch(/counts \d+ for the instructions \(\d+\) and the guidelines \(\d+\), \d+ for the chat template/)
    expect(guidelinesAlone).toMatch(/: shorten the guidelines, lower maxTokens, or state a larger window$/)
    expect(guidelinesAlone).not.toContain('do-not-report')
  })

  it('names the guidelines in a vote\'s refusal', () => {
    const run = documented(guarded('big', 200_000), guarded('small', 10_000), {
      guidelines: 'g'.repeat(2500),
      doNotReport: 'd'.repeat(500),
    })
    const messages = refusals(run)
    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message).toMatch(/^the vote request on small for the longest finding leaves \d+ tokens for the diff, less than the 1024 a hunk may need: contextTokens 10000 counts \d+ for the instructions and the finding \(\d+\) and the guidelines \(\d+\), 512 for the chat template and 2500 for the reply: shorten the guidelines, lower maxTokens, or state a larger window$/)
      const [room, fixed, instructions, guidelines, template, reply] = figuresOf(message, /leaves (\d+) tokens.*counts (\d+) for the instructions and the finding \((\d+)\) and the guidelines \((\d+)\), (\d+) for the chat template and (\d+) for the reply/)
      expect(instructions + guidelines).toBe(fixed)
      expect(room + fixed + template + reply).toBe(10_000)
      // A vote carries the guidelines and never the do-not-report text.
      expect(guidelines).toBeGreaterThan(2500)
      expect(guidelines).toBeLessThan(2500 + 600)
      expect(message).not.toContain('do-not-report')
    }
  })

  /** Two rules of different sizes, which a profile that lists them sends whole. */
  const listed: ReviewRule[] = [
    {
      id: 'no-any',
      text: 'a'.repeat(3000),
      paths: ['src/**'],
    },
    {
      id: 'license',
      text: 'b'.repeat(2000),
    },
  ]

  it('counts the whole block of the rules listed in the research refusal', () => {
    const prompt = naming.prompts.research
    const ask = { findings: 50, replyTokens: 2000 }
    // The request of a profile that lists rules, and the same with an empty block: what the rules add is the block, its description line and its fence.
    const fixed = requestTokens(researchRequest(prompt, '', undefined, undefined, ask, listed))
    const rules = fixed - requestTokens(researchRequest(prompt, '', undefined, undefined, ask, []))
    const block = utf8Length(rulesBlock(listed))
    expect(rules).toBeGreaterThan(block)
    expect(rules).toBeLessThan(block + 600)
    // A window that leaves the diff 800 tokens, with a reply of 2000 and 512 for the chat template.
    const window = fixed + 512 + 2000 + 800
    const run = documented({
      ...guarded('local', window),
      maxTokens: 2000,
    }, guarded('big', 1_000_000), { rules: listed })
    const [message, ...rest] = refusals(run)
    expect(rest).toEqual([])
    expect(message).toBe(`the research request on local leaves 800 tokens for the diff, less than the 1024 a hunk may need: contextTokens ${window} counts ${fixed} for the instructions (${fixed - rules}) and the rules (${rules}), 512 for the chat template and 2000 for the reply: shorten the rules, lower maxTokens, or state a larger window`)
    // Both rules are counted, never the largest alone: the block is the sum of the two entries.
    expect(rules).toBeGreaterThan(5000)
    // No rule's text is in the message.
    expect(message).not.toMatch(/a{20}|b{20}/)
  })

  it('names the rules among the other documents, and the largest first in the fix', () => {
    const [message] = refusals(documented({
      ...guarded('local', 9000),
      maxTokens: 2000,
    }, guarded('big', 1_000_000), {
      guidelines: 'g'.repeat(900),
      doNotReport: 'd'.repeat(400),
      rules: listed,
    }))
    const found = /counts (\d+) for the instructions \((\d+)\), the guidelines \((\d+)\), the do-not-report text \((\d+)\) and the rules \((\d+)\), 512 for the chat template and 2000 for the reply: shorten the rules or the guidelines or the do-not-report text, lower maxTokens, or state a larger window$/.exec(message)
    expect(found).not.toBeNull()
    const [fixed, instructions, guidelines, doNotReport, rules] = (found as RegExpExecArray).slice(1).map(Number)
    expect(instructions + guidelines + doNotReport + rules).toBe(fixed)
    expect(rules).toBeGreaterThan(5000)
  })

  it('names no rule in a vote\'s refusal, which carries none', () => {
    const run = documented(guarded('big', 1_000_000), guarded('small', 1000), { rules: listed })
    const messages = refusals(run)
    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message).toMatch(/^the vote request on small for the longest finding /)
      expect(message).toContain('for the instructions and the finding, 512 for the chat template')
      expect(message).not.toContain('rules')
    }
  })

  it('names no rules when a run lists some and sends none: there is no block to shorten', () => {
    const run: ProfileRun = {
      ...documented(guarded('local', 3200), guarded('big', 200_000), { rules: listed }),
      sent: [],
    }
    const [message, ...rest] = refusals(run)
    expect(rest).toEqual([])
    expect(message).toMatch(/counts \d+ for the instructions, 512 for the chat template and 800 for the reply: lower maxTokens, or state a larger window$/)
    expect(message).not.toContain('rules')
  })
})
