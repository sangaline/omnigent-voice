# Voice Harness Autoresearch

This is the durable, sanitized research notebook for improving the fast voice
coordinator. Exact transcripts, session identifiers, tool results, and private
deployment data stay in the retained runtime audit log and never enter this
public repository.

## Safety boundary

- Never inspect, focus, message, archive, or otherwise interact with the
  explicitly excluded existing session.
- Live experiments use clearly titled disposable research sessions created for
  this purpose. Do not reuse unrelated user work.
- Mutating eval cases run only against those disposable sessions. Historical
  replay and synthetic coordinator transports are preferred for prompt search.
- Do not commit credentials, private output, personal paths, account or channel
  identifiers, raw transcripts, or deployment-specific values.
- A candidate may deploy only after conventional tests, the full regression
  corpus, and held-out cases pass without a safety regression.

## Method

Each iteration follows the same loop:

1. Observe a rough interaction or generate a realistic ASR-style flow.
2. State a falsifiable hypothesis about the harness, tool contract, or state.
3. Run the unchanged candidate harness over the complete regression corpus and
   separate held-out cases.
4. Score deterministic behavior directly: tool choice, target, arguments,
   delivery mode, focus mutation, and forbidden claims.
5. Judge final speech for grounding, reference resolution, honesty, brevity,
   and whether it answers the human's actual intent.
6. Promote every useful failure to a sanitized regression case before changing
   the harness.
7. Retain a change only when aggregate and safety-gate results improve without
   overfitting one wording.

ASR-style cases should resemble real spontaneous speech: run-on phrasing,
self-correction, filler, repeated words, missing punctuation, homophone-like
substitutions, and occasional dropped nouns. Clean paraphrases remain in the
corpus so robustness does not come at the expense of ordinary language.

## Scorecard

The primary gates are binary and weighted by consequence:

- Correct tool or direct speech decision.
- Correct session target without an unrequested focus change.
- Faithful action arguments; no invented or duplicated mutation.
- Grounded final answer from the supplied coordinator evidence.
- No false claim that an action happened or that monitoring will continue.
- Brief, natural speech that preserves required blockers or questions.

Latency, prompt tokens, completion tokens, and tool rounds are recorded as
secondary metrics. A faster wrong action never counts as an improvement.

## Research log

### 2026-08-28 — Baseline and measurement validity

Deployed baseline: `ab8a790`.

Observed baseline:

- 24 conventional tests pass.
- 17 retained-history first-decision cases pass after prompt tuning.
- 10 supplied-result tool-loop cases produce grounded final speech.
- The structured output contract is chronological within the most recent page;
  incremental output follows the same oldest-to-newest direction.

Validity threat: the replay command imports the production prompts and safety
filters but separately constructs tool definitions, coordinator context, model
requests, and tool rounds. Therefore it is a close simulation, not proof that
the exact production harness would behave identically.

Hypothesis H1: refactoring production and evaluation to use one request/tool
loop with injected model and coordinator transports will eliminate silent
contract drift and reveal at least one missing production-only behavior in the
current eval corpus.

Planned test: capture requests from production-mode and replay-mode invocations
for the same frozen state and assert byte-equivalent messages, visible tools,
model parameters, and tool-result serialization. Then rerun the baseline corpus
through that shared implementation before changing behavior.

Result: accepted. Replay now instantiates the production conversation class and
the production in-process MCP client. Only the coordinator executor is frozen;
prompt assembly, context contract, dynamic tool gating, schemas, result
serialization, model parameters, tool rounds, memory restoration, and failure
handling are shared production code. A conventional test drives restored
history through that complete path and captures both model rounds and the MCP
mutation. The suite now has 25 tests at this checkpoint.

The exact path revealed previously hidden drift: replay had encoded a proactive
update as one object, while production stores an array of events. It also
revealed that decision-only scores missed false success claims after a tool
returned an explicit error.

### 2026-08-28 — Tool-error truthfulness

Hypothesis H2: a stronger global prompt sentence is sufficient to make the fast
model distinguish current tool failure from older successful action history.

Test: replay eight historical ASR-style send and read turns with no supplied
tool result, causing a controlled coordinator error. The baseline and prompt
suffix each produced only one strictly truthful response out of eight; typical
failures claimed a send succeeded, treated a failed read as an empty result, or
promised a future retry. Reject the prompt-only change.

Revised hypothesis H2b: tool execution failure is a narrow runtime invariant,
not a semantic judgment. Deterministic per-tool failure speech should eliminate
false action claims and avoid an unnecessary second model request without
changing successful flows.

Result: accepted. All eight failure cases produced truthful, immediate failure
speech in one model round. Eight corresponding successful send flows still
acknowledged the confirmed target, and six supplied chronological read flows
grounded the answer in the latest message. Conventional tests are now 26, with
a regression asserting that the second model request is skipped on error.

### 2026-08-28 — Durable corpus and authoritative state

Hypothesis H3: a sanitized corpus with structured expectations can distinguish
general harness improvements from fixes that merely fit one retained phrase.

Result: accepted. The evaluator now runs the production conversation and MCP
loop over 24 public sanitized cases. It scores tool sequence, arguments, target,
speech requirements, rounds, latency, and tokens. Cases cover ASR corruption,
resend versus visibility, action-ledger truth, sticky focus, background
references, chronological output, delivery modes, archive restoration,
structured approval, context honesty, errors, and fresh output deltas. Repeated
trials expose stochastic behavior. HTTP rate-limit and transport failures are
invalid trials; unusable successful responses remain harness failures.

Two initial false negatives required exact words where faithful synonyms were
acceptable. After correcting those rubric bugs, the stable weaknesses were:
prior-send verification and fresh output-delta use each passed zero of five,
already-focused handling passed three of five, and honest correction passed
four of five.

Hypothesis H4: another global system-prompt sentence will make the model prefer
authoritative state over redundant reads.

Result: rejected. The global suffix did not change either zero-of-five state
failure. Removing read tools was also rejected because the model often returned
an empty completion when its preferred read capability disappeared.

Revised hypothesis H4b: keep read tools, put the evidence rule in the late
current-turn invariant, hide only provably redundant capabilities, and
explicitly distinguish a declarative missed-action complaint from a question
about visible output. The runtime already calls `check_updates`; conservative
focused-name matching can hide `focus_session` when that target is active.

Result: accepted. The four unstable flows each passed five of five targeted
trials. The missed-send and visibility boundary passed five of five on both
original cases. Three held-out paraphrases chose the correct tool in all fifteen
trials; one speech check was relaxed because all five correct answers confirmed
visibility without unnecessarily repeating the message body. The expanded full
run passed all 22 valid trials; the two late trials invalidated by HTTP 429 were
rerun individually and both passed, completing a 24-of-24 candidate result with
no untested cases. Conventional tests are now 29.

