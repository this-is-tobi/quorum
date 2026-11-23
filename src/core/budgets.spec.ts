import { describe, expect, it } from 'vitest'
import { securityProfile } from '../profiles/security.ts'
import { profileBudgets, replyBudget, roomIssues } from './budgets.ts'
import type { BudgetSettings, ReplyFacts } from './budgets.ts'
import type { CompletionRequest, Provider } from './ports.ts'
import { thresholdsFor } from './profile.ts'
import { renderTemplate } from './prompts.ts'
import { targetOf } from './stages/context.ts'
import type { ProfileRun } from './stages/context.ts'
import { replyLimit, requestTokens } from './tokens.ts'

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
    expect(issue.message).toBe('the research request on cli leaves 257 tokens for the diff, less than the 1024 a hunk may need: contextTokens 8192 counts 1791 for the instructions, guidelines and rules, 4096 for the chat template and 2048 for the reply: shorten the guidelines or rules, lower maxTokens, or state a larger window')
    // The same window with the usual 512 leaves room.
    const usual = realRun(guarded('local', 8192), guarded('local', 200_000))
    expect(roomIssues('security', profileBudgets(usual, target => target.window, settings), usual, settings.maxFindings)).toEqual([])
  })
})
