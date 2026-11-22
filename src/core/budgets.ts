import { issuePath } from './errors.ts'
import type { ConfigIssue } from './errors.ts'
import { MIN_PART_TOKENS } from './parts.ts'
import { DEFAULT_MAX_FINDINGS, researchRequest, voteRequest } from './prompts.ts'
import type { PartOf } from './prompts.ts'
import { reservationOf, roomOf } from './stages/context.ts'
import type { LensRun, ProfileRun, Target } from './stages/context.ts'
import { requestTokens } from './tokens.ts'
import { longestFinding } from './verify.ts'

/**
 * The reply budget of each request kind, which the core derives from what a provider states of itself (its
 * window, its `maxTokens` and its `thinking`) so that a reply of one kind is never given more room than it
 * needs, nor less than it must have. With `W` the window, `M` `maxFindings`, `F` `FINDING_TOKENS`, `E`
 * `ENVELOPE_TOKENS` and `T` the thinking allowance (`THINKING_TOKENS`):
 *
 * - a research reply takes `R = min(M * F + E + T, floor(W / 4))`: what its findings and its thinking need,
 *   and at most a quarter of the window, so three quarters stay for the request. With `maxTokens` set, `R` is
 *   `maxTokens`: the owner's ceiling, the decision of the one who knows the server;
 * - the research request asks for `N = max(1, min(M, floor((R - T' - E) / F)))` findings, `T' = min(T, floor(R / 2))`,
 *   so the thinking keeps its room and takes at most half of the budget. `N'` is the same without the
 *   thinking, `max(1, min(M, floor((R - E) / F)))`, for a model that shows none;
 * - a vote takes `V = min(maxTokens, VOTE_TOKENS + T, floor(W / 4))`: 1024 tokens hold a verdict and its
 *   reasoning, and the thinking allowance comes on top. `maxTokens` is a ceiling of the vote too, so a large
 *   one set for research no longer reserves that much for every vote.
 *
 * A learned cut on the way gives the provider a `ceiling`, which `min`s into `R` and `V` when `maxTokens` is unset, and
 * N follows from the lowered `R`. A provider that states no window then has a budget of the ceiling's size.
 *
 * A term whose fact a provider does not state drops out: with neither a window nor `maxTokens`, `R` and `V`
 * are undefined, the request sizes nothing and `N` is `M`, so a provider object that states nothing is
 * reserved and asked as it always was.
 *
 * Room accounting reads the same budgets against what a provider states of its room (`Provider.room`): the
 * request is built with its reply budget, and the room it leaves for a diff is the provider's own answer.
 * A provider that states no room has none, and nothing here checks it; its size guard refuses each request too
 * large, as it always did. See `profileBudgets` and `roomIssues`.
 *
 * The allowances sit below OpenAI's advice of 25 000 tokens for reasoning and outputs, since quorum's replies
 * are short and recovery lowers the thinking of a reply that is cut off. `FINDING_TOKENS` is an assumption,
 * the design's placeholder: no recorded run holds the output tokens of one finding, so the figure is not yet
 * measured.
 */

/** The output tokens one finding takes, a placeholder until a recorded run measures it (an assumption). */
export const FINDING_TOKENS = 256

/** The output tokens of a research reply's envelope, around its findings. */
export const ENVELOPE_TOKENS = 32

/** The tokens a verdict and its reasoning take, before the thinking allowance. */
export const VOTE_TOKENS = 1024

/**
 * The output tokens a research reply usually takes, which the estimate counts a reply at when its budget is larger
 * (an assumption, the design's placeholder: no recorded run holds the output tokens of each research call, so the
 * figure is not yet measured). A larger `maxTokens` is headroom, not an expectation.
 */
export const EXPECTED_REPLY_TOKENS = 4096

export { DEFAULT_MAX_FINDINGS }

/** How much a provider is told to think: its own default, a lowered level, or none. */
export type ThinkingLevel = 'default' | 'low' | 'off'

/** The tokens a reply is given for thinking, by level. */
export const THINKING_TOKENS: Readonly<Record<ThinkingLevel, number>> = { off: 0, low: 4096, default: 8192 }