### 2026-08-28 — Delivery evidence and stateful multi-session flows

A disposable two-session live experiment confirmed immediate coordinator
acceptance in roughly 0.3 seconds, while a subsequent output read could still
show no corresponding user item. This exposed an evidence boundary: accepted
delivery and visible conversation output are different facts.

Hypothesis H5: a visibility answer should combine the authoritative action
ledger with the read result instead of treating absent output as failed
delivery or as the absence of an agent response.

The baseline passed zero of five accepted-but-not-yet-visible trials. A scoped
late invariant passed the original visibility and resend boundaries plus three
new held-out cases in all 25 targeted trials. The public isolated corpus now has
27 cases. This candidate was held rather than deployed because isolated turns
did not exercise working memory across concurrent sessions.

Hypothesis H6: one persistent production conversation and MCP connection will
expose reference, cursor, and action-selection failures hidden by isolated
cases. Four sanitized scenarios now cover 23 linked turns: an unrelated
completion while focus remains sticky; chronological output chunks arriving
between human utterances; an action request competing with fresh output;
back-to-back notifications from two sessions; explicit switching; temporary
side work; and deterministic focus restoration after archive.

Result so far: supported. The production invariant passed 21 of 23 turns and
only two of four complete scenarios on its first clean run. A notification
follow-up used the focused ID instead of the notified ID, and “what's new since
then” redundantly read older output instead of using the fresh delta. Repeated
baseline trials reproduced those two target-selection failures three of three
times; a separate run also interpreted the ASR repair “no wait” as queued
delivery. Thirteen of 69 repeated turns hit HTTP 429 and were treated as invalid,
not quality failures.

Candidate H6 makes notification records authoritative for reference resolution,
defines changed output as the chronological delta for “what's new” questions,
and limits queued delivery to explicit timing language. It also includes H5's
delivery-versus-visibility rule. The first clean candidate run passed all 23
stateful turns, and the unchanged isolated corpus passed 27 of 27. Repeated
stateful stability trials then passed 69 of 69 turns across three complete runs
of each scenario with no invalid trials. Two earlier candidate runs each had one
speech-quality miss: one omitted the pass result and one malformed the final
word “reconnect”; neither changed a tool, target, cursor, focus, or action.

Result: accepted. After promotion into the production invariant, the complete
scenario set passed 22 of 23 once before the clean stability sweep. The isolated
production run passed 26 of 27 because one queued-delivery acknowledgement
omitted the session name; that same case then passed five of five immediate
reruns. Together with the earlier 27-of-27 candidate run, all isolated cases
have clean confirmation without relaxing their action or grounding rubrics.

Deployment checkpoint: image `2026-08-28-91c0310` contains production runtime
JavaScript and pinned local speech models but excludes replay, evaluation,
scenario, test, and research artifacts. The local cluster rollout reached
speech-model, coordinator, and Discord-voice readiness in about 1.2 seconds,
reported zero restarts, and retained the existing private JSONL audit log.
Hermes remained inactive throughout the handoff of the shared Discord identity.

### 2026-08-28 — Structured decisions across human turns

Hypothesis H7: a decision event consumed inside a human turn loses the opaque
prompt metadata needed for approval on the next utterance because spoken
history retains only the natural response, not transient coordinator context.

Result: confirmed. A new three-turn background-decision scenario initially
failed all three turns. Celeris explained the decision, then invented both a
session ID and prompt ID when the human approved it, and finally attempted an
output read when asked whether approval succeeded. More prompt text cannot
make unavailable opaque identifiers reliable.

The coordinator now maintains `pending_decisions` as authoritative typed state
across all watched sessions. Exact prompt and session identifiers recur in every
snapshot and tool result until successful resolution, the decision event
contains the same prompt metadata, and resolution removes the prompt before
returning its action receipt. The late invariant requires copying these IDs and
uses `recent_actions` rather than output reads to verify prior approval.

The repaired flow passed all 15 turns across five complete runs. Conventional
tests increased to 31, including an end-to-end coordinator/MCP lifecycle test.
The unchanged isolated model corpus passed 27 of 27. Full linked sweeps retained
correct tools, targets, focus, and actions; one 26-turn run had a single
speech-only omission of the word “reconnect,” which passed three immediate
reruns and remains recorded as model-output variance.

### 2026-08-28 — Named routing, rename, and compound work

Hypothesis H8: repeating a bounded `known_sessions` map in coordinator results
and resolving an explicitly addressed destination in the voice harness can send
to background work without the unsafe intermediate focus change that caused the
original wrong-session incident.

The simple baseline listed sessions but did not send. Deterministic destination
resolution then passed five of five two-turn runs while retaining primary
focus. A harder request named both a source and destination. It initially passed
two of three because one trial sent before reading the source. A late invariant
requiring source grounding produced five of five clean runs. The grammar treats
the name directly governed by tell, ask, message, send-to, or let-know as the
destination; multiple direct destinations fail closed. A human-supplied finding
does not trigger a redundant source read.

Hypothesis H9: renaming should be a typed coordinator mutation whose state
transition is returned by the server, not a natural-language message to an
agent. The installed Omnigent `v0.11.0` contract exposes
`PATCH /v1/sessions/{session_id}` with an update request containing `title`.
`rename_session` now updates the focused snapshot, known-session map, pending
decision label, and recent-action ledger atomically without changing focus.
Three initial model runs all selected the correct tool and title; their only
failure was an evaluator that incorrectly required title-case JSON for a
lowercase ASR utterance. The corrected linked scenario passed both the rename
and next-turn authoritative-name checks. Conventional coverage is 36 tests.

Hypothesis H10: passing isolated primitives can conceal failures after focus,
notification subject, message destination, prompt owner, and conversational
referent diverge over a longer exchange. A thirteen-turn compound scenario now
combines a primary session, a background completion and exact read, two routed
sends, temporary session creation, a decision owned by the background primary
session, incremental temporary output, rename, another completion, archive
restoration, and a final compound status question.

The first run selected every correct tool and identifier but exposed an
over-strict approval synonym rubric and a real omission of the completion
outcome from the final compound answer. The rubric now accepts faithful
approval language, while the production invariant requires every requested
part and preserves a completion's outcome. The revised scenario passed 13 of
13 turns. A full nine-scenario sweep then passed 44 of 45 turn rubrics with all
tools, targets, focus transitions, and mutations correct; its sole miss was a
speech-only omission after a correct exact-output read. An immediate traced
compound rerun passed all 13 turns, recording the remaining issue as Celeris
speech variance rather than a state or action failure.

