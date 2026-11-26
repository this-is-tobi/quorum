import type { Profile } from '../core/types.ts'
import { bestPracticesProfile } from './best-practices.ts'
import { codeReviewProfile } from './code-review.ts'
import { performanceProfile } from './performance.ts'
import { securityProfile } from './security.ts'

/** One built-in profile and what is known of it: plain data, checked by the same `profileIssues` as any profile. */
export interface BuiltInProfile {
  readonly profile: Profile
  /** Whether a labelled set measures the profile's precision: `false` for a profile that is design intent until quorum has a set of its own. */
  readonly measured: boolean
}

const SECURITY: BuiltInProfile = Object.freeze({ profile: securityProfile, measured: true })
const OTHERS: readonly BuiltInProfile[] = [
  Object.freeze({ profile: codeReviewProfile, measured: false }),
  Object.freeze({ profile: bestPracticesProfile, measured: false }),
  Object.freeze({ profile: performanceProfile, measured: false }),
]

/**
 * The profiles a config can run or extend, in the order they are listed: `security`, `code-review`, `best-practices` and
 * `performance`. A later pack of profiles is one more list of entries, joined here.
 */
export const BUILT_IN_PROFILES: readonly BuiltInProfile[] = Object.freeze([SECURITY, ...OTHERS])

/** The built-in profiles by id, which `resolveProfiles` reads. */
export const BUILT_IN: ReadonlyMap<string, Profile> = new Map(BUILT_IN_PROFILES.map(({ profile }) => [profile.id, profile]))

/** The ids of the built-in profiles in order, which the config's `extends` accepts. */
export const BUILT_IN_IDS: readonly [string, ...string[]] = Object.freeze<[string, ...string[]]>([
  SECURITY.profile.id,
  ...OTHERS.map(({ profile }) => profile.id),
])

/** The ids of the built-in profiles no labelled set measures. */
export const UNMEASURED: ReadonlySet<string> = new Set(BUILT_IN_PROFILES.filter(({ measured }) => !measured).map(({ profile }) => profile.id))
