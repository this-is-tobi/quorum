import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CompletionRequest, Provider, ReplyStore } from '../core/ports.ts'
import { FINDING_FIELDS, FINDING_FIELDS_WITH_RULE } from '../core/prompts.ts'
import { createQuorum } from '../core/quorum.ts'
import { rulesBlock } from '../core/rules.ts'
import type { Profile } from '../core/types.ts'
import { bestPracticesProfile } from './best-practices.ts'
import { codeReviewProfile } from './code-review.ts'
import { performanceProfile } from './performance.ts'
import { securityProfile } from './security.ts'

/** The change every request below reviews: line 3 of src/users.js is the loop that makes one call per id. */
const USERS_DIFF = [
  'diff --git a/src/users.js b/src/users.js',
  '--- a/src/users.js',
  '+++ b/src/users.js',
  '@@ -1,3 +1,5 @@',
  ' export async function names(db, ids) {',
  '-  return db.many(ids)',
  '+  const out = []',
  '+  for (const id of ids) out.push(await db.one(id))',
  '+  return out',
  ' }',
  '',
].join('\n')

/** The finding each profile's finder lists on `USERS_DIFF`: one, at line 3, in the category and under the rule its profile defines. */
const REPORTED = {
  'code-review': { category: 'data' },
  'best-practices': { category: 'error-handling', rule: 'io-errors' },
  performance: { category: 'perf', rule: 'query-in-loop' },
} as const

const isVote = (request: CompletionRequest): boolean => request.output.name === 'panel_vote'
const userText = (request: CompletionRequest): string => request.messages.map(message => message.content).join('\n')
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A provider that plays every role: it keeps a copy of each request, lists one finding for a research request and keeps every finding in a vote. */
function recording(listed: (system: string) => Record<string, unknown>): { readonly provider: Provider, readonly requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = []
  return {
    requests,
    provider: {
      id: 'both',
      model: 'both-model',
      complete: async (request) => {
        requests.push({ ...request })
        return {
          text: isVote(request)
            ? JSON.stringify({ keep: true, reasoning: 'r' })
            : JSON.stringify({
                findings: [
                  listed(request.system),
                ],
              }),
          model: 'both-model',
        }
      },
    },
  }
}

/** A store that keeps nothing and records the key of each call a review looks up. */
function keysOf(): { readonly store: ReplyStore, readonly keys: string[] } {
  const keys: string[] = []
  return {
    keys,
    store: {
      get: async (entry) => {
        keys.push(entry.key)
        return undefined
      },
      put: async () => {},
    },
  }
}

/** The SHA-256 of a review's store keys, sorted and written as JSON: the pin of what every call of a review is keyed by. */
const keysDigest = (keys: readonly string[]): string => sha256(JSON.stringify([...keys].sort()))

/** A review of `diff` by `profiles`, one provider playing every role of each, with the requests it was sent and the keys it looked up. */
async function reviewed(profiles: readonly Profile[], diff: string, listed: (system: string) => Record<string, unknown>): Promise<{ readonly requests: CompletionRequest[], readonly keys: string[] }> {
  const { provider, requests } = recording(listed)
  const { store, keys } = keysOf()
  await createQuorum({
    profiles: [...profiles],
  }, {
    profiles: Object.fromEntries(profiles.map(profile => [
      profile.id,
      {
        research: provider,
        voters: Object.fromEntries(profile.lenses.map(lens => [lens.id, provider])),
      },
    ])),
  }).review({ diff }, { store })
  return { requests, keys }
}

/** A review of `USERS_DIFF` by one new profile alone. */
async function reviewedAlone(profile: Profile): Promise<{ readonly requests: CompletionRequest[], readonly keys: string[] }> {
  const reported = REPORTED[profile.id as keyof typeof REPORTED]
  return reviewed([profile], USERS_DIFF, () => ({
    file: 'src/users.js',
    line: 3,
    quote: 'for (const id of ids) out.push(await db.one(id))',
    summary: 'one call per id',
    ...reported,
  }))
}

const NEW_PROFILES: ReadonlyArray<[string, Profile, string, string]> = [
  [
    codeReviewProfile.id,
    codeReviewProfile,
    FINDING_FIELDS,
    '1c0e1c2507a8c65c972edad43f16b2e333f9157e7bfeae97ddb5b1ec008a826b',
  ],
  [
    bestPracticesProfile.id,
    bestPracticesProfile,
    FINDING_FIELDS_WITH_RULE,
    '04c90294fa712bd7ac759fbce6daf9bab1a35024f2963cac7b79bbba5d0f690d',
  ],
  [
    performanceProfile.id,
    performanceProfile,
    FINDING_FIELDS_WITH_RULE,
    '216a348d4f81ffcd1cb76c5e05464ae10c6aaedce2f7e5006738bbc0f8af806e',
  ],
]