During the same promotion gate, adding named-routing instructions regressed two
declarative missed-send cases to zero of three by making `get_output` too
salient. Moving the general correction boundary to the end of the turn prompt
was insufficient at one of two trials. Clarifying the shared MCP tool
descriptions fixed both distinct retry phrasings at three of three each while
the neighboring combined sent-versus-visible question stayed three of three.
The full isolated corpus then passed 27 of 27. This remains prompt/tool-contract
behavior; no brittle classifier automatically executes a send.

### 2026-08-28 — Typed receipts and evidence-backed retry routing

Hypothesis H11: once a typed mutation succeeds, asking the fast model for a
second acknowledgement completion adds latency and reintroduces uncertainty
about fields already known exactly. A deterministic renderer can safely speak
single successful send, focus, start, rename, and archive receipts when the tool
result contains no concurrent update; composite turns still return to Celeris.

The queued-message regression passed three of three after this change in one
model round and 194–293 ms. In the final full gates, common action turns usually
completed in one round and roughly 103–206 ms. The previous two-round path was
typically 200–600 ms and had recurring speech-only omissions of target names or
result words. This is both a latency and correctness improvement.

The shared `get_output` description initially destabilized the boundary between
a missed-send correction, an action-occurrence question, and an output-
visibility question. Tool-description and final-turn prompt changes improved
targeted trials but a later full run still selected a read for the correction.
A first runtime guard that merely hid `get_output` was rejected: three of five
trials returned an empty model turn. The accepted guard uses prior assistant
speech plus the authoritative action ledger and a narrow declarative-correction
grammar to require `send_message` as Celeris's first tool choice. It does not
execute the tool itself. The model still reconstructs the message arguments,
and the coordinator still must return success. This passed five of five
targeted trials in one round; explicit inspection and ledger-backed visibility
cases remained separate.

A context-honesty trial also revealed a fabricated 44,000-character retention
threshold. The prompt now requires exact copying of configured thresholds or
omission, and the evaluator structurally rejects every spoken number outside the
actual 80-message and 48,000-character values rather than depending on one
refusal phrase. The corrected case passed three of three.

Final promotion result: 39 conventional tests, 27 of 27 isolated production-
harness model cases, and all 45 turns across nine persistent linked scenarios.
There were no invalid model-service trials. The linked suite includes the
thirteen-turn compound workflow as well as notification, cursor, decision,
named routing, rename, and focus-restoration regressions.

### 2026-08-29 — Proactive progress and compound action receipts

Hypothesis H12: newly persisted assistant output from a still-running monitored
session is useful enough to announce proactively, while raw tool and terminal
activity is too noisy. The coordinator now emits a replayable `session_output`
event only for a new assistant message. A lifecycle transition in the same poll
owns the accumulated output, preventing duplicate progress-plus-completion
announcements. A coordinator/MCP test proves that one assistant update is
published and replayed while a later tool-only item creates no unsolicited
event.

The initial model-facing scenario passed one of two complete runs because one
notification omitted the still-running soak test. Three diagnostic runs also
found one offer to “keep an eye on” the session, which the runtime cannot
promise. A notification-local contract now requires preserving both concrete
progress and remaining work, asks for input only on an actual decision, and
forbids offers of future monitoring. The revised persistent scenario passed all
ten turns across five runs, including a follow-up that repeated the update from
notification history without rereading Omnigent.

Hypothesis H13: one utterance can safely request more than one independent
coordinator mutation, but final speech should be derived from typed results
rather than another unconstrained acknowledgement completion. A send-then-
switch baseline selected both correct tools in one model round. Two of three
initial runs gave a complete final acknowledgement; a diagnostic five-run set
then passed, confirming intermittent speech variance rather than action drift.
When the send succeeded but focus failed, however, all three baseline runs hid
the successful send and reported only the switch failure.

The deterministic renderer now combines verified receipts when every action in
the model response succeeds, reducing successful send-plus-switch from two
model rounds to one. On partial failure it preserves verified completed-action
receipts before the deterministic error. Successful compound flow passed ten
of ten linked turns across five runs in 112–369 ms per action turn; the partial-
failure flow passed six of six linked turns across three runs in 127–390 ms per
action turn. Conventional coverage is now 42 tests. Full isolated and linked
promotion gates remain required before deployment.

Hypothesis H14: short stable output is already voice-sized, so explicitly
preserving each condition, count, outcome, and remaining-work clause will reduce
speech omissions without a second completion. Before this change, repeated
five- and eight-run probes intermittently dropped either “after reconnect” or
the release-test result. Natural inflections such as “passing” and “all passes”
were accepted as rubric corrections, while a response that said only “finished”
remained a real failure. The late short-delta contract then passed all 40 turns
across eight complete runs of the affected scenario.

A subsequent full linked sweep exposed one explicit switch turn that spoke
without calling `focus_session`. Eight exact replays selected the tool, but a
ten-run stress test produced one malformed opaque ID with a trailing brace.
The voice harness now resolves one explicitly named focus target through the
authoritative `known_sessions` map, removes the ID from the model-visible
schema, and injects the exact target. This mirrors named-message routing and
fails closed on unresolved ambiguity. Five sequential runs then passed all 35
turns of the focus-and-notification scenario. The compound evaluator also now
checks independent send and focus arguments without imposing call order; once
both IDs are injected, either order has the same verified final state.

The partial-failure follow-up uncovered a separate state-shaping problem. A
successful send appears in `recent_actions`, but a failed focus attempt does
not, leaving ordinary assistant speech as the only explicit failure record.
Raw completion tracing confirmed that Celeris sometimes returned a genuine
empty `stop` response and sometimes substituted an unnecessary output read.
Repeating a typed `last_verified_action_outcome` improved the flow from five of
ten to nine of ten runs. A narrow immediate follow-up asking only which part
happened and where the user is can now be rendered from that verified receipt
plus current focus, while visibility questions and new actions remain on the
model path. This passed all 20 turns across ten runs; the follow-up itself took
zero model rounds. The runner's optional `--json --include-trace` output records
sanitized raw completion shapes for future diagnosis. Full promotion gates are
still pending after these changes.

Hypothesis H15: asking Celeris to compare a delivery ledger entry with raw
conversation items is both slower and less reliable than returning the
comparison as typed MCP state. The isolated visibility gate regressed to zero
of five despite the sent user message being present, consistently describing
it as absent. Adding `recent_delivery_visibility` to `get_output` raised the
case to nine of ten, with the remaining model completion containing only the
word “thought.”