/**
 * What a provider states of its replies: its window and its `maxTokens` when it sets them, and its thinking level, `default`
 * when unstated. A `ceiling` is what a review learned: the reply a cut on the way lets through, which holds a derived
 * research and vote budget down to it, and never a `maxTokens`, the owner's decision.
 */
export interface ReplyFacts {
  readonly window?: number
  readonly maxTokens?: number
  readonly thinking: ThinkingLevel
  readonly ceiling?: number
}

/** The reply budgets of one provider, in tokens: undefined where nothing is stated to size a reply by. */
export interface ReplyBudget {
  readonly research: number | undefined
  readonly vote: number | undefined
  /** The findings a research request asks for at most: `N`. */
  readonly findings: number
  /** The findings it asks for from a model that shows no thinking: `N'`. */
  readonly findingsWithoutThinking: number
}

/**
 * The reply budgets of `facts`' provider on `window`, the effective window, which is the stated one until a
 * review learns another: a research reply's, a vote's, and the findings a research request asks for with and
 * without the thinking allowance.
 */
export function replyBudget(facts: ReplyFacts, window: number | undefined, maxFindings: number): ReplyBudget {
  const thinking = THINKING_TOKENS[facts.thinking]
  const quarter = window === undefined
    ? Number.POSITIVE_INFINITY
    : Math.floor(window / 4)
  const { maxTokens } = facts
  // A ceiling holds a derived budget down; a maxTokens the provider sets is never lowered.
  const ceiling = maxTokens === undefined
    ? facts.ceiling
    : undefined
  const limit = ceiling ?? Number.POSITIVE_INFINITY
  const research = maxTokens ?? (window === undefined && ceiling === undefined
    ? undefined
    : Math.min(maxFindings * FINDING_TOKENS + ENVELOPE_TOKENS + thinking, quarter, limit))
  const vote = maxTokens === undefined && window === undefined && ceiling === undefined
    ? undefined
    : Math.min(maxTokens ?? Number.POSITIVE_INFINITY, VOTE_TOKENS + thinking, quarter, limit)
  if (research === undefined) {
    return {
      research,
      vote,
      findings: maxFindings,
      findingsWithoutThinking: maxFindings,
    }
  }
  const held = (tokens: number): number => Math.max(1, Math.min(maxFindings, Math.floor((research - tokens - ENVELOPE_TOKENS) / FINDING_TOKENS)))
  return {
    research,
    vote,
    findings: held(Math.min(thinking, Math.floor(research / 2))),
    findingsWithoutThinking: held(0),
  }
}

/** What a profile's budgets read of a quorum's settings: `maxFindings` sizes the replies, `partTokens` and `maxReviewTokens` the worst case of a research part. */
export interface BudgetSettings {
  readonly maxFindings: number
  readonly partTokens: number
  readonly maxReviewTokens: number
}

/** The budgets of one profile: its research provider's, with the findings its requests ask for, and each lens's voter's. */
export interface ProfileBudgets {
  readonly research: {
    readonly provider: string
    readonly window?: number
    readonly replyTokens?: number
    readonly findings: number
    readonly findingsWithoutThinking: number
    /**
     * The tokens of diff the provider's stated room leaves a request with its reply budget and N at `maxFindings`: the
     * one-request research's (an empty diff), and a part's, whose parts block lists no file and is at its smallest.
     * Absent for a provider that states no room, or states one it cannot say for a request.
     */
    readonly rooms?: { readonly one: number, readonly part: number }
    /**
     * What the ledger reserves for a part that holds as much diff as its room and `partTokens` allow, and how many of them
     * the review's token cap holds: the worst case of a part that lists no file. Where `partTokens` bounds the diff, the
     * figure runs low and `holds` high, by the size of the file list a real part carries; where the room bounds it, both
     * are exact. Set with `rooms`.
     */
    readonly worstPart?: { readonly tokens: number, readonly holds: number }
  }
  readonly lenses: Readonly<Record<string, {
    readonly provider: string
    readonly window?: number
    readonly replyTokens?: number
    /** The tokens of diff the voter's stated room leaves the vote for the longest finding. */
    readonly room?: number
  }>>
}

