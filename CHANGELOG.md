# Changelog

## [0.9.0](https://github.com/this-is-tobi/quorum/compare/v0.8.0...v0.9.0) (2026-11-22)


### ⚠ BREAKING CHANGES

* a path review is never held at exit 2 for its size, an explicit maxReviewTokens below its estimate runs to its cap with token-cap gaps, and with reviewTimeoutMs unset its deadline is 24 hours where it was 30 minutes.
* an interrupted review writes its result and exits 130 where 0.8.0 wrote nothing; interrupted is a new gap reason, coverage reason, vote failure and outcome status, in every format.
* a review writes new stderr lines in every mode, its part lines, heartbeat and summary, and a live block on a terminal: a script that read stderr through a pseudo-terminal sets --progress plain.
* QuorumEvent gains the call:start, call:retry, part and run:stopping types, and its call and stage:start events gain fields, so an exhaustive switch over it no longer compiles.

### Features

* draw a live panel under the log on a terminal, with plain, JSON and quiet modes ([ca4f02d](https://github.com/this-is-tobi/quorum/commit/ca4f02df5359a5f3c36bc0576ef5f30d86576174))
* draw the progress block of a review: its parts, calls, tokens and time left, to fit ([130d52a](https://github.com/this-is-tobi/quorum/commit/130d52ace9aa37c31dcad65d7b3c1750b326f774))
* end every review with a summary of its time, tokens, calls, gaps and where the report went ([9f52d57](https://github.com/this-is-tobi/quorum/commit/9f52d57549eb71e90fc0877c6571386447c56ce6))
* keep a path review's answered calls by default on a terminal, for a rerun to reuse ([8916db3](https://github.com/this-is-tobi/quorum/commit/8916db38b752dab223c40f3eb67f670349c440da))
* keep what a review read when it is interrupted, and write its report with exit 130 ([63dfd03](https://github.com/this-is-tobi/quorum/commit/63dfd03ed61dfdce3262646e2e2a7d1bcc22ada2))
* let a path review's token cap follow its estimate, and its deadline run a day ([147d5fa](https://github.com/this-is-tobi/quorum/commit/147d5fa499f1fdf3e30d6ea56ed1db2f8d073d61))
* report each call's start, each retry, each research part and the deadline as events ([f4253b7](https://github.com/this-is-tobi/quorum/commit/f4253b71a17c0b52f252acbabbe8a1466e264772))
* write each research part, retry and stop on stderr, with a heartbeat in a quiet minute ([21be9e0](https://github.com/this-is-tobi/quorum/commit/21be9e0d37da3902822b4d257fba01092beb836e))


### Bug Fixes

* name a call cut on the way and after how long, where the fix said to check the server ([6b20a3b](https://github.com/this-is-tobi/quorum/commit/6b20a3b7942f0159a291a8fe7470c0ba8a285f88))
* start each erase of the progress block at the line's start, so an echoed ^C leaves nothing ([3fefb9e](https://github.com/this-is-tobi/quorum/commit/3fefb9e1450926139ff7de966aebe163fd51e11c))
* stop calling a provider at its first reply that says its quota or credit is used up ([cff0493](https://github.com/this-is-tobi/quorum/commit/cff0493092bc131df607c1ab32841fd9b4a40b8a))

## [0.8.0](https://github.com/this-is-tobi/quorum/compare/v0.7.0...v0.8.0) (2026-11-21)


### ⚠ BREAKING CHANGES

* a profile whose fixed text leaves a provider less than 1024 tokens of diff is refused at startup, exit 2, where 0.7.0 ran it into gaps.
* a path review reviews no test file by default.
* reply-cut-off is a new gap and coverage reason; a reply that lists every finding it was asked for, read at the floor or at maxFindings, is now a findings-capped gap; and a profile's meta gains recovery.
* meta.adaptations is a new required field of the result, and structuredOutput unset now moves to prompt mode on an empty reply.
* with maxTokens unset, a research request sends about 21000 tokens on a large window and a quarter of a small one, and a vote at most 1024 plus the thinking allowance, where both sent 16000; every research request gains the line that asks for at most N findings.
* no-answer is a new failure kind of a provider error and of a vote.
* results.jsonl holds no denied record, and report.json and report.md no denied count.
* a gating profile's failed research part exits 4 where it exited 3, and provider-down is a new gap reason, coverage reason and vote failure kind.

### Features

* expect a research reply at its usual size, and bound recovery in the estimate's worst case ([badfea1](https://github.com/this-is-tobi/quorum/commit/badfea198642b607525d5219a886109061faadd4))
* give each request kind a reply budget, and ask research for as many findings as it holds ([7e35332](https://github.com/this-is-tobi/quorum/commit/7e3533298dda9c56630854820443fd6c8da650c4))
* keep every answered call with --state, and reuse it on a rerun ([c7e5861](https://github.com/this-is-tobi/quorum/commit/c7e58615b35d4cccc2b215bc33d5b7f5f19e3de8))
* lower thinking and move to prompt mode by itself for the rest of a review, and say so ([c78e08d](https://github.com/this-is-tobi/quorum/commit/c78e08d6c0e5d21b0efedd67d5925978bf26ecbb))
* recover a cut-off or saturated research part by splitting it, to a floor of one hunk ([ccb11a3](https://github.com/this-is-tobi/quorum/commit/ccb11a31b7eb3ee321719ff41ab9244dc114b461))
* refuse before any call a profile whose fixed text leaves a provider no room for a diff ([5637a0f](https://github.com/this-is-tobi/quorum/commit/5637a0f6d66874e5863f0af6701456188c2c390f))
* set a provider's thinking to off or low, mapped to each protocol's own control ([d22ad35](https://github.com/this-is-tobi/quorum/commit/d22ad3560da8ea6f262eb783f1a47e2c82c201d2))
* skip test files in a path review by default, listed with the rule test ([9c80c51](https://github.com/this-is-tobi/quorum/commit/9c80c51b4bb8ad8128097645b33fbdc6ead6ba9e))


### Bug Fixes

* keep reviewing when a research part fails, and stop calling a provider that is down ([d7912eb](https://github.com/this-is-tobi/quorum/commit/d7912ebb600ee967f06a1f9fdb11e6a099f320ba))
* read what a reply lacked in every adapter, and say how to fix it ([92a6159](https://github.com/this-is-tobi/quorum/commit/92a615982423b4451e5eb06b457ad834156e87f4))


### Code Refactoring

* record every bench review with its result, now that no reply denies a review ([ec97dac](https://github.com/this-is-tobi/quorum/commit/ec97dacbf009c03ea4f99dfff0bcdd404238cd07))


### Dependencies

* **deps:** update bun to v1.4.5 ([dbf815f](https://github.com/this-is-tobi/quorum/commit/dbf815f3ff349fa4c3edcd4896c30499f15d930f))

## [0.7.0](https://github.com/this-is-tobi/quorum/compare/v0.6.0...v0.7.0) (2026-11-17)


### ⚠ BREAKING CHANGES

* on a terminal, quorum now writes the text report on stdout instead of the JSON result. A pipe, a file and CI keep JSON, and -f json keeps it on a terminal.
* --print-config prints a profile's failOn where it printed gating, the type ProfileMeta.failOn is required, and securityProfile no longer states gating.

### Features

* add recipes for Claude Code and git: a review skill, a commit hook and two git hooks ([6dda814](https://github.com/this-is-tobi/quorum/commit/6dda8146c3e3c7031d1605221b9573e07326142f))
* bound what quorum mcp spends over its life, and let the operator narrow what an agent reads ([aac9ac8](https://github.com/this-is-tobi/quorum/commit/aac9ac846cdd77a8c7f2e50dc1380e7fde2606c4))
* decide the exit code in the core with outcome, and gate each profile at its failOn level ([37b0fe7](https://github.com/this-is-tobi/quorum/commit/37b0fe7d274af0983465c7f66253a848b817d01b))
* fingerprint each finding so a comment or an alert survives a push that moves its line ([1e3703a](https://github.com/this-is-tobi/quorum/commit/1e3703ae98fe61c262d27cf95abf48dbd6cb860e))
* name the row of a finding's evidence that shows its cited line, as evidenceRow ([4336237](https://github.com/this-is-tobi/quorum/commit/43362371dd17a27f7bd2825f9a0218ffdc156d7f))
* print a text report for a person on a terminal, colored unless NO_COLOR says not ([d5ca80a](https://github.com/this-is-tobi/quorum/commit/d5ca80afa2e400caeed77d5506257696b87a8243))
* render a review through reporters, json and brief, chosen with --format ([fd6c152](https://github.com/this-is-tobi/quorum/commit/fd6c152f296d4e3877cde831c09f0fdc13f04372))
* render a saved result with quorum report, through a strict reader with a cap ([487a8ab](https://github.com/this-is-tobi/quorum/commit/487a8ab27c500c6c2702d398d9fb53b65913013f))
* render model and diff text inert in Markdown and in plain text a viewer may link ([fc1491e](https://github.com/this-is-tobi/quorum/commit/fc1491e2841a46be59d5a7fd0d7ce9f4179b529e))
* serve quorum's review tool over MCP with quorum mcp ([471ff03](https://github.com/this-is-tobi/quorum/commit/471ff0359e34787eca82d4d2a2b8a9f4c4568753))
* set a profile's fail-on level from the command line with --fail-on ([ff82f8b](https://github.com/this-is-tobi/quorum/commit/ff82f8be16067851b0332b99bfea426ecd128cdc))
* shape what a calling agent receives of a review: code-checked fields first, capped claims ([eff4ba9](https://github.com/this-is-tobi/quorum/commit/eff4ba995815eb1e58074c0ce0b8370af33f40b5))
* withhold what helps an attacker from public outputs with --view public, the public view ([2fc54b7](https://github.com/this-is-tobi/quorum/commit/2fc54b7ea33fa10e438036df5597f71c9683de70))
* write a Markdown summary of a review for a pull request or a job summary, with -f markdown ([368d8cb](https://github.com/this-is-tobi/quorum/commit/368d8cb8206051025a8ec147e6b6dbc4f95fb7c2))
* write more reports to files with --output, whole and never through a link ([6b8cf82](https://github.com/this-is-tobi/quorum/commit/6b8cf827e6787b843ae71f37f7ce8f662b4675d0))
* write SARIF for GitHub code scanning, with levels that agree with the exit code ([f7a4d18](https://github.com/this-is-tobi/quorum/commit/f7a4d1846ef4c55564c81f65180d17d745c5682c))
* write the payload quorum-action posts, with the summary and a line comment per finding ([bbb194f](https://github.com/this-is-tobi/quorum/commit/bbb194f48a437e0992b4ada3255b6777487f5728))


### Bug Fixes

* build the release binaries and the image with the MCP SDK they bundle ([aad36b9](https://github.com/this-is-tobi/quorum/commit/aad36b9895150e1673f8081ec9ac80db51a84358))
* read untracked files beneath the top level, so no link swapped into a path is followed ([dc99947](https://github.com/this-is-tobi/quorum/commit/dc999470526d2262112e289ff038afeb0f6a2fa2))


### Dependencies

* add the MCP SDK, pinned exactly, as an optional peer that npm does not install ([c433244](https://github.com/this-is-tobi/quorum/commit/c4332446f3fce4a516032976652504fba4b3a08b))

## [0.6.0](https://github.com/this-is-tobi/quorum/compare/v0.5.0...v0.6.0) (2026-11-16)


### ⚠ BREAKING CHANGES

* a diff holding such a file, which 0.5.0 sent whole, now ends incomplete, exit 4, even with --allow-incomplete, unless the change deletes a file named as a secret whole. A program names a file to send all the same in review's send, and the CLI in --send or the config's send.
* meta.leftOut entries can have the reason skipped, with a rule, and meta.flags can hold the code secret-file, values a strict reader of the result must take.
* a diff over partTokens (32768), or over the research model's window, is now reviewed in parts: more calls per review, and findings that one request missed, which can fail a run that passed. A large diff now spends up to the token cap, where 0.5.0 sent nothing and exited 4. Every profile of the JSON result now carries coverage, on every run, and meta.incomplete can hold the reason too-large, so a strict reader of the result must take both.
* a provider object's own room field that is not a function is now refused when the quorum is created, where 0.5.0 ignored it, and one that is a function now states the provider's room to the core.

### Features

* estimate a review before any call, and hold a path review that may pass the cap ([dd2775b](https://github.com/this-is-tobi/quorum/commit/dd2775b759e298414083ef3bf13a48370f7114da))
* give a vote the hunks nearest its cited line when its voter cannot hold the whole section ([fc22ed9](https://github.com/this-is-tobi/quorum/commit/fc22ed9d64b4df6f5ee41826dbeb2d7b5e112bc8))
* let a provider state the room a request leaves in its window, as its size guard counts ([a3c3931](https://github.com/this-is-tobi/quorum/commit/a3c393146527e3cdcf77c1784737bca2c236d82c))
* pack a diff's sections into parts within a token budget, never cutting a hunk ([0365d08](https://github.com/this-is-tobi/quorum/commit/0365d0845e2b8d0f882132a9fba8e387500ed85a))
* read a commit's tree by id through ls-tree and one cat-file, every size known first ([0e313eb](https://github.com/this-is-tobi/quorum/commit/0e313eb8a2562400c0a1ba88837d097d501db3fe))
* review a large change in parts, each a research request, with each profile's coverage ([0158b2e](https://github.com/this-is-tobi/quorum/commit/0158b2e977759198cc57702069eb7749260a391f))
* review a range of commits with --range &lt;base&gt;...&lt;head&gt;, quorum running git itself ([7e11df9](https://github.com/this-is-tobi/quorum/commit/7e11df926b62a3e2977d96fb41587457bcc7f2bf))
* review local and staged changes, refusing a repository whose own config names a filter ([2f86242](https://github.com/this-is-tobi/quorum/commit/2f8624269da69d98c723429dd63deebe65e607e1))
* review the files under a path at a commit, with default skips listed and secrets flagged ([da33c7f](https://github.com/this-is-tobi/quorum/commit/da33c7feae2dfa746e711fe6252be91abe272a83))
* run git through one hardened runner, with its pins, an environment allowlist and a floor ([dfca702](https://github.com/this-is-tobi/quorum/commit/dfca7023dade27849b95ca6759ed1cc024da4099))
* set the research part size with partTokens in a config, printed and fingerprinted ([5198091](https://github.com/this-is-tobi/quorum/commit/51980913725a647ae85e1ef2f7cb3ff307f53cbc))
* take a review's source and the files it left out, and record the source in meta.source ([203d42c](https://github.com/this-is-tobi/quorum/commit/203d42ccc119f1b35107428c98f5873f689dcf10))
* write files as git's new-file diff, quoted as git quotes, in hunks of at most 4 KiB ([64fc635](https://github.com/this-is-tobi/quorum/commit/64fc635208ff13777d361068d8ee3118a1a26cf4))


### Bug Fixes

* hold back from every diff a file named as a secret or holding a credential, as a gap ([0b39e71](https://github.com/this-is-tobi/quorum/commit/0b39e71486e3c90ed08a9cbd3677a28cae7c4fba))
* send a file held as a secret all the same, with --send or the config's send list ([b517e48](https://github.com/this-is-tobi/quorum/commit/b517e488fa9cb6ea35c1797446541dc483745a97))
* share the secret rule with path reviews, which send a template once its content is clean ([aa14e10](https://github.com/this-is-tobi/quorum/commit/aa14e10a66cd980c04779a16adb88e67a92366e3))
* tell a file held back as a secret, by its name or by a credential it holds ([816a4be](https://github.com/this-is-tobi/quorum/commit/816a4be6616ff267b233063cf916b6a70620ec96))

## [0.5.0](https://github.com/this-is-tobi/quorum/compare/v0.4.0...v0.5.0) (2026-11-15)


### ⚠ BREAKING CHANGES

* a review now ends at 30 minutes by default (reviewTimeoutMs): what it has not done by then is a review-deadline gap, which exits 4 for a gating profile, even with --allow-incomplete.
* a review now stops at 2000000 tokens by default (maxReviewTokens): what it has not done by then is a token-cap gap, which exits 4 for a gating profile, even with --allow-incomplete. Every call event now carries spent, the tokens the cap counted for the call, so a program that reads the events strictly must take the field.
* --allow-incomplete no longer lifts decoy findings past maxFindings, an unreadable finding, an unusable research reply, or a vote refused, cut off or unusable: a run that passed with the flag can now exit 4. Nor does it lift a vote that failed as process, invalid-response, aborted or unsupported, or with an error a custom provider throws. Every vote of the JSON result now carries failure, null for a vote that was cast, so a strict reader of the result must take it.
* an openai-compatible, gemini or ollama provider without maxTokens now sends 16000 as the reply's limit, where it sent none, and a claude-code provider sends 16000, where Claude Code asked for 128000; a longer reply now fails as truncated, so raise maxTokens for a reasoning model. An openai-compatible provider with no preset sends the limit as max_tokens, which the reasoning models of OpenAI and Azure refuse, so set maxTokensField to max_completion_tokens for them.
* a claude-code provider's run now has a deadline, timeoutMs times retries plus one, 30 minutes by default, which also bounds a long reply; Claude Code's own retries follow retries, 2 by default where Claude Code alone makes 10; and the provider's timeoutMs and retries replace an API_TIMEOUT_MS or CLAUDE_CODE_MAX_RETRIES the environment sets. A provider object that already has its own timeoutMs or retries field now states them to the core.
* a gating review now exits 4 when the diff shows a file only as binary or a submodule only as its commit, even with --allow-incomplete. List such files in the named config's exclude to review the rest of the change.

### Features

* cap what a review spends at 2000000 tokens, reserving each attempt before it is sent ([b317d9b](https://github.com/this-is-tobi/quorum/commit/b317d9b0eba76e7b2e01b18d51cb9dd282c7c936))
* end a review at 30 minutes with an answer, recording what it had not done as a gap ([313275f](https://github.com/this-is-tobi/quorum/commit/313275f8ee7504b55d0bda18f92e550d16ed8b47))
* leave out of every request the files createQuorum's exclude patterns match ([d1226d5](https://github.com/this-is-tobi/quorum/commit/d1226d506c28119c336d06795bb65bb0f77a29d3))
* let a provider state the worst case of one attempt, counted as its size guard counts ([f197049](https://github.com/this-is-tobi/quorum/commit/f197049deb70af7b97dd072c0199bc79a6f2adc5))
* name the files a review left out in one line on stderr, and in a left-out event ([d981a5d](https://github.com/this-is-tobi/quorum/commit/d981a5d490efcb1daa6fe29cb77758ead8be9414))
* read a failed reply's retry hint and spend codes, and Gemini's retry delay and per-day quota ([cd6717f](https://github.com/this-is-tobi/quorum/commit/cd6717fc7c111cc0f76ea5feac1924923ac3315c))
* read exclude from the named config, print it, and hold it in the bench's fingerprint ([6ab2978](https://github.com/this-is-tobi/quorum/commit/6ab2978906f6c528e92602e2d9274aa0e120bd93))
* record an advisory profile's failed research as its own gap, so it no longer fails the run ([f538d69](https://github.com/this-is-tobi/quorum/commit/f538d6975bfae39827cc0957e18c1b5dfb8b3372))
* retry a call that failed in passing, as often as its provider states, after a growing wait ([bc471db](https://github.com/this-is-tobi/quorum/commit/bc471db6c4efe9a40a5bac87cdde375783292fe3))
* retry a shipped provider's call twice by default, and set Claude Code's own retries to two ([199f8d3](https://github.com/this-is-tobi/quorum/commit/199f8d39052e6f79cc300c377b5906942bd73a80))
* set the review's token cap and deadline in a config or in their own variables ([8cf4235](https://github.com/this-is-tobi/quorum/commit/8cf42357a95b5db4cefc4abcd23f123fe432ce08))
* set timeoutMs and retries in a config or the role variables, printed and in the fingerprint ([b383ab9](https://github.com/this-is-tobi/quorum/commit/b383ab91e8c3e83b560d40c5722e2fc4b58a99ce))
* stop starting bench reviews once a run has spent --max-run-tokens ([bf2933f](https://github.com/this-is-tobi/quorum/commit/bf2933f2cb241531b1186ee193a32e6e02df2db7))


### Bug Fixes

* exclude a renamed file only when its rename to line confirms the header's path ([714aef8](https://github.com/this-is-tobi/quorum/commit/714aef8ae8e609381db4680a1834e49785d980ce))
* give each provider call a 10-minute deadline of quorum's own, and turn the runtimes' timers off ([50c6ce8](https://github.com/this-is-tobi/quorum/commit/50c6ce863a671408f1fa56763ea99109ca173f9d))
* lift a gap with --allow-incomplete only when a vote failed in passing ([477f0e8](https://github.com/this-is-tobi/quorum/commit/477f0e83176e6661bab445263b006689458849bd))
* make the CI recipe's diff override the ignore setting a pull request writes in .gitmodules ([bfb49da](https://github.com/this-is-tobi/quorum/commit/bfb49da0d31cec433f090eb248109a6d861dc1c3))
* never run a code config provider object's getters when one of its stated facts is refused ([393517d](https://github.com/this-is-tobi/quorum/commit/393517d51401219375699431197ae3dc3b1875ab))
* record a binary or submodule file the diff does not show as a gap no flag lifts ([55bdec9](https://github.com/this-is-tobi/quorum/commit/55bdec91b6fa0ed8d65384aeb5df898bc05e4031))
* say what bounds a claude-code run, and that its settings replace Claude Code's own ([99ccbbc](https://github.com/this-is-tobi/quorum/commit/99ccbbcfd43ef644c31676519da5cb7a90f3d1c7))
* send a reply limit of 16000 tokens by default, Claude Code's included, so no reply runs on ([4e23e40](https://github.com/this-is-tobi/quorum/commit/4e23e4092dd765d00ddb64b4d0ab1cd47216e32b))


### Code Refactoring

* end a call's retries when its retry count is not a number ([15c620b](https://github.com/this-is-tobi/quorum/commit/15c620bec790ba384d14a0668be94514d1bd8b2d))

## [0.4.0](https://github.com/this-is-tobi/quorum/compare/v0.3.0...v0.4.0) (2026-11-14)


### Features

* add --report-only to quorum bench, to write the reports with no review run ([3382e05](https://github.com/this-is-tobi/quorum/commit/3382e05ef7018aeb46bf3565d7cd26ca273b01b7))
* add bench/injection, 48 attack cases on twelve twins of the real-bug suite ([f42a676](https://github.com/this-is-tobi/quorum/commit/f42a67612d0d9b773302ab59c8631aad70bccfc3))
* add the development script that writes the injection corpus from its manifest ([5bc4e02](https://github.com/this-is-tobi/quorum/commit/5bc4e026124d16946adece0421240f29a38ac256))
* give a bench suite a review hash and a scoring hash, and name both in the reports ([974297c](https://github.com/this-is-tobi/quorum/commit/974297c78ab8d8ac43ea2226963c437ed8f89dc8))
* grow bench/bugs with vulnerabilities in Python, Rust, C#, PHP and Ruby ([895880b](https://github.com/this-is-tobi/quorum/commit/895880b8aabcb3cccc88e53f9efdc10a827efb52))
* grow bench/bugs with vulnerabilities in Ruby, C#, PHP and Go ([1220874](https://github.com/this-is-tobi/quorum/commit/1220874320412d21fe20983da9a818533445b09b))
* grow bench/bugs with vulnerabilities in TypeScript, JavaScript and Java ([0612c29](https://github.com/this-is-tobi/quorum/commit/0612c290355522ae5650ec70034ba626bcfea59c))
* re-score a recorded bench run whose suite changed in suite.yaml alone, with no call ([c7177aa](https://github.com/this-is-tobi/quorum/commit/c7177aaf3c8882ce94326ce261e0663990677db7))
* read attack cases in a bench suite, the poisoned twins of its bug cases ([049ded0](https://github.com/this-is-tobi/quorum/commit/049ded0f93b5d85ba8c13a8c13d966d5b0b7f945))
* record a bench review that a model's reply denied, rather than retry it ([c754319](https://github.com/this-is-tobi/quorum/commit/c754319be24f0a736ddb5a468d2c1fc55140fd75))
* score a bench review against decoys, and report the lenses' error correlation ([a46e5e2](https://github.com/this-is-tobi/quorum/commit/a46e5e2895899c1d1d5d73e3f59698ed0f010b1d))
* score the attack cases of a bench suite against their twins ([e90f4db](https://github.com/this-is-tobi/quorum/commit/e90f4dbad3ba651b3e10203a44b7d695d60a25c0))


### Bug Fixes

* bound the z of the bench's wilson interval, and word where signTest's p stops being exact ([1cb6f97](https://github.com/this-is-tobi/quorum/commit/1cb6f9712b8319d3534fa63fb0a7c333eab692a9))
* carry a refused or cut-off reply's counts on its error, and read Gemini's missing counts as 0 ([a52a5c3](https://github.com/this-is-tobi/quorum/commit/a52a5c351627fe6a1a4246acd828d521169eaee3))
* check each location of a bench suite against its patch's hunks in one pass ([51239a1](https://github.com/this-is-tobi/quorum/commit/51239a14c6d96da42c279175084af8e74674696c))
* count a tie between a twin's two means as a tie, and test a twin's missing trial ([a861c1a](https://github.com/this-is-tobi/quorum/commit/a861c1a42f73bc66dc6d93ca8fa444af8347f65b))
* count the usage a failed call's error carries, in its call event and meta.usage ([4347cdb](https://github.com/this-is-tobi/quorum/commit/4347cdbbab055ade9f7ec02c7b70051990bcf75a))
* hold the denial's fail-closed cases and words in tests, and say what a denied trial counts as ([e8fd992](https://github.com/this-is-tobi/quorum/commit/e8fd992a8f838e0a8bdcf8578572746c350a1a97))
* keep the bench's statistics to their domains, and write a zero difference without a sign ([bc5deba](https://github.com/this-is-tobi/quorum/commit/bc5debaec79cf75da361f9de611e0681841c1488))
* keep the three notices of the gateway case's files, and word a missing CVE id alike ([0239e55](https://github.com/this-is-tobi/quorum/commit/0239e55322b506086ddf443a501387c6d9d5a8ee))
* move one guideline-file attack to .cursorrules, and test the corpus's payload rules ([bbedb3f](https://github.com/this-is-tobi/quorum/commit/bbedb3f13033560709e2ddb160b13073ac8e8d54))
* print a mean phi that rounds to zero without its sign, and judge unreviewed findings in a test ([e6f7a36](https://github.com/this-is-tobi/quorum/commit/e6f7a364af89c64a0c172d9493baa489c1d709ff))
* refuse a --config that quorum bench is given twice, before it reads any config ([31dc723](https://github.com/this-is-tobi/quorum/commit/31dc723c472efb82f907dab057fccaaad6260cd8))
* refuse a repeated id in the corpus manifest, and refuse YAML warnings without quoting them ([583712f](https://github.com/this-is-tobi/quorum/commit/583712f8b346dd327f369b564ee23f900bd785b3))
* refuse a results.jsonl deleted after quorum bench read it, without making it again ([19b0977](https://github.com/this-is-tobi/quorum/commit/19b09772a805f721fc381c87c8499412dd302781))
* refuse a results.jsonl that changed after quorum bench read it, and keep its data private ([f6ac83f](https://github.com/this-is-tobi/quorum/commit/f6ac83f29acd684f102ceac4b369eb033cef18e3))
* say in the FOSUserBundle case's note that a finding on its weak fallback is unmatched ([3caa6e5](https://github.com/this-is-tobi/quorum/commit/3caa6e5ed1d314932975f608ee3398fcda4950f1))
* say that a run another quorum began resumes with that quorum, beside a new --out ([3c65cb2](https://github.com/this-is-tobi/quorum/commit/3c65cb2e06cf0803e04f5a532aea21536e9d1a25))
* say that three later commits reshaped the fonttools case's parser call, not one ([704e475](https://github.com/this-is-tobi/quorum/commit/704e475358157460e1f3b2d36346fdbbfb10e553))


### Code Refactoring

* build a configuration's latency list once in the bench report ([93b29e1](https://github.com/this-is-tobi/quorum/commit/93b29e12172f1a7a12f21531fe9fe07bd8ea43f4))
* give quorum bench's execute one object of what it runs, and check the case it scores ([29a57cd](https://github.com/this-is-tobi/quorum/commit/29a57cd20e1d8efc639940f52aa451c894c75353))
* share one strict flag parser between quorum and quorum bench ([86c6640](https://github.com/this-is-tobi/quorum/commit/86c6640d3cd9053bdd5b4ed20dd09b5daf190d80))
* split loadSuite into its stages, and share the lstat mapping with the config loader ([af46fae](https://github.com/this-is-tobi/quorum/commit/af46fae6d0bbd61d47e6932cffb6f765c7d535ed))

## [0.3.0](https://github.com/this-is-tobi/quorum/compare/v0.2.0...v0.3.0) (2026-11-13)


### Features

* add the quorum bench command ([bbf06c9](https://github.com/this-is-tobi/quorum/commit/bbf06c95ea8f1f1453dad7ed28b17b34408cc5da))
* fingerprint a bench configuration by every setting a review uses ([9cb6099](https://github.com/this-is-tobi/quorum/commit/9cb60997d5a44295cf164f41d60de8105aa138b2))
* keep a bench run in a directory of its own ([eae880c](https://github.com/this-is-tobi/quorum/commit/eae880c9b0b04e8df0d5542b755e176b1423e472))
* read and validate a bench suite ([79e2a6c](https://github.com/this-is-tobi/quorum/commit/79e2a6c699a88f4566425325dddd63235e7c999e))
* report a bench run in Markdown and JSON ([a3ba338](https://github.com/this-is-tobi/quorum/commit/a3ba3384648b3a0ad53bc64236159a06ae654f04))
* run the reviews of a bench, each with a quorum of its own ([aa08c29](https://github.com/this-is-tobi/quorum/commit/aa08c292e9f4503f075e63629dd2265e6da0f981))
* score a bench review, and compute Wilson intervals and exact sign tests ([d4af8df](https://github.com/this-is-tobi/quorum/commit/d4af8df9839291d9bce17b987415a462db8877da))
* seed bench/bugs with real security vulnerabilities ([a5f9f61](https://github.com/this-is-tobi/quorum/commit/a5f9f61ed0768decce7ed7072b65dfb4cc064f79))


### Bug Fixes

* keep a vote request's claim on its two lines, and word the data notice for one block ([358e5c9](https://github.com/this-is-tobi/quorum/commit/358e5c9cc676b227db3e178db7c38e36e24eb598))
* name a changed configuration once when quorum bench refuses to resume a run ([36c7b32](https://github.com/this-is-tobi/quorum/commit/36c7b326fa74ba82505504a4670c513f05f0d369))
* name in the mistune case's note the other advisories its fix closes ([1e703c0](https://github.com/this-is-tobi/quorum/commit/1e703c0e296312714fe0282bea7f4b7c7e1af3ac))
* write nothing when quorum bench is interrupted before its first review starts ([1b9715a](https://github.com/this-is-tobi/quorum/commit/1b9715a784702508b6bff0a2c31c0fcbbdb4d262))


### Dependencies

* **deps:** update gcr.io/distroless/cc-debian13:nonroot docker digest to cb87acc ([f7c052c](https://github.com/this-is-tobi/quorum/commit/f7c052c0bdbc4a1c2bbadb151fc2976b16886296))

## [0.2.0](https://github.com/this-is-tobi/quorum/compare/v0.1.0...v0.2.0) (2026-11-12)


### Features

* build release binaries for linux and macOS, with their checksums ([c06a547](https://github.com/this-is-tobi/quorum/commit/c06a547038f94672882bbfb7b611556ef0fdeb7a))
* publish quorum on npm as @tobi-or-not/quorum, running on Node ([2553408](https://github.com/this-is-tobi/quorum/commit/2553408d96e3c9c7637009bf7808fa2721ecbcbf))
* ship a container image running the compiled binary as a non-root user ([2fd0d6d](https://github.com/this-is-tobi/quorum/commit/2fd0d6d203fbce2f840e797bd4e96d30ba504c34))

## 0.1.0 (2026-11-12)


### Features

* accept claude-code providers in the config schema and the provider builder ([7a854f1](https://github.com/this-is-tobi/quorum/commit/7a854f123b51ba4c2e4187dc9e82cf08a12b8de1))
* add defineConfig and the json schema of the config file ([d23402a](https://github.com/this-is-tobi/quorum/commit/d23402ac29e09bc47c08740b941e1bac9fcaa473))
* add loadConfig and fromConfig, which build a quorum from a config and the environment ([0a5c64a](https://github.com/this-is-tobi/quorum/commit/0a5c64aa41cc63616fe04bc7cf321b2c5a8ba64c))
* add the anthropic adapter ([8d7be64](https://github.com/this-is-tobi/quorum/commit/8d7be644bfdd6a61bf4dd4d1c5c1a3306f2de652))
* add the config schema, strict for a data file and for a code config ([4b28157](https://github.com/this-is-tobi/quorum/commit/4b281570b3581710a0dec4a7c46cdd5bc86f5338))
* add the gemini adapter ([921fc10](https://github.com/this-is-tobi/quorum/commit/921fc10b10025d32f30ee762f129e4174f31fd23))
* add the ollama adapter, failing on a prompt past the context ([6769f2a](https://github.com/this-is-tobi/quorum/commit/6769f2ad1df8c15ccf254b788cd8a92548c23c44))
* add the openai-compatible provider ([c168e79](https://github.com/this-is-tobi/quorum/commit/c168e79ec55f32a1fa67c934ff227ecd117fbcf6))
* add the presets table ([5d5b5ae](https://github.com/this-is-tobi/quorum/commit/5d5b5aeeec676eefdab9815a17f14ff4d84eae7c))
* add the provider port, provider errors and a JSON POST helper ([36dac19](https://github.com/this-is-tobi/quorum/commit/36dac196c2887e387b91d0c1385b809af48caeff))
* add the temporary environment wiring for providers ([57c735f](https://github.com/this-is-tobi/quorum/commit/57c735f82b152ee55341770535d1e461ef6f5194))
* build a provider from a preset or a protocol ([f89cb5c](https://github.com/this-is-tobi/quorum/commit/f89cb5c3d4ea35ad78486fa6db1421c380a49a11))
* build the claude command line and environment, and read its JSON result ([764dc9d](https://github.com/this-is-tobi/quorum/commit/764dc9d52f1c883eb9ef280e762edca28f4fb857))
* check a profile before it runs ([b85d743](https://github.com/this-is-tobi/quorum/commit/b85d743eed9c76431b3bb44e845ab905255fdccd))
* compute confidence from a policy of vote thresholds ([17a4532](https://github.com/this-is-tobi/quorum/commit/17a453201144c7529646b086aeafd404e49391da))
* describe each data block of a request in its system message ([5767e68](https://github.com/this-is-tobi/quorum/commit/5767e68cfaa78fed9d7b79183f52a1b4214537a2))
* fail closed when a provider's context size is unknown ([4597f55](https://github.com/this-is-tobi/quorum/commit/4597f558cab068378f8ff074f51261c3f18d72af))
* find the claude executable for a run, and print claude-code providers ([e70c697](https://github.com/this-is-tobi/quorum/commit/e70c69741019db39d462680d10b604886bfe9124))
* flag hidden characters and text addressed to an ai reviewer ([735992d](https://github.com/this-is-tobi/quorum/commit/735992dd42b45b1bd1fa4f95d45b983ec2261788))
* give findings a stable id and their profile ([c0af388](https://github.com/this-is-tobi/quorum/commit/c0af3887609f599281d5e9b14d37e17a36de37a7))
* initial import of the quorum pipeline ([3bfd9af](https://github.com/this-is-tobi/quorum/commit/3bfd9afe376583edfa33afbec5888ede4d206b68))
* make review run the profile it is given ([fd1ee35](https://github.com/this-is-tobi/quorum/commit/fd1ee35d9eb0a8c92c5d6b71f6b53bf3106f052a))
* parse the flags, exit 130 on an interrupt, and gate only on gating profiles ([2dc4b1d](https://github.com/this-is-tobi/quorum/commit/2dc4b1dd3016a55df0c86aa102857ed1915ba938))
* print every cli line and the json result through the sanitizer ([f391c00](https://github.com/this-is-tobi/quorum/commit/f391c0074b3720509a8a48b2379a3ad35d2d2b33))
* print the resolved config with --print-config, every secret redacted ([b5b36b3](https://github.com/this-is-tobi/quorum/commit/b5b36b35f687a06765c22044523738d1cbe8715b))
* read a named yaml or json config file as plain data ([4dcf045](https://github.com/this-is-tobi/quorum/commit/4dcf0457ef8e76139194e51156d5e7ba3770bc81))
* read a ts or js config, and the prompt files a profile names ([e33f7c4](https://github.com/this-is-tobi/quorum/commit/e33f7c4d7e910b455b6e72b6c7e0fba94dff291e))
* read server errors, content parts and early stops in compatible replies ([5a8446f](https://github.com/this-is-tobi/quorum/commit/5a8446fd6c61823ec5a7d011bae9190a98798fe4))
* read the QUORUM_ variables and their deprecated aliases, and derive the voter ([e09fb2e](https://github.com/this-is-tobi/quorum/commit/e09fb2e14c9d20f7e63ea73934b70b162869b784))
* record a request too large for its model as a gap no flag lifts, and cap the diff ([66c5222](https://github.com/this-is-tobi/quorum/commit/66c522215e3867543fa71d52134f7318dcce7223))
* refuse a request that may not fit the model's context before sending it ([1ac3d1e](https://github.com/this-is-tobi/quorum/commit/1ac3d1e7b08940850ad12288cdc1b7208465c25c))
* render text inert for terminals, ci logs and json ([66abf12](https://github.com/this-is-tobi/quorum/commit/66abf1248733c3702725e893e5f1f0026cf7f30f))
* report advisory flags in meta and events, and hand the sink copies ([827f867](https://github.com/this-is-tobi/quorum/commit/827f867a70b386ab248bf8994a0a3a288c9fe640))
* resolve a config's layers, roles and keys into a frozen resolved config ([a7a05f8](https://github.com/this-is-tobi/quorum/commit/a7a05f887fdd74f321883037488adf45044cadc6))
* resolve the profiles a config runs, from a built-in profile or their own fields ([1df0146](https://github.com/this-is-tobi/quorum/commit/1df01460d9b68407327b6a9ee0c6f502ac543b74))
* review through loadConfig and fromConfig, and never exit 0 without a result ([0a87d24](https://github.com/this-is-tobi/quorum/commit/0a87d2477fe6ea8c87cb45e6707b795fd48c88e0))
* run claude for each request in a fresh directory, with abort and cleanup ([b3f8a44](https://github.com/this-is-tobi/quorum/commit/b3f8a443066e16a977aa0d424531de57aff99466))
* run profiles through createQuorum with typed stages and events ([b0013f9](https://github.com/this-is-tobi/quorum/commit/b0013f94b67923d467b05114656eec48e4084641))
* set a provider's context size in the config and QUORUM_&lt;ROLE&gt;_CONTEXT_TOKENS ([4c33a04](https://github.com/this-is-tobi/quorum/commit/4c33a04347205cdc16e722c53a59369461bda259))
* share auth styles, headers, query, extra body and system placement ([0dec7fb](https://github.com/this-is-tobi/quorum/commit/0dec7fb9a572286ce1b3e4cf0377b4a1cc826cb2))
* stop a review on abort or when its event sink throws ([d99c887](https://github.com/this-is-tobi/quorum/commit/d99c8874f8109c4c72cdbb74533c1d3a590f4096))
* take a profile selection over QUORUM_PROFILES, and warn about unread variables ([20c2709](https://github.com/this-is-tobi/quorum/commit/20c2709261b883a9f0b73e707a0b0b46eaf68298))
* talk to the local Ollama through its native API when no endpoint is set ([0deaf22](https://github.com/this-is-tobi/quorum/commit/0deaf22a844e4e09194f5f46c7ab76db86f04273))


### Bug Fixes

* abort the review the moment a research call fails ([7d1e868](https://github.com/this-is-tobi/quorum/commit/7d1e8689052c044aaac4877e8268faf6fac43312))
* bound concurrent model calls ([e5a62e0](https://github.com/this-is-tobi/quorum/commit/e5a62e0fc6de430ed5635db99b2376db0a36b693))
* bound the depth walk and the values of a config ([7858111](https://github.com/this-is-tobi/quorum/commit/7858111a5962f6b6bfd84d5c19b6efb0fb9b6a9c))
* build each request inside its concurrency slot ([4bb438b](https://github.com/this-is-tobi/quorum/commit/4bb438b846ac931c14061096fa2616e69b133280))
* build the binary so it loads no .env or bunfig.toml from its working directory ([c834643](https://github.com/this-is-tobi/quorum/commit/c8346431344fcfd876f7ce232ad9b9bde6fc74e7))
* capture extraBody once checked, redact header values, refuse non-map headers ([09e7782](https://github.com/this-is-tobi/quorum/commit/09e77827385e412a7843a6fd92ada42761b944d0))
* check a code config's schema inside the guard that hides what it throws ([f2e2147](https://github.com/this-is-tobi/quorum/commit/f2e2147ef3de89c9e1cbe1c622a362b16fe1f818))
* count a request in linear time, from each code point's longest form ([8c503b3](https://github.com/this-is-tobi/quorum/commit/8c503b373f9c4c7709ed9f03fec811ba6d269f9a))
* count each text in its normalized forms, so a normalizing tokenizer stays bounded ([ed52210](https://github.com/this-is-tobi/quorum/commit/ed522104cce35cc89ff0746a16696078aca8b326))
* derive finding evidence from the diff, not from the finder ([bc463e7](https://github.com/this-is-tobi/quorum/commit/bc463e700a9fb7af3aab6ac7ec14a11b33901df4))
* distinct exit codes, no stdin hang, skip empty diffs ([33314d2](https://github.com/this-is-tobi/quorum/commit/33314d20b966c3e6848152d72c2683e949dd233c))
* exit 4 when the review is incomplete ([36a2093](https://github.com/this-is-tobi/quorum/commit/36a2093d8bdb7a6d1836b70d14057c36aab6da63))
* fail a claude run ended by a signal, and keep plugin and body variables from the child ([be65ee9](https://github.com/this-is-tobi/quorum/commit/be65ee936a00a5aa59d9c56a6d0fd6a06f44e72f))
* fail a reply that shows a tool the server ran, and refuse azure's data_sources ([67dcbab](https://github.com/this-is-tobi/quorum/commit/67dcbab1089b1c1629237f28bea1fb20c28705d0))
* fail closed on broken JSON objects and resolve escaped file names ([2395129](https://github.com/this-is-tobi/quorum/commit/2395129df1bb5cac66ff4a2bad6ba74125711129))
* fail on an unserializable request body before sending it ([f1f6865](https://github.com/this-is-tobi/quorum/commit/f1f6865da96ffbd119fb306e41904995ab74dcbb))
* fence untrusted data and give voters the cited file's diff ([ef126fd](https://github.com/this-is-tobi/quorum/commit/ef126fd1a60e782b3bba20b8c9a86ef5cab8b151))
* find every template variable whatever the shared regex state ([ec85b12](https://github.com/this-is-tobi/quorum/commit/ec85b129dccce0d57a8ad9c73ce4fbdf65e01cc2))
* give the claude version check a deadline, and let each waiter abort on its own signal ([862a96d](https://github.com/this-is-tobi/quorum/commit/862a96da2bb07e590d80862aec14dc1d68bbbdbd))
* guard the parser limit, refuse a rule with two shapes and tighten the research details ([a7c502d](https://github.com/this-is-tobi/quorum/commit/a7c502d7c76dab84fbe373d1ab9e8de9352c3cd4))
* harden file lookup, quoted names and broken reply objects ([d3a1ea4](https://github.com/this-is-tobi/quorum/commit/d3a1ea408ef64f81e0a7bf6916d7cba258f22cd5))
* keep a derived voter off a preset's key on another host, and pin every resolution issue ([affd297](https://github.com/this-is-tobi/quorum/commit/affd297238420c1e0398cb8e2c0b3e5e42e8122f))
* keep each code point's count in a fixed table, not a growing map ([3186908](https://github.com/this-is-tobi/quorum/commit/318690848474484b14a040291eddfd549faab9f5))
* keep every hunk of a file repeated in a diff ([3ea9739](https://github.com/this-is-tobi/quorum/commit/3ea9739b61450e9b1a8479be94b478b8be1ab3fe))
* keep file mentions out of the claude child, and require Claude Code 2.1.311 ([e961cb3](https://github.com/this-is-tobi/quorum/commit/e961cb3563a7a40978d1554fee5cbe9af47b42f4))
* keep IDE and claude.ai connectors off in the claude child, and its login free of headers ([79646a7](https://github.com/this-is-tobi/quorum/commit/79646a7c0916739522862d3d93e34f1f358fe119))
* keep numeric and string constraints out of the wire schemas ([bbeea31](https://github.com/this-is-tobi/quorum/commit/bbeea3194977ecc198332c57ea7f198dc5f81d58))
* keep the claude login off a local socket, and the task tools out of the child ([93b6ea6](https://github.com/this-is-tobi/quorum/commit/93b6ea60ad86d30ebab1ef14842e0defdc5bf652))
* keep the cli's error lines total and inert, the last-resort one included ([4e5f0b0](https://github.com/this-is-tobi/quorum/commit/4e5f0b0935509f04120a2621b2fcda0613535adb))
* keep the research key and model off a voter on another endpoint ([5747e6c](https://github.com/this-is-tobi/quorum/commit/5747e6c3a3f637198551b04cbc5c69efe8f08892))
* mark a finding with a nested extra field unreadable and name the position ([d74f32e](https://github.com/this-is-tobi/quorum/commit/d74f32e45804c1a5a858905dd08f22574ac04600))
* match ai-addressed text split by hidden characters, bare fence tags and reordered replies ([5701f31](https://github.com/this-is-tobi/quorum/commit/5701f31b84bf3fb783b125e4b52aa517d1fd67c2))
* name the review input when it is not an object ([452de1d](https://github.com/this-is-tobi/quorum/commit/452de1d8a09bb8837213c5a17fed42d8fea349ec))
* parse model replies strictly and in bounded time ([879656e](https://github.com/this-is-tobi/quorum/commit/879656e9601a39fab8483f2b4adc58d7786e25f4))
* print a record key in an issue path only when it is a safe name, and cap the message ([a99c1b8](https://github.com/this-is-tobi/quorum/commit/a99c1b8aec4aa6e48491bf655bd5557187c20852))
* print the warnings of a failed run, and refuse a relative QUORUM_CONFIG ([93c1939](https://github.com/this-is-tobi/quorum/commit/93c1939f209c60c668e71a83394d8fbb0f8fb0df))
* quote the file name in vote-failed details and scope the incomplete-review wording ([cbb7e9b](https://github.com/this-is-tobi/quorum/commit/cbb7e9b5867a64eb4a7799cae0410ba2be059fd7))
* read a provider spec's own fields once, and compare endpoints without a trailing dot ([4836083](https://github.com/this-is-tobi/quorum/commit/48360836bfb60b972f085929105c899bc667e7a6))
* read each prompt file once, and cap them at 1 MiB in total ([60fdb9d](https://github.com/this-is-tobi/quorum/commit/60fdb9d82606e5cca0a27d2192cd52fab8cbfdc3))
* read only own fields where a provider's key, auth and endpoint are chosen ([d00429f](https://github.com/this-is-tobi/quorum/commit/d00429f2b0d4111cf84b2c2eb906e23547e27536))
* read only the first fifty listed findings and refuse an extra top-level key ([cbd2ac0](https://github.com/this-is-tobi/quorum/commit/cbd2ac04301e4b718520e83b12c53808e86a4c10))
* recognise a too-large refusal by its kind, and close three configuration gaps ([bb0012c](https://github.com/this-is-tobi/quorum/commit/bb0012cb6d05d5b900051a54e0880967be78efb8))
* redact a key that a server echoes with unicode escapes ([8ad3270](https://github.com/this-is-tobi/quorum/commit/8ad32704d43bf211729ab2aa6ee4a58bb811af12))
* redact an escaped echo in the same pass as the values it overlaps ([79854c9](https://github.com/this-is-tobi/quorum/commit/79854c992f01caa04c85ad687a53c20cc725a43d))
* redact at most 64 KiB of a quoted text, and keep a key out of the query ([b50f0d8](https://github.com/this-is-tobi/quorum/commit/b50f0d88f2f6eb66da36d8dce1ab8152430fd9e9))
* redact cloud and refresh credentials from claude errors, and read a cut reply as truncated ([617db63](https://github.com/this-is-tobi/quorum/commit/617db639deecbbdf2e10de39e5d486000c72f737))
* redact covered text once, and header values as fetch sends them ([8404b90](https://github.com/this-is-tobi/quorum/commit/8404b90b89970a22df06d3e50c1d00b7e6a264ad))
* redact every credential the claude child holds, and stop its whole process group ([020f732](https://github.com/this-is-tobi/quorum/commit/020f7320ee7879f4bfd51851125eb74be9fa1401))
* refuse a base URL without a host ([5e227f4](https://github.com/this-is-tobi/quorum/commit/5e227f4c92142839d5b595eb71fc0a655968d9f0))
* refuse a Gemini generationConfig that is no object ([f5a99d4](https://github.com/this-is-tobi/quorum/commit/f5a99d42f97d3fcaa9c6ece264e4e13a72d20cf6))
* refuse a model id that is not visible ascii, and a tool model at a preset's origin ([ccede48](https://github.com/this-is-tobi/quorum/commit/ccede48ee57697de99b893954e5df563aedfee8a))
* refuse a profile or lens id that is not a string ([1965eb7](https://github.com/this-is-tobi/quorum/commit/1965eb72361a4488978737509d66dfe593ff9622))
* refuse an extraBody that sets the reply limit, or an Ollama options that is no object ([deef177](https://github.com/this-is-tobi/quorum/commit/deef1779aa3f4577283ea4a18ccb97f36e31189d))
* refuse body fields that offer a model a tool, in any spelling ([c5f4d9a](https://github.com/this-is-tobi/quorum/commit/c5f4d9ac1c0c76dcbc20ed5b8d1e5c89c930e0dc))
* refuse redirects, oversized replies and credentials in a base url ([85eac67](https://github.com/this-is-tobi/quorum/commit/85eac676b30be8859064955027250fffc64b68a4))
* refuse text that reads like JSON syntax after the reply object ([a812fcb](https://github.com/this-is-tobi/quorum/commit/a812fcba1b7fa9fbbdc5b9d15d2b40902faad60e))
* report a kept finding whose failed vote could have raised it as incomplete ([2b37721](https://github.com/this-is-tobi/quorum/commit/2b37721c3215aa6c59058d1033cdc9cc95c5bc2a))
* report a malformed profile as configuration issues, not a type error ([f5e2588](https://github.com/this-is-tobi/quorum/commit/f5e2588c207cc0134930e22e005c5a770e987560))
* report a voter's unusable base URL before its missing model ([6e6ec82](https://github.com/this-is-tobi/quorum/commit/6e6ec821cdf224710bc90fcecd42981e5aef1227))
* report invalid policy rules as issues and never resolve a threshold of zero ([aa8c77b](https://github.com/this-is-tobi/quorum/commit/aa8c77b8a52edae4cfdf9f4e89a2e64098f4ee8d))
* report unreviewed findings and incomplete research instead of a clean result ([9f41c7f](https://github.com/this-is-tobi/quorum/commit/9f41c7fa1feb1b59fb2588f062934cb15dc98c06))
* send shift false, so ollama stops at a full context instead of dropping the prompt ([9e2e552](https://github.com/this-is-tobi/quorum/commit/9e2e5529f1b91665d407a00ac1dd37a428323c91))
* settle a claude call whose pipes outlive the child, and stop live claude groups on exit ([90c9da9](https://github.com/this-is-tobi/quorum/commit/90c9da95850028d768bfab8da7a59bf351545452))
* snapshot a code config's provider objects inside the guard that hides what they throw ([44d0ffc](https://github.com/this-is-tobi/quorum/commit/44d0ffccee3137363249b370fae7fae8b9455f44))
* snapshot a provider object inside the schema, so nothing reads it after the guard ([84f0298](https://github.com/this-is-tobi/quorum/commit/84f029822a1e1cc6ce771bb070fb7d124131b4ef))
* split diffs in linear time and locate findings in hunks ([975d4dd](https://github.com/this-is-tobi/quorum/commit/975d4ddd85f3b9e8512607d9e9bfd135a20c59e7))
* tighten the bare-wrapper span and report where trailing JSON syntax starts ([c2f5b61](https://github.com/this-is-tobi/quorum/commit/c2f5b619eb71f443738c4c4f4658aac29d035da9))
* validate model replies and fail closed on malformed research output ([343fac0](https://github.com/this-is-tobi/quorum/commit/343fac0cab2a9a642832a83548fb337018f8da75))


### Code Refactoring

* build every hidden-character check from one class ([0f0d205](https://github.com/this-is-tobi/quorum/commit/0f0d2052846a313d59b7c6e26697ec6231984d8d))
* hold the security review in a profile ([19c59d7](https://github.com/this-is-tobi/quorum/commit/19c59d7973b4fc43645f923ca193c989d395260d))
* keep only distinct labels while reading hidden characters ([182ece7](https://github.com/this-is-tobi/quorum/commit/182ece7aaf5c7f5ff6a19865f247a6ea9ddc666c))
* name the wiring's origin helper apart from the providers' one ([bc4542b](https://github.com/this-is-tobi/quorum/commit/bc4542bf1fca0add88e0de8bbb41ca2bb8cb945f))
* one name for the claude command variable, and one claude-code predicate ([2ab80de](https://github.com/this-is-tobi/quorum/commit/2ab80de5d2713df273ee0f9b1dd66b6ce1baa84b))
* one stub for both chat wires, and one test of a research preset or protocol ([6c3fcb7](https://github.com/this-is-tobi/quorum/commit/6c3fcb7fe92537a250a5997bc16108670cfb9bbe))
* run the cli and runQuorum through createQuorum ([6c325f7](https://github.com/this-is-tobi/quorum/commit/6c325f74214764129c5a0f35a77c4de2c9ae45af))
* run the pipeline on providers and delete the client ([68adc8e](https://github.com/this-is-tobi/quorum/commit/68adc8eb94bad65be877329666c9b19c16382509))
* share the setup of the http adapters, and lower-case their fixed headers once ([2099f62](https://github.com/this-is-tobi/quorum/commit/2099f623b1b7bef16a60487d35e081cc4e6df302))


### Dependencies

* hold the config layer to its globals, and name the node versions that strip types ([6a8916e](https://github.com/this-is-tobi/quorum/commit/6a8916e395b9aede8e2316b42c1ce9bbb267b86d))