The coordinator now compares the latest recorded sent or queued message for the
target session with typed user messages on the returned page and reports
`visible_on_page` or `not_visible_on_page`. This is intentionally page-local and
does not infer whether an agent responded. Once Celeris selects the required
read, the voice harness renders that typed result directly rather than asking
for a second completion. Four positive and negative visibility cases passed all
20 targeted trials. Warm turns fell from roughly 270–365 ms over two model
rounds to 131–183 ms over one round. Full promotion gates remain pending.

Hypothesis H16: literal user task clauses and already voice-sized progress do
not benefit from paraphrasing by the fast model. In the full linked gate, one
`start_session` instruction changed “receipt wording” into “resend
acknowledgements,” and one short proactive update again omitted the still-
running soak clause despite the strengthened prompt.

For clear “start/make/create/open a session to/for …” requests, the harness now
injects the user's exact trailing task clause while Celeris still chooses the
tool, title, agent, and workspace. The thirteen-turn compound workflow then
passed all 65 turns across five runs. A single plain `session_output` update up
to 240 characters and three lines is now spoken directly with its session name;
URLs, code fences, long output, and multi-event batches still use Celeris. The
proactive scenario passed all 20 turns across ten runs, with the unsolicited
progress turn taking zero model rounds. Full promotion gates remain pending.

Final promotion result: typecheck and build clean, 46 of 46 conventional tests,
27 of 27 isolated production-harness cases, and all 51 turns across 12 linked
scenarios. There were no invalid model-service trials. One-round model turns in
the linked sweep were generally 105–237 ms, two-round reads were 222–356 ms,
and the short proactive update plus typed partial-failure verification required
zero model rounds. This candidate is accepted for deployment.

### 2026-08-29 — Native KAME turn priming and truthful playback evidence

Hypothesis H17: accepting an oracle update is sufficient evidence that the
native runtime spoke it. This was false. Two controlled probes queued guidance
after immediately supplied speech and produced no meaningful output: zero
frames crossed a 0.02 peak threshold, maximum peaks stayed near 0.0004, and
local ASR returned an empty transcript. This also explained an idle proactive
notification that was marked spoken even though no guided response followed.

The earlier successful fixture differed in one important way: it contained
5.19 seconds of idle audio before its 3.21-second caller segment. Replaying that
exact shape restored 34 active response frames with a 0.618 peak, and local ASR
recovered the injected sentence exactly. A second test used 50 idle frames and
a locally synthesized 1.57-second input-side question; it produced 37 active
frames with a 0.547 peak and the same exact ASR result. The hidden question is
never sent to Discord, so KAME remains the only audible voice.

The runtime now primes 64 discarded silent frames before connecting Discord.
For proactive events it feeds the hidden local question into KAME, injects the
verified coordinator update when that input drains, and advances the event
cursor only after output speech is followed by eight silent frames. Normal
human-turn guidance uses the same detector for exact playback-start and finish
logging without blocking the conversation loop. Unguided native text fragments
are retained only as counts outside a bounded post-guidance window. The code
gate is 52 conventional tests plus a clean typecheck and build; live Discord
and proactive-event verification remain required after image rollout.

The live rollout completed that verification. Startup model load was 1.57
seconds and 64-frame priming was 4.56 seconds. The first retained proactive
event generated its hidden 1.34-second trigger in 97 ms, began KAME speech 1.17
seconds after guidance, and completed after 10.72 seconds of audible output.
The isolated completion probe used a 1.40-second trigger, began speech after
1.82 seconds, and completed after 6.32 seconds. Its generated transcript kept
the full completion meaning. In steady state, rolling 125-frame means were
63.96-64.42 ms with p95 at or below 65.38 ms and no post-warmup deadline miss
above 71.92 ms. Both proactive events advanced only after speech completion.

The immutable public-image payload contains no credentials or deployment
metadata and is imported into the single-node k3s cache. Registry publication
remains external to this candidate: the existing Docker Hub credential can
push blobs but lacks repository-creation scope, and the requested public
repository does not yet exist. GitOps uses the exact node-local tag until that
one account-level setup action is completed.

### 2026-08-29 — Semantic endpointing runtime gate

Hypothesis H18: replacing fixed Discord silence plus transcript merging with a
short acoustic pause and raw-waveform completion classifier will remove most
of the post-speech dead time without clipping unfinished thoughts. The default
path now keeps one live ASR stream across pauses, uses Silero VAD at 180 ms,
and runs Smart Turn v3.2 over the latest eight seconds. A complete decision
commits immediately; an incomplete decision continues through a 700 ms hard
fallback. Speech arriving during inference invalidates the stale result.

The stock Transformers feature extractor measured about 90 ms mean and 116 ms
p95 end to end. Replacing it with Pipecat's NumPy-only batched feature path
reduced that to 36.4 ms mean and 46.1 ms p95 on the host. In the exact slim
container, twenty decisions measured 37.7 ms mean, 47.1 ms p95, and 47.7 ms
maximum. A complete public speech fixture scored 0.957, while a cut near the
middle scored 0.490. Silero detected and closed the same fixture correctly.
The packaged image is about 185 MB larger uncompressed than the prior image;
using isolated Python wheels avoided the roughly 517 MB Debian numerical stack
that an initial build pulled in. Live phone audio remains the promotion gate.

### 2026-08-29 — KAME notification retry and Pocket TTS gate

The first semantic-endpoint rollout exposed another useful negative result. A
proactive KAME update accepted 48 oracle tokens but generated no speech for 20
seconds. The event was correctly left unacknowledged, but the local queue had
already removed it. Proactive turns now use a five-second speech-start timeout
and a separate 30-second completion timeout, retry once with a fresh hidden
input, and requeue the event after two unconfirmed attempts. Only confirmed
KAME speech advances the cursor. This preserves one audible voice and prevents
silent event loss; another naturally occurring notification is still needed to
exercise the retry path live.

Pocket TTS 3.0.2 was benchmarked separately as a possible staged-runtime Piper
replacement using PyTorch 2.13 CPU and dynamic int8 quantization. Model load was
11.48 seconds and cached voice-state load was 657 ms. After warmup, first audio
arrived in 33-53 ms. A 0.88-0.96 second acknowledgement generated in 184-212 ms,
a 2.08-2.24 second receipt in 352-438 ms, and a 4.40-4.56 second update in
750-761 ms. This is fast enough to pursue for staged voice quality, but it is
not wired into KAME mode and must never become an audible per-turn fallback.

### 2026-08-29 — Notification-pronoun send routing