/** The facts a target stated when the quorum was created. */
export function factsOf(target: Target): ReplyFacts {
  return {
    thinking: target.thinking,
    ...target.window === undefined
      ? {}
      : { window: target.window },
    ...target.maxTokens === undefined
      ? {}
      : { maxTokens: target.maxTokens },
  }
}

/** A window and a reply budget as a profile's budgets hold them: each left out when it is undefined. */
function sizes(window: number | undefined, replyTokens: number | undefined): { readonly window?: number, readonly replyTokens?: number } {
  return {
    ...window === undefined
      ? {}
      : { window },
    ...replyTokens === undefined
      ? {}
      : { replyTokens },
  }
}

/** The position a part's request is sized at: the hundredth of a hundred, three digits for each, which lists no file. Its parts block is the smallest that a change of many parts gives, since the files it would list depend on the diff. */
const PART_POSITION: PartOf = {
  index: 100,
  count: 100,
  files: [],
  unlisted: 0,
}

/** The research request of `run` over an empty diff, one request or, with `part`, a part's, asking for `maxFindings` findings, the widest its N line can be. */
function researchProbe(run: ProfileRun, replyTokens: number | undefined, maxFindings: number, part?: PartOf): ReturnType<typeof researchRequest> {
  return researchRequest(run.research.instructions, '', run.guidelines, part, { findings: maxFindings, replyTokens })
}

/** The vote request of `lens` for the longest finding, over an empty diff: the one the estimate's bound and the startup refusal size a vote by. */
function voteProbe(run: ProfileRun, lens: LensRun, replyTokens: number | undefined): ReturnType<typeof voteRequest> {
  return voteRequest(lens.instructions, longestFinding(''), '', run.guidelines, false, { replyTokens })
}

/** The rooms of a profile's research and the worst case of its parts, or none when its research provider states no room. */
function researchRooms(run: ProfileRun, replyTokens: number | undefined, settings: BudgetSettings): Pick<ProfileBudgets['research'], 'rooms' | 'worstPart'> {
  if (run.research.room === undefined) return {}
  const one = roomOf(run.research, researchProbe(run, replyTokens, settings.maxFindings))
  const partProbe = researchProbe(run, replyTokens, settings.maxFindings, PART_POSITION)
  const part = roomOf(run.research, partProbe)
  if (one === undefined || part === undefined) return {}
  // A request's reservation grows by a token for each token of diff, one per byte as the size guard counts, so the part that fills its room is the empty one's reservation and that many tokens: no diff of up to `partTokens` bytes is built.
  const tokens = reservationOf(run.research, partProbe) + Math.max(0, Math.min(settings.partTokens, part))
  return {
    rooms: { one, part },
    worstPart: {
      tokens,
      holds: Math.floor(settings.maxReviewTokens / tokens),
    },
  }
}

/**
 * The reply budgets and the rooms of one profile, from its providers' stated facts and the window `windowOf` gives each of
 * them, frozen. `createQuorum` calls it with the stated windows (`target => target.window`); a later phase calls it again
 * for each review with the effective ones, and the signature stays. `settings` gives `maxFindings`, which sizes N,
 * and `partTokens` and `maxReviewTokens`, which size the worst case of a part.
 *
 * The rooms are what each provider states for the requests the review sends (`roomOf`), so a provider that states none has none:
 * the research's, for the one-request research and a part, and each lens's, for the vote of the longest finding.
 */
export function profileBudgets(run: ProfileRun, windowOf: (target: Target) => number | undefined, settings: BudgetSettings): ProfileBudgets {
  const research = windowOf(run.research)
  const budget = replyBudget(factsOf(run.research), research, settings.maxFindings)
  return freezeBudgets({
    research: {
      provider: run.research.ref.id,
      ...sizes(research, budget.research),
      findings: budget.findings,
      findingsWithoutThinking: budget.findingsWithoutThinking,
      ...researchRooms(run, budget.research, settings),
    },
    lenses: Object.fromEntries(run.lenses.map((lens) => {
      const window = windowOf(lens)
      const replyTokens = replyBudget(factsOf(lens), window, settings.maxFindings).vote
      const room = lens.room === undefined
        ? undefined
        : roomOf(lens, voteProbe(run, lens, replyTokens))
      return [
        lens.id,
        {
          provider: lens.ref.id,
          ...sizes(window, replyTokens),
          ...room === undefined
            ? {}
            : { room },
        },
      ]
    })),
  })
}

