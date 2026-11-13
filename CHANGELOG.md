# Changelog

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