Hypothesis H19: the prompt's notification-reference rule was enough to route
“tell that one …” back to a just-announced background session. A held-out
three-turn scenario disproved it. Celeris correctly selected `send_message` and
preserved the dictated work, but the voice-safe schema deliberately omits
`session_id`; the production harness therefore would have defaulted the call to
sticky focus. The frozen result exposed the mismatch because the observed call
had no target ID. This is the same high-cost failure class as sending work into
an unrelated live coding session.

The harness now parses only the immediately preceding authoritative background
notification record, intersects its session IDs with the fresh `known_sessions`
snapshot, and deterministically injects the one unambiguous target for an
imperative pronoun follow-up. Focus does not change. A multi-session notification
batch fails closed instead of guessing. Notification records with an intervening
human turn are not used by this narrow guard; longer references remain the
model's responsibility and explicit session names still use the existing grammar.

Result: accepted. The new scenario passed all three turns in one model round per
spoken turn, routed the send to the background session, and retained primary
focus. The full stateful sweep passed every trial not rejected by the model
service: 11 of 11 valid scenario runs, with four HTTP 429 turns excluding their
two scenarios. Targeted reruns then passed the rate-limited two-turn named-send
scenario and all thirteen turns of the compound workday, and the one isolated
rate-limited case also passed. Conventional tests remain 54 with a clean
typecheck. The scenario runner now stops a scenario after an invalid transport
trial, avoiding meaningless downstream failures and unnecessary model calls.

### 2026-08-29 — Ordered notification sends and compound completion

Hypothesis H20: once singular “tell that one” was safe, Celeris could apply the
prompt's “first one” rule across two spoken notifications. The new four-turn
held-out scenario failed in the predicted way: it preserved the message and
selected `send_message`, but emitted no session ID. Without a harness target,
the production MCP call would have gone to sticky focus. The notification
resolver now retains the complete ordered burst since the last human turn and
deterministically maps first, second, third, and last. An unqualified pronoun in
a multi-session burst is ambiguous and fails closed. Focus remains unchanged.

The first global sweep caught an over-broad candidate: “tell it” with no recent
notification was treated as ambiguous instead of meaning sticky focus. That
candidate was rejected immediately. The resolver now activates only when the
current burst contains at least one authoritative notification target. Both the
six-turn focused-send regression and the new ordinal scenario then passed.

Hypothesis H21: a successful deterministic receipt was safe after any subset of
tool calls emitted for a compound turn. Repeated production-harness evaluation
disproved this: one run of “tell Side Beta … and switch me there” called only
`focus_session`, then would have spoken a focus-only receipt without sending the
message. The transaction loop now recognizes a positively requested named send
plus focus switch, accumulates typed results across rounds, and forces the one
missing tool before speech. Negated phrases such as “don't switch me” do not
activate the guard. A deterministic unit test reproduces the exact focus-only
first round and verifies the forced send plus both receipts.

Result: accepted. Five targeted live-model scenario runs passed all ten turns,
normally emitting both tools in one 139-347 ms model round. Conventional tests
are 55 with a clean typecheck. The final promotion sweep passed all 58 turns
across 14 linked scenarios with no invalid trials. One cross-session grounded
send needed three short model rounds in that sweep; all other ordinary action
turns remained one round, while typed proactive and partial-failure follow-ups
remained zero-round where expected.

Hypothesis H22: explicit switches to a session absent from `known_sessions`
could remain model-directed because the prompt required a lookup. A full
isolated sweep disproved this once: Celeris spoke without calling either tool.
Although five immediate reruns passed, one silent action miss is unacceptable.
The harness now forces `list_sessions`, resolves the requested name against the
typed result, injects its exact ID, and requires `focus_session` before speech.
Three targeted trials passed in two model rounds instead of the previous three.

The first broad version treated any positive word “focus” as navigation. The
linked sweep caught “tell it … focus on the Discord cutoff” and incorrectly
forced a session list instead of sending the task instruction. The guard is now
limited to explicit switch-me/switch-to and “focus me/the session” forms. Bare
task verbs such as “focus on the cutoff,” “open the log,” and “switch branches”
stay inside the relayed agent instruction. The existing six-turn
incremental-output scenario plus pure routing cases cover this distinction.
Grounded cross-session read-then-send returned to two rounds.

Hypothesis H23: Celeris adaptation was worth using for every lifecycle
notification. A short completion run dropped the concrete adjective “flaky”
from an otherwise accurate proactive announcement. Single plain completion
summaries now share the existing zero-model fast path for short progress: up to
240 characters and three lines, without URLs or code fences. Decisions,
multi-event batches, and complex content still use Celeris. Five targeted
notification scenarios passed all fifteen turns, with every completion taking
zero model rounds and retaining exact facts.

Final promotion evidence for this candidate is 56 conventional tests, a clean
typecheck, 27 of 27 isolated production-harness cases, and all 58 turns across
14 linked scenarios. There were no invalid trials in the final gates. Common
one-round action decisions measured roughly 93-175 ms in the final linked
sweep; grounded reads remained two rounds, and eligible proactive completions
were deterministic zero-round responses.

### 2026-08-29 — Serialized proactive KAME delivery

Hypothesis H24: the notification timer already serialized proactive KAME turns.
Sanitized live event timing disproved it. During retained-event replay, a new
hidden trigger and guidance pair could begin while the prior delivery was still
waiting, speaking, or entering its retry. In one burst two trigger-complete and
guidance events landed within milliseconds. The timer prevented duplicate
scheduled callbacks, but it was cleared before the asynchronous delivery began;
new updates and the S2S settle callback could therefore schedule another worker
during hidden-trigger synthesis.

The Discord runtime now owns an explicit notification-in-flight lock spanning
queue drain, Celeris adaptation, hidden input, guidance, speech detection,
retry, acknowledgement, and requeue. The scheduler refuses to arm while that
lock is held. New updates stay queued, and the single `finally` path releases
the lock and schedules the next batch. Start/finish events expose only counts
for live verification. A pure scheduling regression proves pending work does
not start while a timer or delivery is active. The conventional gate is now 57
tests with clean typecheck and build.

Result: accepted and deployed. Two isolated, no-change Omnigent probe sessions
created a real burst of three proactive KAME delivery transactions. Their
sanitized intervals were 19.269 seconds, 20.350 seconds, and 14.629 seconds.
The second transaction began 732 ms after the first finished; the third began
only after the second finished. No `delivery_started` interval overlapped a
prior interval, every transaction reached audible KAME playback, and all probe
sessions were archived afterward. This closes the live queue-contention rollout
gate without touching existing user work.

### 2026-08-29 — Typed multi-decision transactions