describe('the requests of the built-in profiles', () => {
  it.each(NEW_PROFILES)('sends %s\'s research request and its three votes as the plan states them, store key for store key', async (_id, profile, fields, digest) => {
    const { requests, keys } = await reviewedAlone(profile)
    const researches = requests.filter(request => !isVote(request))
    const votes = requests.filter(isVote)
    expect(researches).toHaveLength(1)
    expect(votes).toHaveLength(3)
    const [research] = researches
    expect(research.system.startsWith(`${profile.prompts.research}\n\nThis review does not report:\n${profile.doNotReport}\n\nList at most 20 findings, the most serious first.`)).toBe(true)
    expect(research.system).toContain(fields)
    if (profile.rules !== undefined) expect(userText(research)).toContain(rulesBlock(profile.rules))
    for (const lens of profile.lenses) {
      const rendered = `One vote in a 3-voter panel - you do not see the other votes. Refutation angle: ${lens.id}.\n${lens.question}\n\nJudge only from the blocks you receive. Default keep=false unless genuinely convinced.`
      expect(votes.filter(vote => vote.system.startsWith(rendered))).toHaveLength(1)
    }
    expect(keys).toHaveLength(4)
    expect(keysDigest(keys)).toBe(digest)
  })

  it.each(NEW_PROFILES)('sends %s\'s do-not-report text to its finder alone, never to a voter', async (_id, profile) => {
    const { requests } = await reviewedAlone(profile)
    const first = profile.doNotReport!.split('\n')[0]
    const votes = requests.filter(isVote)
    expect(votes).toHaveLength(3)
    for (const vote of votes) {
      for (const text of [
        vote.system,
        userText(vote),
      ]) {
        expect(text).not.toContain('This review does not report:')
        expect(text).not.toContain(first)
      }
    }
    expect(requests.filter(request => !isVote(request))[0].system).toContain(first)
  })

  it('sends a best-practices vote the one rule its finding cites, and a code-review vote none', async () => {
    const practices = await reviewedAlone(bestPracticesProfile)
    const practiceVotes = practices.requests.filter(isVote)
    expect(practiceVotes).toHaveLength(3)
    for (const vote of practiceVotes) {
      expect(userText(vote)).toMatch(/<untrusted-rule-[0-9a-f]{8}>\nio-errors, for every file:\n/)
      for (const other of ['input-validation', 'tests-for-new-code', 'resource-cleanup']) expect(userText(vote)).not.toContain(other)
    }
    const review = await reviewedAlone(codeReviewProfile)
    const reviewVotes = review.requests.filter(isVote)
    expect(reviewVotes).toHaveLength(3)
    for (const vote of reviewVotes) expect(userText(vote)).not.toContain('<untrusted-rule-')
  })

  it('keeps the security profile\'s requests key for key in a review beside the three', async () => {
    // 6a's pin: the diff, and the research and reachability keys of the security profile's review of it.
    const pinned = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -0,0 +1 @@\n+exec(cmd)\n'
    const keyOf = (role: 'research' | 'vote', digest: string, sent: CompletionRequest): string => sha256(JSON.stringify([
      role,
      digest,
      sent.replyTokens ?? null,
      sent.thinking ?? null,
      sent.structuredOutput ?? null,
    ]))
    const at = {
      file: 'a.js',
      line: 1,
      quote: 'exec(cmd)',
      summary: 'one finding',
    }
    const { requests, keys } = await reviewed(
      [
        securityProfile,
        codeReviewProfile,
        bestPracticesProfile,
        performanceProfile,
      ],
      pinned,
      (system) => {
        if (system.startsWith(securityProfile.prompts.research)) return { ...at, category: 'CWE-78', summary: 'command injection' }
        if (system.startsWith(codeReviewProfile.prompts.research)) return { ...at, category: 'bug' }
        return system.startsWith(performanceProfile.prompts.research)
          ? { ...at, category: 'perf', rule: 'query-in-loop' }
          : { ...at, category: 'error-handling', rule: 'io-errors' }
      },
    )
    const research = requests.find(request => !isVote(request) && request.system.startsWith(securityProfile.prompts.research))
    const reachability = requests.find(request => isVote(request) && request.system.includes('Refutation angle: reachability.'))
    expect(research?.system).toContain('List at most 50 findings, the most serious first.')
    expect(keys).toContain(keyOf('research', '9332a0a8136fce260d587532024e35f86770b01eca89c4fbf8f5467d327ea63f', research!))
    expect(keys).toContain(keyOf('vote', 'fe469cddd24059068c2f23e261a56dce57d0d262ba03bb18040463909015542d', reachability!))
  })
})