/** `budgets` and everything it holds, frozen: a quorum's budgets are read by every review and printed, and nothing changes them. */
function freezeBudgets(budgets: ProfileBudgets): ProfileBudgets {
  const { rooms, worstPart } = budgets.research
  if (rooms !== undefined) Object.freeze(rooms)
  if (worstPart !== undefined) Object.freeze(worstPart)
  for (const lens of Object.values(budgets.lenses)) Object.freeze(lens)
  Object.freeze(budgets.research)
  Object.freeze(budgets.lenses)
  return Object.freeze(budgets)
}

/** The words every refusal ends on, by what it says to lower. */
const RESEARCH_FIX = 'shorten the guidelines or rules, lower maxTokens, or state a larger window'
const VOTE_FIX = 'shorten the guidelines, lower maxTokens, or state a larger window'

/** One refusal: the request `subject` names leaves `room` tokens for the diff of a window whose other tokens are `fixed`, the chat template, and the reply. */
function refusal(subject: string, facts: { readonly room: number, readonly window: number, readonly fixed: number, readonly reply: number, readonly counts: string, readonly fix: string }): string {
  const template = facts.window - facts.fixed - facts.reply - facts.room
  return `${subject} leaves ${facts.room} tokens for the diff, less than the ${MIN_PART_TOKENS} a hunk may need: contextTokens ${facts.window} counts ${facts.fixed} for ${facts.counts}, ${template} for the chat template and ${facts.reply} for the reply: ${facts.fix}`
}

/**
 * The profile's startup refusals, at `profiles.<id>`: a research provider whose room for the one-request research,
 * with N at `maxFindings` and an empty diff, is below `MIN_PART_TOKENS` (1024), and a voter whose room for the vote of
 * the longest finding over an empty diff is. A hunk may need that much, so such a profile would run every request into
 * a `request-too-large` gap. A part's room never refuses: its parts block depends on the diff. Each message names the
 * provider's id and the figures that add up to its window: the fixed text, the core's `requestTokens` of the request, the reply
 * budget, the room, and the chat template, which is what the stated room leaves of the window besides them, so the
 * adapter's own reserve (512, or 4096 for `claude-code`) is read, never assumed.
 *
 * A provider that states no room is checked by nothing here, and neither is one that states a room and no window or reply
 * budget, whose message could not name its figures: the size guard of each of its requests stays.
 */
export function roomIssues(id: string, budgets: ProfileBudgets, run: ProfileRun, maxFindings: number): ConfigIssue[] {
  const path = issuePath(['profiles', id])
  const messages = new Set<string>()
  const { research } = budgets
  if (research.rooms !== undefined && research.rooms.one < MIN_PART_TOKENS && research.window !== undefined && research.replyTokens !== undefined) {
    messages.add(refusal(`the research request on ${research.provider}`, {
      room: research.rooms.one,
      window: research.window,
      fixed: requestTokens(researchProbe(run, research.replyTokens, maxFindings)),
      reply: research.replyTokens,
      counts: 'the instructions, guidelines and rules',
      fix: RESEARCH_FIX,
    }))
  }
  for (const lens of run.lenses) {
    const { room, window, replyTokens, provider } = budgets.lenses[lens.id]
    if (room === undefined || room >= MIN_PART_TOKENS || window === undefined || replyTokens === undefined) continue
    messages.add(refusal(`the vote request on ${provider} for the longest finding`, {
      room,
      window,
      fixed: requestTokens(voteProbe(run, lens, replyTokens)),
      reply: replyTokens,
      counts: 'the instructions, guidelines and finding',
      fix: VOTE_FIX,
    }))
  }
  return [...messages].map(message => ({ path, message }))
}