Hypothesis H25: the existing decision prompt plus `answer_prompt` schema was
enough for two simultaneous background prompts with opposite outcomes. A new
three-turn ASR-style scenario announced a cache restart and production deploy,
then asked to approve the first and decline the second in one utterance before
auditing whether both really happened. The baseline passed only one of five
complete runs. Celeris generally selected both correct opaque prompt/session
IDs, but its second synthesis round inconsistently omitted a target or outcome;
one trace later tried both already-resolved prompt IDs again. A completion also
returned the stray word “thought” after executing the correct tools. Correct
actions were therefore not enough to provide a trustworthy voice transaction.

The coordinator now returns a typed `target_session` after a successful prompt
resolution. The harness renders accept, decline, and cancel receipts directly,
including multiple calls in one model response, and stores that exact receipt
as the last verified action outcome. Immediate outcome audits repeat that
receipt and state that its outcomes are recorded, without offering stale prompt
tools to the model. Bounded structured decision notifications also bypass
paraphrasing: up to three plain events speak their exact prompt messages and
distinguish confirmation approval from form input. Concurrent updates still
disable every deterministic action receipt.

The first full sweep exposed an eval-fidelity bug: the frozen coordinator kept
putting events already consumed by `check_updates` into later tool results. It
now filters the authoritative envelope using the same per-MCP-connection cursor
as production. This reduced a normal prompt approval from two model rounds to
one. Two stochastic held-out misses then motivated narrow typed fast paths for
a safe short `output_delta` status question and a switch request targeting the
already-focused session. Both refuse concurrent events; the output path also
refuses pending decisions and action language. They reduced those turns from
one or two model rounds to zero without adding a model-side rule.

Result: accepted for deployment. The opposite-decision scenario moved from one
of five complete baseline passes to five of five targeted passes, followed by
three of three after the cursor and audit refinements. Its announcement and
verification are now zero-round; its two opposite actions require one Celeris
round, measured at 152-247 ms in the final targeted runs. The promotion gate is
61 conventional tests with clean typecheck, 27 of 27 isolated cases, and all 61
turns across 15 linked scenarios with no invalid trials. In the final linked
sweep, safe latest-output and already-focused turns also completed in zero
model rounds.

### 2026-08-29 — Deferred delivery as a typed lifecycle

Hypothesis H26: acknowledging `delivery: queued` was sufficient because the
later dispatch would be obvious from ordinary session events and the action
ledger. Code inspection disproved the event half: the coordinator sent a
deferred message when the session became idle and recorded `message_sent`, but
never pushed an update. A new four-turn background-session scenario then queued
a reconnect rerun, delivered the prior-turn result plus a synthetic dispatch,
audited delivery and sticky focus, and read the resumed work. The baseline was
zero of five complete runs. Every notification paraphrase omitted both “queued”
and “sent,” so the user heard only the old turn's completion. One of five named
reads also emitted the malformed opaque ID `session-side}`.

The coordinator now emits `message_delivered` only after the deferred backend
send succeeds. Its summary excludes message contents while the private action
ledger retains the exact text. A common one-event dispatch or same-session
completion-plus-dispatch batch renders directly from typed data; it preserves a
short prior result and explicitly says the queued message was sent. The audit
path uses the newest `message_sent` action with `delivery: queued_after_turn`
and current focus, without a model call. Failures reinsert the queue item and do
not emit success.

The voice harness also gained deterministic named-read routing. When a
read-shaped utterance contains exactly one known session name, `get_output` and
`poll_output` hide `session_id` from Celeris and receive the server-owned target
at execution. This mirrors named send/focus safety without changing sticky
focus; multi-session comparisons remain model-directed rather than being
collapsed onto one target.

Result: accepted for deployment. The new lifecycle moved from zero of five to
five of five targeted runs across 20 turns. The dispatch announcement and audit
are now zero-round, while the named read remained two rounds at 220-419 ms and
was correctly targeted in every run. The promotion gate is 63 conventional
tests with clean typecheck, 27 of 27 isolated cases, and all 65 turns across 16
linked scenarios with no invalid trials.

### 2026-08-29 — Mixed lifecycle events and current-action memory

Hypothesis H27: individually safe delivery, decision, read, and action-receipt
paths would compose when several sessions changed at once. A new four-turn
held-out scenario used ASR-style language to queue work for a background
session, delivered that queue beside an unrelated approval prompt, approved the
prompt while reading the resumed work, and immediately audited the approval and
sticky focus. The unchanged production harness completed zero of five runs
across 20 turns. `queue` was absent from named message-action grammar, so all
five tool calls omitted the background session ID and would have defaulted to
focus against the real coordinator. Model-adapted mixed notifications
occasionally omitted the typed send fact. Most importantly, the compound
approval-plus-read did not replace `last_verified_action_outcome`; all five
zero-round audits confidently repeated the older queue acknowledgement as if it
were the action just audited.

The harness now treats `queue` as named message language, including deictic
notification forms, and still injects the server-owned target outside the model.
A safe same-session completion and queued dispatch may be combined with a
bounded unrelated decision in one deterministic notification. A successful
typed action plus one safe short assistant `latest_message` is also composed
directly, while the action-only receipt becomes authoritative memory for the
next audit. If output is long, unsafe, non-assistant, or accompanied by unread
updates, the existing model path remains in control. Descriptor-bearing audit
phrases such as “did that migration approval go through” now resolve against
the current typed receipt.

Result: accepted as a candidate. The held-out scenario moved from zero of five
to five of five runs. Mixed notifications and immediate audits moved from one
model round or a wrong zero-round answer to correct zero-round speech. The
approval-plus-read turn fell from two rounds at 327-356 ms to one round at
131-205 ms in the final repeated run. The named queue target was injected in
every run. The conventional suite is 65 tests and the isolated corpus remains
27 of 27. Two preliminary full sweeps each had one isolated Celeris message
paraphrase omit the literal word “rerun,” while preserving the other requested
test and log terms. Those flows then passed five of five and ten of ten targeted
runs respectively. The final promotion sweep passed all 69 turns across 17
linked scenarios with no invalid trials. Keep treating exact outbound content
as a held-out fidelity dimension despite the clean final gate.

### 2026-08-29 — Live KAME audio containment and guidance alignment

Hypothesis H28: the native KAME control that passed paced synthetic audio was
safe to expose continuously in Discord. The first phone test falsified it.
Three human turns reached local ASR, but the Discord player forwarded every
native frame from process startup, including unguided model output. Four turns
hit 20-30 second completion timeouts, seven playbacks were interrupted, and 52
input-backlog warnings occurred. The user heard continuous multilingual-like
gibberish. The pod and GitOps replica were taken to zero before further work.

The audio path now has a generation-scoped fail-closed gate. Idle, stale,
aborted, timed-out, and post-completion frames cannot reach Discord. A fixed
12-second circuit breaker was tested and rejected because it clipped legitimate
long responses. Normal endpointing remains trailing acoustic silence; the
watchdog now scales from 10 to 120 seconds with guidance length.

Code inspection of official KAME showed the missing alignment mechanism: its
reference server starts overlapping oracle LLM streams from interim ASR every
roughly 500 ms. Our verified coordinator cannot safely speculate about tool
actions, so the harness instead delays only KAME input while local ASR remains
live. At 400 ms, an offline turn escaped before guidance. At 560-720 ms,
multi-turn runs consistently produced intelligible guided English. Two
conservative 720 ms / 400 ms-guidance sequences passed all seven turns with
77.8-100% independent ASR word recall. A 28-word response ran 12.8 seconds,
ended naturally, and scored 96.4%. The live rollout gate is now explicit:
offline silence containment, English fidelity, multi-turn termination, then a
controlled phone test; synthetic probes alone do not promote KAME.

### 2026-08-29 — Discord response-scoped raw audio resources

Hypothesis H29: the live caller's silence after a correctly generated response
was a transport-lifetime failure rather than an ASR or Celeris latency failure.
Private retained metadata confirmed a 1.58-second utterance, a Celeris response
791 ms after ASR finalization, and an initial KAME speech-start timeout with a
0.0004 peak. The same process had 194 later raw-stream writes rejected with a
zero-byte writable queue. Inspection of `@discordjs/voice` showed that a
playing resource is stopped and destroyed after its default five consecutive
missing 20 ms frames. Closing the generation gate after the preceding response
therefore killed the process-lifetime raw resource before the next turn.

The output resource now has the same lifetime as one guided transaction. It is
created in the buffering state before oracle guidance, receives only verified
open-gate frames, and ends on completion, timeout, abort, barge-in, or shutdown.
This preserves complete idle containment without clocking Discord with KAME's
unguided audio or synthetic keepalive frames. The conventional gate is a clean
typecheck plus 69 tests. Promotion additionally requires a live start, more
than one minute idle, then a guided response with no backpressure events. The
KAME no-speech timeout remains a distinct model reliability failure and is not
considered fixed by this transport change.

### 2026-08-29 — Pocket staged-runtime promotion

Hypothesis H30: the reliable staged pipeline can regain a natural voice without
giving up Piper's first-audio latency or buffering a complete reply. Pocket TTS
3.0.2 now runs as one persistent, CPU-only int8 process inside the existing
container. A newline-framed stdio bridge streams each 24 kHz float chunk to the
Node Discord path as it is generated. The public model and `alba` voice state are
cached at image build time without authentication; runtime network access is
disabled for the model cache.

The exact final-image path produced first audio in 34-39 ms. One 3.28-second
reply generated in 437-448 ms across 41 chunks. Three 3.28-4.08 second
intelligibility probes generated in 0.51-0.68 seconds and the bundled Nemotron
recognizer recovered all content except two minor article/word-form omissions.
The Celeris OpenAI-compatible endpoint also accepted `stream: true`, but a
32-token probe delivered headers at 308 ms and the entire two-chunk event stream
by 310 ms. Its current short completions leave essentially no text-generation
overlap to exploit; the measured audio-generation and ASR paths are genuinely
streaming.

Hypothesis H31: stopping Discord playback alone is sufficient barge-in. This was
false for a long Pocket reply because generation would continue serially and
delay the next request even though its audio was discarded. The bridge now reads
cancel commands concurrently with inference and stops between generated frames.
A deterministic integration test cancels a 100-chunk reply after its first chunk
and immediately completes the following generation. In the exact container a
real long reply produced its first chunk at 39 ms, acknowledged cancellation at
51 ms with only 80 ms of audio rendered, and began the next reply 49 ms later.
The conventional gate is a clean typecheck and 72 tests.

KAME remains offline. Retained live metadata showed 17 guidance attempts in the
failed phone-test interval, 11 speech starts, 11 timeouts, and 6 interruptions.
Multiple 27-30 second retries and one response producing over 1,400 transcript
characters confirm that the caller's more-than-one-minute gibberish report was a
model/runtime termination failure, not merely a Discord stream-lifetime bug.
Only the staged Pocket path is eligible for the next live test.

### 2026-08-29 — Deterministic notification-read targets

Hypothesis H32: the prompt rule requiring a follow-up read to copy the session
ID from notification history was sufficient. A full linked-scenario sweep
falsified it. After Side Audit was spoken proactively, the ASR-style question
“what's the last thing that one actually said” called `get_output` with sticky
Voice Build in one run. The other 71 turns passed, making this exactly the kind
of low-frequency, high-cost routing failure the stateful corpus is intended to
find.

The harness now resolves read-shaped deictic references from the same
authoritative, since-last-human notification records already used for message
routing. With one target, the model-visible read schema omits `session_id` and
the server injects the recorded target even if Celeris emits a different ID.
First, second, third, and last map to notification order. An unqualified read
after multiple notifications is answered by a deterministic zero-round
clarification naming the candidates; withholding tools alone was rejected after
five of five trials returned empty model turns.

This loop also added the first structured-form coverage. A standalone prompt
preserved `environment: staging` and `replicas: 3` in three of three baseline
runs. A longer three-turn scenario interleaved that form with a research-session
completion, submitted the form, sent the supplied DNS finding to sticky focus,
and audited both actions. The original judge scored it zero of three because it
incorrectly required an ID on a focused send and a verbatim session title; trace
inspection showed correct one-round actions, so the over-specific expectations
were fixed rather than changing production behavior. The corrected scenario
passed five of five runs across 15 turns.

Result: accepted for deployment. The wrong-session scenario passed five of five
targeted runs across 35 turns. The ambiguity case passed five of five in zero
model rounds. The final gates are 74 conventional tests with clean typecheck,
29 of 29 isolated cases, and all 72 turns across 18 linked scenarios with no
invalid trials. On the live staged pod, two naturally occurring long proactive
updates measured 800-882 ms for Celeris, 53-55 ms to first Pocket audio, and
continuous 10.08-11.60 second playback without underruns.

### 2026-08-29 — Multi-source grounding and verified tool provenance

Hypothesis H33: the one-source grounded-relay contract would generalize to a
spoken request that reads two background sessions, compares their latest
results, and sends the recommendation to sticky focus. Two held-out linked
scenarios reverse source order and which result wins, then ask whether both
sources were really read before the send and what exact message was delivered.
The first unchanged baseline completed zero of five scenarios. One literal
“WebSocket” requirement was evaluator overreach because the sent message named
Socket Probe and preserved the complete result; that rubric was corrected
rather than changing production. The remaining failures were real: an exact
message audit sometimes read unrelated session output, and read-before-send
claims depended only on lossy spoken history.

Each tool-using turn now carries a process-local `last_verified_tool_workflow`
containing the ordered successful named reads and typed actions, without opaque
IDs. The action ledger remains authoritative for exact outbound content. A
prompt-only exact-message reminder passed ten of ten trials but did not make the
workflow audit stable, while the typed workflow moved the first scenario to ten
of ten repeated runs. The reversed held-out scenario then exposed a higher-cost
failure: Celeris occasionally emitted both reads and `send_message` in one
completion, so the send could not have used results that had not returned yet.
The harness now declines that premature call without touching the coordinator,
injects the read results, and forces the grounded send on the next round.

Multi-source comparisons also occasionally named only the winner and discarded
the losing source's count and failure cause. The harness now withholds a
comparison until its message names every successfully read source, returning
the missing names as typed retry feedback. This guard is limited to explicit
comparison/recommendation language; unrelated reads in a compound turn do not
silently become outbound content. The reversed scenario passed twenty of twenty
runs across 60 turns after this guard, and the original passed another ten of
ten across 30 turns. Both still use two normal model rounds—reads, then send—and
sticky focus never changes.

### 2026-08-29 — Typed read rendering and dictated-send fidelity

Hypothesis H34: the remaining low-frequency speech misses were model variance
rather than missing typed fast paths. Repeated full gates falsified this twice.
One of three runs of `verify_recent_never_send` ignored a returned typed user
message and instead discussed older delivery visibility. An explicit “message
from me” read now speaks a safe `role: user` latest message directly after tool
selection. It passed ten of ten trials and removes the second model round.
Likewise, a plain non-mutating latest/status/progress read may speak one safe
short assistant latest message directly; action-bearing turns cannot take this
path. The queued-delivery scenario's final progress read then retained both
“reconnect” and “packet logs” in ten of ten targeted runs.

The same queued scenario still corrupted its initial human-supplied instruction
in one of ten runs, and a stronger prompt produced the malformed verb “rer” in
two of twenty. Prompt-only fidelity was rejected. For conservative explicit
forms such as “queue it a message to …” and “tell Side Worker to …”, the harness
now copies the dictated task clause into `send_message` when no output read
participated. Separate voice controls such as “then switch me there” and “don't
switch me” are removed from the agent instruction. Evidence-dependent sends are
never overwritten. The exact queued lifecycle then passed twenty of twenty runs
across 80 turns. A safe completion plus one bounded structured-decision batch
is now spoken directly too; this preserved the reconnect/DNS completion and the
exact form question in ten of ten announcements with zero model rounds. The
compound audit phrase “did both of those really happen” also joins “actually”
on the typed receipt path instead of risking a lossy model paraphrase.
Result: accepted as a deployment candidate. Conventional coverage is 79 tests
with clean typecheck and build, and the isolated corpus passed 29 of 29 with no
invalid trials. The final linked sweep passed all 18 valid scenarios; two more
were invalidated only by HTTP 429 and then each passed three of three individual
replays across 21 turns. The mixed form/completion flow separately passed five
of five after its zero-round paths were added. Every one of the 20 linked
scenarios therefore has clean post-change evidence without counting transport
failures as quality results.

### 2026-08-29 — Explicit multi-destination dispatch

Hypothesis H35: the existing fail-closed multi-name routing was sufficient for
compound voice work. A new ASR-style scenario asked for different instructions
to Build Worker and Docs Worker without changing sticky focus. The unchanged
harness completed zero of five scenarios: four model completions contained both
semantically correct calls, but the safety layer rejected both because it could
not bind each call to an authoritative destination; one completion omitted a
destination. This is a harness contract gap rather than a prompt-quality gap.

For a turn that contains one clear tell, ask, message, steer, or queue clause per
known destination, the voice-facing `send_message` schema now exposes only those
session names as a required enum. The model never sees an opaque ID. The harness
resolves the selected name against server-owned state, rejects unknown names,
deduplicates a repeated destination, and forces another tool round if any
requested destination was omitted. Multi-name turns without a separate action
clause for each target remain ambiguous and make no coordinator mutation.

The first scenario passed ten of ten repeated runs. A held-out mixed-delivery
case initially completed zero of five because normalized ASR grammar removed an
article before “message to”; widening that exact grammar moved it to four of
five. The remaining failure was evaluator order bias: the model correctly sent
both messages in reverse order, while the frozen coordinator assigned FIFO
results and the judge matched two same-name calls by position. Frozen results
and unordered call expectations now bind by `session_id`. Both scenarios then
passed ten of ten runs, including the immediate-versus-queued distinction and a
typed follow-up audit with unchanged sticky focus.

### 2026-08-29 — Staged text-to-speech overlap audit

Hypothesis H36: the staged path still buffered caller audio or the complete TTS
waveform. Inspection falsified both possibilities. Every Discord Opus packet is
already decoded into the same live Nemotron stream while the caller speaks;
end-of-turn only adds transducer right-context padding and drains final tokens.
Pocket already emits 80 ms audio chunks directly into Discord. The remaining
batch boundary was the Celeris JSON completion: Pocket did not start until the
full assistant text had returned.

Non-forced production rounds now request OpenAI-compatible SSE, assemble
fragmented content and tool calls, and feed natural speech segments into one
continuous cancellable Pocket/Discord stream. A tool-bearing round never speaks
its argument fragments. Named tool forcing remains non-streaming because the
service rejects forced tools on a streaming request. Startup also issues the
documented best-effort authenticated `/echo` call, which consumes no inference
quota and warms DNS, TLS, and the HTTP connection before the first voice turn.

The expected token-level gain was not available from this model. Celeris-1 is a
diffusion model whose [latency contract](https://docs.celeris.ai/cookbook/latency)
says the whole reply normally arrives in one burst. A production-shaped live
probe confirmed it: a 279-character, three-sentence answer emitted its first
speech segment at 474 ms and completed at 475 ms; all three segments arrived in
the same millisecond. The correct low-latency behavior is therefore to start
Pocket immediately on that burst, not invent progressive delays. If the API
later produces granular deltas, the same queue will overlap later text with
first-sentence synthesis without another architecture change.

Result: accepted as a deployment candidate. The conventional gate is a clean
typecheck and 85 tests. The isolated harness corpus passed all 29 cases; two HTTP
429 trials were excluded and passed on immediate individual reruns. The full
stateful gate passed 22 of 22 scenarios and all 82 linked turns, while both new
multi-destination scenarios also passed ten of ten stability runs separately.
