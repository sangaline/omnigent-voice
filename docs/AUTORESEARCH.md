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

### 2026-08-29 — Live tail-stream latency and relay provenance

Hypothesis H37: the remaining roughly one-second response floor came from
Celeris or Pocket. Live phone evidence falsified it. Clean Celeris completions
took 178-440 ms and Pocket produced first audio in 35-57 ms. Clean end-of-ASR to
playback measurements were 365-590 ms. On several slower turns Discord opened a
second receive stream containing 140-200 ms of zero-amplitude audio immediately
after the real stream closed. Because the receive event entered the active
recording set and cleared the transcript timer before any decoded voice existed,
the bot waited the full hard fallback. That added 710-770 ms before the Celeris
request even began.

Receive streams are now provisional. Only a decoded packet above the existing
minimum accepted recording peak activates the recording lease or clears a
pending transcript timer. Independent leases also make overlapping confirmed
streams count correctly. Three focused unit tests prove that an empty stream
never blocks, confirmation is idempotent, and overlapping closes do not release
one another. The next live phone turn is the required end-to-end confirmation;
the code-level gate cannot manufacture Discord's exact duplicate event pattern.

Hypothesis H38: the live attribution and retry failures were isolated wording
mistakes. Production-harness replay disproved that. When the human explained
that an outbound “I misunderstood” would be attributed to them rather than the
voice layer, the unchanged prompt promised a corrective send without a tool in
five of five isolated trials. A linked flow also wrote the next correction as
ambiguous first person. The destination receives `send_message` as a user-role
item, so the current-turn contract and tool schema now require explicit “voice
coordinator” attribution for self-reports. An understanding check must explain
the distinction without volunteering an action. This moved the isolated case
to 15 of 15 and the three-turn attribution flow to 10 of 10 runs.

The same live exchange exposed a second state error: after two failed attempts
to read a partially named session, “try again” resurrected an older unrelated
send. A prompt-only retry rule moved the model from the wrong send immediately
to the correct read followed by a wrong send, passing only two of ten trials.
The accepted harness change identifies a narrow retry after a generic
coordinator failure, resolves a unique session name from the contiguous failed
read dialogue, injects its server-owned ID, and withholds `send_message` for
that turn. A short session-name clarification uses the same state. Failed send
retries remain untouched. The generic retry then passed 10 of 10 trials, and a
linked failed-read/clarification/focus flow passed in the full scenario gate.

Result: accepted for deployment. No live Omnigent session was read or mutated
during this research; every new coordinator interaction used the frozen
production MCP harness. Typecheck, build, and all 88 unit tests pass. The full
isolated sweep passed all 31 valid trials; one retry trial was invalidated only
by HTTP 429 and has separate 10-of-10 stability evidence. The stateful sweep
passed 24 of 24 scenarios and all 88 linked turns, including both new flows.

### 2026-08-29 — Production-shaped notifications and listener presence

Hypothesis H39: the deployed zero-round completion path was operating as the
stateful fixtures claimed. Live post-rollout logs disproved it. Six consecutive
proactive completions, with no recognized human turn between them, all invoked
Celeris for 679–885 ms and then occupied roughly 9–17 seconds of audio. Several
paraphrases corrupted source terms, including “wayOps,” “thisProgramming,” and
“way Work.” The fixture supplied a convenient `summary` field that the real
coordinator never emits; production `session_completed` events carry the stable
assistant text only in `output_delta`.

The direct renderer now consumes that actual event shape. Safe short output is
spoken exactly, and longer plain output is split into source clauses and ranked
for outcome, validation, safety, and blocker evidence. The selected clauses are
reassembled without changing a word under a 24-word budget; unchanged-focus
clauses are excluded. A realistic long deployment update started at zero of ten
under the old prompt-only path, with 27–30 spoken words and repeated factual
omissions. A stricter prompt improved length but remained only five of ten and
still garbled names. The accepted extractive path passed ten of ten in zero
model rounds, as did the separate real-event-shape regression.

The Discord scheduler also previously treated the bot's connection as enough
audience and marked updates spoken even when no trusted human was in the voice
channel. Scheduling and the final delivery check now require a non-bot channel
member, narrowed to `ALLOWED_DISCORD_USER_ID` when configured. A voice-state
join schedules waiting work. This preserves the cursor and conversation history
until somebody can actually hear the update; a pure scheduling regression
covers the absent-audience case.

### 2026-08-29 — Exact voice repeat control

Hypothesis H40: Celeris was reliable enough for “repeat that last bit.” One of
the broad linked sweeps disproved it by replying without either “fixed” or
“pass,” even though both facts were in the immediately preceding spoken update.
The harness now recognizes only narrow repeat-the-last-speech forms and replays
the prior assistant text byte-for-byte in zero model rounds. Audit language such
as “repeat what was actually sent” is intentionally excluded so the ledger,
not conversational memory, remains authoritative. The linked six-turn flow
passed ten of ten runs after the change, including ten exact zero-round repeats.

Promotion evidence is 91 passing unit tests, clean typecheck and build, 27 of
27 valid isolated trials, and 26 of 26 stateful scenarios across 90 linked
turns. Five isolated HTTP 429 trials were invalid rather than scored; every one
passed on its immediate single-case rerun. Two earlier broad linked sweeps had
different low-frequency model misses, and each affected scenario passed five
of five targeted reruns before the final clean 26-of-26 sweep. All coordinator
calls in these additions used the frozen production MCP executor; no live user
session, including the excluded ESPN session, was read or mutated.

### 2026-08-29 — Exact multi-source relay evidence

Hypothesis H41: prompt instructions alone could reliably read three concurrent
session results, preserve every requested metric and cause, relay the actual
launch blocker to sticky focus, and then quote the outbound message exactly. A
new ASR-style two-turn scenario reads Audio Sweep, Network Sweep, and Memory
Sweep before sending to Release Work without changing focus. The first draft
incorrectly required a latency value after asking only for “exact counts”; that
zero-of-ten result was an evaluator defect and was discarded. After the human
request was corrected to ask for all exact numbers and causes, the unchanged
harness passed nine of ten. It once omitted the passing source's 74 millisecond
p95 result.

An explicit prompt rule initially produced twenty of twenty passes, but a later
nineteen-valid-run sample still omitted both 58 and 74 once. Prompt-only
fidelity was therefore rejected. For this narrow explicit request, the harness
now extracts numeric tokens and number words through twenty from every
successful `get_output` or `poll_output` source and compares them with Celeris's
proposed outbound message. If a number is absent, the send is not executed; a
typed result names the missing facts and forces one corrected `send_message`
round without repeating the reads. The guard does not compose or deliver a
message itself. A production-path test proves that an attempted relay omitting
both 74 and the metric label's p95 is withheld, and that only the corrected
message reaches the frozen coordinator.

The first numeric-only post-guard gate passed thirty of thirty, but a stronger
cause-aware judge showed that this was not enough. Exact keyword requirements
initially produced false negatives for legitimate variants such as “blocking
the launch,” so the evaluator gained explicit semantic-alternative groups.
Traces then exposed genuine source corruption: Celeris sometimes changed “two
reconnects timed out” to “interconnects timing out,” dropped reconnects, or used
the ambiguous phrase “timed reconnects.” An explicit all/exact-causes request
now activates a second bounded comparison over stable lexical source evidence.
Missing or corrupted evidence defers the send and asks Celeris to copy the
missing source phrase verbatim. Valid morphology remains accepted, while the
observed corruptions are not.

The final cause-aware three-source gate passed twenty of twenty valid runs; four
runs used one corrective model round and sixteen were accepted immediately. Its
next “read back what you actually sent and where am I still” audit always used
zero model rounds. Before the direct audit path, Celeris preserved the exact
ledger message in eighteen of twenty runs. The harness now quotes the newest
typed `message_sent` or `message_queued` entry directly and appends typed focus
when requested; output visibility language remains excluded. The two older
comparison-order scenarios each passed five of five targeted runs. A separate
attribution scenario had one strict term failure in an untraced five-run sample,
followed by ten of ten traced passes; it was retained unchanged rather than
assigning an unsupported cause or adding an unrelated guard.

Result: accepted as a deployment candidate. Typecheck, build, and all 93 unit
tests pass. The isolated corpus passed 32 of 32 valid trials with no transport
invalidations. One broad linked run had an unrelated start-instruction term
miss; that scenario then passed five of five targeted runs and the complete
linked rerun passed all 27 scenarios and all 92 turns. Every coordinator
interaction in this experiment used the frozen exact production MCP path; no
live Omnigent session, including the excluded ESPN session, was read or mutated.

### 2026-08-29 — Voice-owned incremental output cursors

Hypothesis H42: telling Celeris that `poll_output` accepts a cursor was enough
for a spoken follow-up such as “anything newer from that one since that update.”
A new three-turn background-session scenario disproved this. After a direct
Side Audit notification, the unchanged production harness selected
`get_output` for both follow-ups in five of five runs. It had no durable cursor
available to the model and therefore replayed a page instead of continuing the
chronological stream. The baseline was zero of five scenarios.

The voice harness now owns this mechanical state. It records a notification's
opaque per-session cursor only after that notification is actually spoken and
acknowledged. Explicit incremental language resolves the authoritative session
from notification history or known names, forces `poll_output`, removes the
session ID and prior cursor from the model-visible schema, and injects both at
execution. A successful poll advances its stored cursor only after the turn has
a spoken response. Short safe changed output and the unchanged result are
rendered directly from typed fields, eliminating a second model round. Cursor
expiry, concurrent events, long text, URLs, and code still fall back to Celeris.
The standalone MCP contract is unchanged: stateless clients pass and retain
their explicit cursor themselves.

The linked target passed ten of ten runs and all 30 turns. Its twenty user
polls each used exactly one Celeris round, advanced `item-18` to `item-20`, kept
Release Work focused, and then reported no newer stable output from `item-20`.
Median model/tool latency across those polls was about 133 ms; the range was
106–368 ms, with direct notifications remaining zero-round. Notification-send
and action-priority neighbor scenarios each passed five of five. A separate
notification-reference sample first had one low-frequency wording omission,
then passed ten of ten unchanged on a traced rerun.

One isolated broad run correctly said it could not “poll periodically,” but a
bare forbidden-word assertion scored the negative statement as a failure. The
rubric now rejects positive fake-monitoring claims rather than the word itself;
the unchanged behavior passed ten of ten. Final promotion evidence is 95 unit
tests, clean typecheck and build, 32 of 32 isolated trials, and all 28 stateful
scenarios across 95 linked turns. All coordinator interactions remained frozen;
no live Omnigent session, including the excluded ESPN session, was read or
mutated.

### 2026-08-29 — Human-turn event continuity

Hypothesis H43: events returned by the atomic `check_updates` call at speech
finalization remained usable on the next spoken turn just like proactively
announced events. A held-out two-turn flow disproved this. The human asked what
had arrived while they were talking; Side Audit's typed `session_output` and
`item-24` cursor were present in the turn context. Four of five runs spoke the
event, but every next “anything newer from that one” used `get_output` and lost
chronological continuity. One run unnecessarily called `get_output` on the
first turn too. The unchanged harness passed zero of five scenarios.

Every successful human turn now retains typed events from both its initial
`check_updates` result and later coordinator tool results. Events are
deduplicated by event ID, recorded after the human message as authoritative
notification history, and their per-session output cursor is committed with the
spoken response. A failed or superseded turn commits neither. For the narrow
question “what just came in?”, one safe short event uses the existing exact
zero-round renderer instead of asking Celeris to rediscover data already in
context. Compound turns remain model-composed.

The target moved to ten of ten runs. The arriving event took zero model rounds,
and each follow-up forced one `poll_output` from `item-24` with 85–341 ms model
and tool latency. Production-path tests separately prove the same retention
when a concurrent event first appears inside an action tool result. The prior
proactive-cursor flow stayed five of five, the incremental/action-priority flow
stayed five of five, and the existing decision-during-human flow passed five of
five on a sequential rerun. Parallel test invocations had produced four HTTP
429 invalidations; no quality result was inferred from them, and subsequent
model gates remained sequential.

### 2026-08-29 — Deterministic multi-destination delivery timing

Hypothesis H44: Celeris reliably preserved different delivery modes when one
spoken turn addressed multiple sessions. A broad sweep caught one Build Worker
send without `delivery: queued`; a twenty-run targeted sample measured eighteen
passes and two identical omissions. This is mechanical routing state, not a
language-generation judgment: the coordinator already defines immediate as the
default and queueing requires explicit human language.

The first deterministic attempt associated any nearby “after this turn” phrase
with a target. It was rejected after zero of twenty runs because that proximity
rule leaked Build Worker's timing backward onto Docs Worker and queued both.
The accepted implementation bounds timing language to the target's conjunction
clause. In a multi-destination turn, explicit queue, wait, or after-current-turn
language forces that target to `queued`; every other target is forced to
`immediate`. A production-path test deliberately gives the harness inverted and
missing model delivery fields and verifies the correct coordinator calls.

The repaired mixed-delivery scenario passed ten of ten runs, its all-immediate
neighbor passed ten of ten, and the final linked sweep passed all 29 scenarios
and all 97 turns. The conventional gate is 97 unit tests, clean typecheck and
build, and 32 of 32 isolated cases. No live Omnigent session was used by H43 or
H44; the excluded ESPN session remained untouched.

### 2026-08-29 — Action-result notification composition

Hypothesis H45: the event-continuity implementation was sufficient when a
human asked for a named send and also asked whether anything arrived while they
were speaking, with a third-session event first appearing in the send result.
The first fixture draft incorrectly assumed a preexisting voice cursor and was
discarded. In the corrected held-out three-turn flow, the unchanged harness
passed four of ten runs. The other six replaced the explicit send with an
unnecessary `get_output` call against its destination, so the later deictic
incremental read also targeted the wrong session and had no cursor.

The runtime now treats the atomic hidden `check_updates` snapshot as the answer
to that generic incoming-event clause. On this narrow compound turn it hides
older-output tools and forces the explicitly named `send_message` before
speech. The deterministic instruction extractor removes the trailing “if
anything came in … tell me too” clause, preventing that voice-layer question
from being sent to the coding agent. A production-path test verifies the exact
outbound message and that neither read tool is exposed.

The first candidate reached nine of ten, but trace inspection found a separate
tail: after the successful send, Celeris sometimes returned an empty completion
before eventually speaking, and in another sample returned empty speech twice.
It also tried to preserve the update question inside the outbound message when
left to compose that argument. The accepted harness path composes a typed action
receipt with concurrent events only when every execution is a successful
renderable action, the existing bounded update renderer accepts the entire
event batch, and the result stays under 300 characters. It therefore returns in
one model round while unsafe, ambiguous, or longer batches still use Celeris.

The strengthened scenario passed ten of ten runs and all 30 turns, including an
exact outbound instruction, a safe third-session update, the exact `audit-31`
cursor on the next `poll_output`, and unchanged Primary Work focus. Every turn
used one model round; after the first cold request, the compound action took
121–169 ms with a 127 ms median in this sample. Promotion evidence is 98 passing
unit tests, clean typecheck and build, 32 of 32 isolated trials, and all 30
stateful scenarios across 100 linked turns. No live Omnigent session was read or
mutated, and the excluded ESPN session remained untouched.

### 2026-08-29 — Focused action plus concurrent decision

The retained 5.619-second Celeris outlier came from the older
model-summarized proactive-notification path. Its ordinary first-round human
requests stayed below 719 ms in that run, and the later direct-notification
release removes the slow background model round for safe events. No current
evidence therefore justified adding a speculative shorter provider timeout.

Hypothesis H46 instead tested the nearest held-out generalization of H45: “tell
it to …” addresses sticky focus, a generic update question follows in the same
ASR-style utterance, and the action result contains a third-session structured
approval. The first fixture incorrectly expected a focused send to carry an
explicit session ID; that assertion was removed because omission is the
intentional server-owned focused default. The unchanged production harness then
failed all ten valid runs for one consistent reason: every outbound message
incorrectly included “let me know if anything came in while I was talking.”
The send itself ran in all ten trials, and every following approval used the
correct opaque Audit Sweep session and prompt identifiers.

The focused instruction extractor now recognizes the narrow “tell/ask it to”
grammar, removes a trailing voice-layer incoming-update clause and terminal
punctuation, and forces the verified send before speech. It does not generalize
from a bare “tell me,” so a pure incoming-update question cannot accidentally
become a coordinator action. The action result's safe decision event uses the
same one-round typed composition introduced by H45 and remains authoritative on
the next deictic approval turn.

The strengthened flow passed ten of ten runs and all 20 turns. Every first turn
sent exactly “rerun the endpoint checks,” spoke the Primary Work receipt and
Audit Sweep staging approval in one model round, and every second turn resolved
the exact prompt without changing focus. After the first cold request, the
compound turn measured 184–259 ms in this sample. Final evidence is 98 passing
unit tests, clean typecheck and build, 32 of 32 isolated trials, and all 31
stateful scenarios across 102 linked turns. No live Omnigent session was read or
mutated, and the excluded ESPN session remained untouched.

### 2026-08-29 — Atomic empty-arrival receipts

Hypothesis H47: the fast model could answer a common ASR-style “did anything
else new just come in while I was talking” turn from the already-current
coordinator snapshot without another tool or model round. The held-out empty
snapshot disproved the unchanged behavior: zero of five trials passed. Every
trial selected `get_output` for sticky focus, even though the question asked
about the event stream rather than older session output, and the frozen
coordinator correctly rejected that unsupported read. Those failing model
rounds took 151–413 ms. A companion snapshot containing new stable focused
output passed five of five and established the fail-closed boundary.

The accepted path expands only the incoming-event grammar needed for the ASR
phrase. It renders a negative receipt when `updates` is atomically empty,
`output_delta.changed` is false, and the event cursor has not expired. Missing
output evidence, a changed focused delta, or additional status/read/action
language disables the shortcut. A compound focused send plus the same arrival
question exposed an important first-candidate hazard: the empty receipt could
have returned before the send. The final implementation instead executes the
action, strips the voice-only clause from its exact instruction, and composes
the verified action receipt with the typed empty result when no event appears
in the action result.

The empty snapshot passed ten of ten at zero model rounds and 0–4 ms. The
compound action passed ten of ten with the exact outbound message in one model
round. A four-turn linked flow covering a prior proactive event, an empty
check, a later event, and a cursor-backed deictic poll passed ten of ten runs
and all 40 turns. The first broad linked gate then exposed an older unrelated
attribution variance rather than an H47 regression.

### 2026-08-29 — Deterministic voice-owned attribution

Hypothesis H48: the repeated prompt contract was sufficient to preserve
human-versus-voice identity in the existing three-turn attribution flow. The
full gate produced one failure, and a targeted sample passed only seven of ten
runs. Two failures acknowledged the ambiguity without explicitly naming the
voice coordinator and the human; another relay dropped the decisive negation
from its outbound message. This repeated a failure class previously retained
after a small sample happened to pass, so more prompt repetition was rejected.

The harness now recognizes only a narrow evidence-backed correction: the typed
recent-action ledger contains a first-person voice-owned mistake, and the human
explicitly says those words will be attributed to them rather than the voice
layer while asking whether the distinction is understood. It responds without
a model round or an action promise. If the next turn explicitly asks to send
that exact distinction, Celeris still must select the real `send_message` tool,
but the harness rewrites the ledger's voice-owned predicate into an explicit
“the voice coordinator …; the human did not” message before execution.

The repaired linked flow passed twenty of twenty runs and all 60 turns; its
understanding turn and exact-message audit use zero model rounds, while the send
uses one. The final promotion gate passed 102 unit tests, clean typecheck, 35 of
35 isolated trials, and all 32 stateful scenarios across 106 turns. Every
coordinator interaction remained frozen and local to the eval harness; no live
Omnigent session was read or mutated, and the excluded ESPN session remained
untouched.

### 2026-08-29 — Private Pocket conditioning state

Hypothesis H49: a zero-shot Pocket voice conditioned from a short private
recording could retain the existing staged runtime's low first-audio latency
without placing gated weights, credentials, or biometric-derived artifacts in
the public image. Two private prompts, 18.69 and 24.82 seconds long, were tested
both as recorded and after mono loudness normalization and 24 kHz resampling.
The originals remained unchanged and every derivative stayed outside git.

The gated checkpoint exported four states. Conditioning took 1.96–3.05 seconds
offline, while candidate synthesis produced first audio in 41.0–44.7 ms. All
four states loaded in 0.5–1.2 ms under the public
`pocket-tts-without-voice-cloning` runtime with network access disabled, proving
that gated weights and Hugging Face authentication are unnecessary after
provisioning. Independent local ASR recovered the complete generic probe from
both normalized candidates; one unnormalized candidate omitted only its initial
greeting.

The longer normalized candidate was provisioned under a generic filename on
the retained private PVC. The public GitOps change contains only that runtime
path and the immutable public-safe image tag. The replacement pod loaded and
warmed Pocket in 5.33 seconds, selected the state without fallback, reached all
coordinator and Discord readiness events, and restarted zero times. This is
zero-shot conditioning rather than weight fine-tuning; subjective speaker
similarity remains a live-listening evaluation.

### 2026-08-29 — Clone-path latency and Discord gap isolation

Hypothesis H50: private conditioning made the staged pipeline materially slower
and starved Discord playback. Fresh live timing contradicted it. Across the
recognized test turns, Celeris took 303–625 ms, Pocket produced first audio in
39–51 ms, and end-of-ASR to playback took 373–690 ms. Long synthesis ran about
five to seven times faster than its audio duration. The cloned model therefore
had enough generation margin and was not the source of an underrun.

The trace exposed two independent continuity failures. Celeris's same-millisecond
diffusion burst was split into separate Pocket requests at sentence boundaries,
resetting prosody and admitting model-owned silence between them. Two empty
receive streams with peaks of 0.099 and 0.104 also crossed the production 0.08
barge-in threshold and cancelled live playback; confirmed phone speech in the
same trace peaked from 0.73 to 0.96. A 15 ms synthesis grace now coalesces
same-burst sentence segments into one utterance while preserving streaming for
content that genuinely arrives later. Production raises only its runtime
barge-in threshold to 0.18.

A replacement private prompt arrived already clean at -20.6 dB RMS and -2.1 dB
peak, so it was only mixed to mono and resampled rather than normalized. Its
generic probe rendered at -25.4 dB RMS and -5.9 dB peak, began in 46–66 ms, and
was recovered exactly by the bundled Nemotron recognizer. The compatible state
was provisioned privately and the replacement pod reached Pocket, coordinator,
and Discord readiness with zero restarts. Three batching regressions bring the
conventional gate to 105 passing tests with clean typecheck and build.

### 2026-08-29 — Rename requests without a title

Hypothesis H51: the base prompt was sufficient to make the fast model ask for
the missing title when the human said only “can you rename the temporary
session.” The unchanged production harness failed all five trials. Every run
called `rename_session` and invented a replacement title, matching the live
failure that unexpectedly mutated the session after the human had asked a
question rather than supplied a name. Those failing first model rounds took
184–1,626 ms.

The voice harness now extracts the requested title from the narrow supported
rename grammar. A rename tool is exposed only when both an explicit rename
request and a nonempty new title are present. When the title is absent and no
concurrent coordinator event needs attention, the harness asks what to call the
focused session without invoking Celeris or any coordinator tool. Concurrent
events and pending decisions retain the ordinary model path so clarification
does not hide fresh state.

The sanitized regression passed ten of ten trials at zero model rounds and
0–4 ms. Focus remains unchanged and no live coordinator session was read or
mutated.

### 2026-08-29 — Superseded partial-turn action safety

Hypothesis H52: immediate Smart Turn delivery was safe even when endpointing
fell through to the semantic timeout. The live trace disproved it. One
incomplete transcript was finalized by `semantic_fallback`; Discord opened the
continuation receive stream about 8 ms later, but the first fragment had already
started a Celeris request. Its `send_message` mutation completed before the
second fragment was recognized. The later response then falsely described both
fragments as delivered even though the action ledger contained only the first.

Only a positive Smart Turn classification now commits with zero merge delay.
Fallback endpoints retain the configured 350 ms continuation grace, and the
next confirmed stream cancels that timer before the transcript is delivered.
Confirmed new speech also aborts the active Celeris turn. The same abort signal
cancels the provider request and is checked after completion plus immediately
before every MCP tool invocation. A production-path regression aborts the turn
after Celeris selects `send_message` and proves that only the initial read-only
`check_updates` call ran.

### 2026-08-29 — Real proactive runtime and replacement decisions

Hypothesis H53: the prompt cleanly distinguished a model-owned polling loop from
the voice runtime's existing proactive coordinator monitor. The live agent said
the human would need to ask again, and the sanitized replay failed all five
trials with “can't monitor.” An explicit capability contract now says the model
cannot invent a sleep/poll loop while the runtime does watch sessions and will
announce real events. The repaired case passed ten of ten in 162–340 ms, while
the adversarial fake-loop case also remained ten of ten.

A second live failure said “nothing new” while a structured command approval
was present. Its unchanged replay failed all five trials. One safe pending
decision is now rendered directly from typed coordinator state instead of being
hidden by an empty event delta; that case passed ten of ten at zero model rounds
and 0–3 ms. Coordinator lifecycle fingerprints now include exact prompt IDs, so
a new prompt replacing an approved one emits `decision_needed` even when the
pending count remains one.

Promotion evidence is 110 passing unit tests, clean typecheck and build, 38 of
38 isolated trials, and all 32 stateful scenarios across 106 linked turns. No
live Omnigent session was read or mutated by these tests, and the excluded ESPN
session remained untouched.

### 2026-08-29 — Typed session organization

Hypothesis H54: Celeris could accurately explain whether sessions are pinned or
filed into projects from the existing session summaries. The unchanged harness
failed all five trials: it omitted the project information and never made the
important distinction that Omnigent exposes `project_id` but no separate pin
field.

The Omnigent client now reads the native session-project catalog, and every
coordinator summary carries a typed project name and ID or `null`. A narrow
organization question is rendered directly from those fields without a model
round. The public fixture uses generic project names only; no live project IDs,
workspace paths, or account-specific values enter the repository.

### 2026-08-29 — Spoken notifications remain authoritative

Hypothesis H55: once a proactive backend reply had been spoken and retained in
history, Celeris would correctly answer a later “did we get a response?” check.
The live trace disproved it twice. In the clearest exchange the coordinator
delivered and spoke the real reply, unrelated small talk followed, and Celeris
then claimed the agent had not responded and promised to keep monitoring. On
the user's correction, the same model found the already-retained update. This
was a model interpretation failure, not a polling or context-delivery failure.

The harness now records a notification-sequence baseline for every successful
send and the latest verified spoken reply for each target. A later response
check is answered directly only when a real output, completion, failure, or
decision notification for that target occurred after that send. A newer send
resets the baseline, so an older update cannot be mistaken for its reply.

The exact linked regression—send, proactive reply, unrelated spoken turn, then
response check—passes with the final check taking zero model rounds. Promotion
evidence is 113 passing unit tests, clean typecheck and build, 39 of 39 isolated
trials, and all 33 stateful scenarios across 110 linked turns. The excluded
ESPN session was not read or mutated.

### 2026-08-29 — Capability honesty and failed-explanation recovery

Hypothesis H56: the general truthfulness and brevity prompt was enough for
Celeris to describe its terminal visibility accurately and recover from an
incoherent explanation after the human objected. Both sanitized live-derived
cases failed all five trials before correction. The model claimed broad output
visibility without stating the persistence boundary; in the failed-joke flow it
kept paraphrasing the same invented “up in the air” premise.

The harness now answers terminal-visibility questions from its actual contract:
persisted conversation plus stable tool or terminal items, no arbitrary live
scrollback, and diffs only when Omnigent persisted them. A narrow explicit
“stop repeating” correction also acknowledges the failure and stops without
repeating the challenged premise. Both cases passed ten of ten in zero model
rounds after the change.

Current promotion evidence is 115 passing unit tests, clean typecheck and build,
41 of 41 isolated trials, and all 33 stateful scenarios across 110 linked turns.
No test touched the excluded ESPN session.

### 2026-08-29 — Marginal semantic-endpoint decisions

Hypothesis H57: Smart Turn's raw 0.5 decision boundary was precise enough to
commit every positive result without continuation latency. The live trace
disproved it. It classified “Why would the scientists be up in the” as complete
at probability 0.6067, immediately finalized the fragment, and forced the human
to restate the question after the unrelated response began.

The retained private telemetry contained 119 predictions: 66 exceeded 0.5,
with 0.9486 median probability, and only seven fell below 0.65. The configurable
completion floor is now 0.65. Marginal predictions remain on the existing 700 ms
incomplete-turn fallback, while the other 59 historical positives retain the
zero-merge-delay path. This avoids transcript-grammar heuristics and changes the
historical immediate-decision set by only 10.6 percent. A pure production helper
regression pins the observed 0.6067 failure below the floor and preserves an
immediate decision at the exact boundary and at the historical median.

The promotion gate passed 119 unit tests, clean typecheck, and a clean build.
This change does not alter the Celeris prompt, tool schemas, conversation state,
or coordinator behavior, so the immediately preceding 41-of-41 isolated and
33-of-33 linked scenario model gates remain the relevant model evidence rather
than being needlessly rerun.

### 2026-08-29 — Backend evidence outranks spoken interpretation

Hypothesis H58: retaining a proactive update and its spoken adaptation in the
same history was enough for Celeris to distinguish what the backend established
from what the voice model had previously inferred. A live-derived exact replay
disproved it: after an update said MCP supports notifications while this
implementation uses polling, a later clarification confidently attributed an
unsupported external-client claim to the agent. The current production replay
reproduced that answer in 421 ms. A sanitized production-harness case failed all
five baseline trials. A reverse held-out case, where the server emitted events
but the client did not subscribe, was unstable at four of five.

The adjacent current-turn invariant now says that exact background-update and
typed tool evidence outrank prior assistant speech. It preserves the source's
actor, positive and negative capability, and causal direction rather than
turning a downstream consumer limitation into an upstream emission failure.
The live-derived case and reverse held-out case each passed ten of ten targeted
trials in one model round after refinement.

The replay also exposed an audit-fidelity limitation rather than a live runtime
limitation: old JSONL records retained the spoken notification but not its exact
source payload, so historical replay could not reconstruct the evidence the
live process had seen. Future background-generation records now retain the
serialized coordinator update in the private audit log, and replay restores it
exactly. Old or malformed records retain the prior bounded synthetic fallback;
missing historical source data cannot be recovered. The payload is sensitive
private conversation data and never enters public fixtures, images, or git.

A sanitized new-format end-to-end replay restored the exact update, ignored an
incorrect prior assistant claim, and answered the backend-versus-client
distinction correctly in 503 ms and one model round. Promotion evidence is 121
passing unit tests, clean typecheck and build, 43 of 43 isolated trials, and all
33 stateful scenarios across 110 linked turns. No eval or replay invoked a live
coordinator action, and the excluded ESPN session remained untouched.

### 2026-08-29 — Streamed speech and remembered speech are identical

Hypothesis H59: the 300-character speech bound applied consistently to both the
sentences streamed into Discord and the assistant response retained in dialogue
memory. The retained voice trace disproved it. Discord queued 302 characters,
ending the second sentence at “which hasn't…”, while the returned and remembered
assistant response contained only the complete 154-character first sentence.
Pocket rendered 19.84 seconds of audio and playback took 19.94 seconds before
the human asked which clause had trailed off. Production replay reproduced the
bad follow-up in 479 ms because the model could see only the shorter remembered
answer.

Streaming now occurs only at complete sentence boundaries before finalization,
counts the spaces between segments against the aggregate budget, and omits a
later sentence when it cannot fit instead of emitting a partial clause. The
speech returned to the conversation, dialogue memory, and audit path is the
exact concatenation that was queued into Discord. The isolated, scenario, and
replay runners now exercise the same streaming callback and abort if returned
speech differs from queued speech; the old runners had missed this production
path distinction. A focused unit regression verifies both the spoken result and
the later “repeat that” memory.

The new authentication-detail case was initially nine of ten after its evaluator
wording was corrected: one response reduced the source's runtime credentials and
private-reachability facts to merely “local.” An adjacent evidence rule raised it
to ten of ten while keeping the answer inside a complete spoken budget. The full
gate also exposed an older honesty-correction case at eight of ten because the
model sometimes invented that it “didn't have” the correct line. Naming those
false access excuses in the adjacent rule raised that case to ten of ten.

Promotion evidence is 122 passing unit tests, clean typecheck and build, 44 of
44 isolated trials, and all 33 stateful scenarios across 110 linked turns. The
evals used a frozen coordinator; no live Omnigent session was read or mutated,
and the excluded ESPN session remained untouched.

### 2026-08-29 — Captured ETA update denial for replay

A retained live trace exposed a compound regression that is queued for the next
voice research pass. The coordinator recorded a successful outbound ETA
question in 666 ms and later delivered unrelated progress from the same focused
session. Across more than four minutes, the assistant nevertheless made at
least five unsupported claims that no ETA response had arrived. It also promised
to report the answer later instead of grounding the claim in a fresh read or an
authoritative update.

The strongest cut point is independent of whether the coordinator originally
missed an item: the human correction explicitly supplied the previously spoken
ETA, but a late completion from an overlapping, superseded turn answered with
unrelated progress. A subsequent verification question then claimed a message
had been sent even though the trace contains no corresponding action receipt.
This therefore needs both a stateful evidence-grounding scenario and a runtime
turn-cancellation regression, not a narrowly worded prompt patch.

Before changing the harness, replay will establish whether the ETA answer was
present in stable Omnigent conversation items, retained in a coordinator event,
or never surfaced through the cursor. Sanitized cases will start at multiple
points in the exchange so a change must generalize across initial update checks,
repeated stale-state questions, explicit human correction, and action
verification. The private source trace remains outside git and no live or
excluded session was read or mutated during this capture.

### 2026-08-29 — ETA denial root cause and continuation repair

Exact production replay reproduced both live failures before the change. The
human's concrete ETA correction was denied in 1,066 ms and one model round, and
the later action-verification turn reused the older ETA-question receipt in 929
ms. The first sanitized stale-receipt case failed three of three baseline trials
and then ten of ten; the linked correction scenario failed all three initial
runs. These were independent of the earlier backend-capability source test.

The retained backend evidence separated visibility from interpretation. The
outbound ETA question was accepted in 666 ms. Subsequent coordinator events
contained implementation progress but not the estimate, so the early claim
that no ETA answer was visible was supportable. Omnigent did not persist the
assistant item containing the numeric estimate until about seven minutes later;
the coordinator detected and began announcing that item roughly two seconds
after persistence. The remaining gap is access to authenticated live assistant
text already streamed in the Omnigent UI, not a stable-item cursor miss.

Three harness defects amplified that gap. First, a deterministic shortcut
treated any newer output from the destination session as the answer to its most
recent sent question. It attached unrelated deployment progress to the ETA
question and bypassed the model. The shortcut is removed. Simple response-status
questions now give Celeris the exact retained notification with no tools and
explicitly require it to distinguish an answer from unrelated progress.

Second, Smart Turn finalized the content-free preamble “can you send a message
for me” and launched Celeris 32 ms after recognition. The caller continued 250
ms later with the actual message, but it became a replacement turn instead of
one relay. Content-free send preambles now retain the 700 ms endpoint fallback
window even after a positive semantic decision. The joined request has a
deterministic self-report transform that names the voice coordinator, preserves
the human as reporter, and copies the estimate and its conditions into the
outbound message. Interrupted inputs are also retained with a marker so later
turns cannot silently lose the newest request.

Third, the small model could still contradict a number explicitly supplied in a
long corrective turn. Numeric human corrections with a time/value unit or an
explicit condition now use a zero-model evidence path that repeats the supplied
value and entire condition. The two original replay cut points consequently
return grounded answers in about 3 ms and zero model rounds. The merged relay
and stale-receipt cases each passed ten of ten targeted trials; the linked
correction flow and the held-out spoken-reply flow each passed five of five.

Promotion evidence is 135 passing unit tests, clean typecheck and build, all 46
isolated trials, and all 34 stateful scenarios across 115 linked turns. The
model evaluations used frozen coordinator state. Investigating persistence used
one read of the explicitly in-scope voice-development session; no message was
sent, no session was mutated, and the excluded ESPN session remained untouched.

### 2026-08-29 — Authenticated live assistant tail

Hypothesis H60: the multi-minute ETA visibility failure is removable without a
new Omnigent endpoint because the installed server already publishes the UI's
assistant text on its authenticated session SSE stream. Keeping that stream
alongside the existing stable-item poll should make in-flight output available
to the frozen human turn while preserving cursor-backed recovery and durable
deduplication.

Source inspection of the installed v0.11.0 server confirmed
`GET /v1/sessions/{id}/stream` is a live-only authenticated SSE tail. Native
assistant chunks carry a stable message ID, monotonic index, and optional final
marker. On reconnect, the server replays the current aggregate after registering
the new subscriber; completed text is eventually published as an authoritative
`response.output_item.done` and appears through `/items`. This directly matches
the ETA trace: the web UI could show the estimate before the durable item did.

The coordinator now opens that stream for focused, active, and explicitly
touched sessions. `check_updates` can consume only the new partial suffix while
the caller is still speaking; proactive notification waits for a final message.
Connection epochs merge replayed aggregates instead of duplicating their
prefix. Final live text enters the ordinary output/event cursor once, and the
later stable item is consumed as reconciliation rather than emitted again.
An otherwise empty idle-transition event is suppressed for five seconds after
the live final so the caller does not hear the answer and then an immediate
redundant completion notice.
Disconnects use bounded backoff and immediately reconcile stable items; the
original two-second poll remains the correctness fallback.

The focused transport suite passes 15 of 15 tests, including SSE framing,
partial-then-final context, final-to-stable reconciliation, and a reconnect
snapshot followed by new chunks. A real isolated session smoke test connected
the SSE tail in 25 ms, accepted the test message in 38 ms, received first text
2,195 ms after send, and received the complete guided reply at 2,400 ms. The
single returned delta contained the expected marker. The new session was
archived after the test; no existing session was read or mutated, and the
excluded ESPN session remained untouched. Promotion evidence is 138 passing
unit tests, clean typecheck and build, all 46 isolated Celeris trials, and all
34 stateful scenarios across 115 linked turns.

### 2026-08-29 — Model-only native stream compaction

Hypothesis H61: authenticated live output removed the persistence delay, but a
native delta containing the whole recent terminal/tool prefix was wasting
context and making the small voice model rediscover the final assistant answer.
The first two post-rollout notifications confirmed both sides. New final output
was delivered immediately; Celeris completed in 737 ms and 599 ms, and Discord
playback began 923 ms and 661 ms after delivery started. However, each source
delta was roughly 8.5 KB and the model prompts grew from 4,637 to 7,435 tokens
after the first noisy payload entered retained history. The spoken adaptations
were only 106 and 132 characters.

The harness now recognizes native deltas with separated tool-call or tool-result
sections and selects the last assistant conclusion for Celeris. The same
model-only transform is applied to proactive notification prompts, current
coordinator snapshots after human speech, updates attached to later tool
results, and retained notification history. A synthetic production-sized
7,934-character delta became a 93-character model value, a 98.8 percent
reduction. The original payload remains authoritative for safe deterministic
rendering, cursor advancement, and private audit logging. A noisy delta without
a usable final assistant section is capped at 2,000 characters but still goes
through Celeris; compaction cannot promote untrusted tool text into direct
speech.

The new linked regression uses ASR-style skepticism after a noisy notification:
“was that actually from voice work just now or were you reading me some old
command junk.” Its first strict evaluator scored zero of five, but trace review
showed that the failures were literal-word mismatches such as “passing” versus
“passed” and “real-time” versus “current,” not wrong behavior. The corrected
semantic assertions require the named session, the live-output conclusion, the
measured 2.2-second result, and rejection of tool-log attribution. The candidate
passed five of five linked runs across ten turns in one model round per turn.
No coordinator action or live-session read was used for this experiment, and
the excluded ESPN session remained untouched. Promotion evidence is 142 passing
unit tests, clean typecheck and build, all 46 isolated trials, and all 35
stateful scenarios across 117 linked turns.

### 2026-08-29 — Typed streaming evidence cannot look final

Hypothesis H62: selecting the last textual `assistant:` marker was sufficient
for noisy native deltas. A code-path audit disproved it. An older assistant
message can be followed by newer tool activity before any new conclusion; the
fallback parser would then retain that stale message together with the trailing
tools and tag the whole value as the latest conclusion. The post-deploy log had
no human or notification turns yet, so this was found without reading or
mutating any live session.

Coordinator output entries now retain whether they are assistant text or native
activity. Every delta exposes the newest assistant value separately and marks it
`streaming` or `final`; the model-only compactor consumes that typed value and
removes its duplicate field. The legacy fallback now accepts a conclusion only
when the last structural section is `assistant:`. If newer tool or terminal
activity follows it, the bounded model view explicitly says there is no new
assistant conclusion. The original chronological payload remains unchanged for
cursors, deterministic safety checks, and private audit logging.

A new linked scenario asks, in ASR-style speech, what the focused session has
said “so far” while the typed suffix ends mid-sentence at “passed 20 of.” The
baseline failed five of five: Celeris called `get_output`, discarded the fresh
suffix, and omitted both the number and its streaming status. A narrow typed
evidence renderer now answers that current-status request in 0–4 ms and zero
model rounds while saying the session is still responding. It refuses a named
nonfocused target so fresh focused output cannot be misattributed. The later
final event is still adapted normally and preserves the final count.

The complete candidate passed five of five targeted linked runs, 145 unit
tests, clean typecheck and build, all 46 isolated cases after retrying one
rate-limited invalid trial, and all 36 stateful scenarios across 119 linked
turns. No coordinator action or live-session read occurred, and the excluded
ESPN session remained untouched.

### 2026-08-29 — Final live continuations and exact multi-target relays

Hypothesis H63: once a human turn consumes the prefix of a live assistant
message, the final cursor delta needs explicit scope in addition to its
`final` state. The baseline direct path read the remaining value literally as
“assistant continued” and presented it as an ordinary update. The coordinator
now marks assistant evidence as `full`, `continued`, or `streaming_suffix`.
A short safe finalized continuation is rendered as the named response's final
part; the new linked regression moved from zero of three baseline runs to five
of five candidate runs in 0–4 ms and zero model rounds.

The full gate then exposed a separate stochastic pattern in exact user relays.
Target resolution and focus safety were correct, but Celeris occasionally
shortened “rerun the flaky reconnect test with debug logs” to a generic
reconnect request. A captured failing trace omitted “flaky”; earlier runs had
also omitted “rerun.” Natural deictic and ordinal forms such as “tell that one
rerun …” now use the same deterministic exact-clause preservation as an
explicitly named destination. The repaired notification-pronoun flow passed ten
of ten linked runs across thirty turns.

Two more full-gate failures showed that this was a general relay boundary, not
a phrase-specific prompt problem. “Tell Side Beta rerun …” without the spoken
word “to” lost its verb in a compound send-and-switch, and one of two different
destination messages lost both “write” and “latency numbers.” The harness now
accepts the common no-`to` ASR form, separates every explicitly addressed
destination clause, and injects its exact user-supplied instruction. Delivery
timing and navigation phrases remain typed control: `now`, after-current-turn,
and “don't switch me” do not become work sent to the coding agent. Read-derived
relays remain model-composed and still pass the source-evidence guards.

Each newly unstable linked flow passed ten of ten after the general change:
compound partial failure, two explicit destinations, and mixed immediate/queued
destinations. Promotion evidence is 146 passing unit tests, clean typecheck and
build, all 46 isolated trials, and all 37 stateful scenarios across 120 linked
turns. Three scenarios in the final aggregate run were invalidated only by HTTP
429 responses and each passed on its immediate isolated rerun; no invalid trial
was counted as a quality pass. All model evaluations used frozen coordinator
state, no live Omnigent session was read or mutated, and the excluded ESPN
session remained untouched.

### 2026-08-29 — Two-destination ASR without “to”

Hypothesis H64: the no-`to` grammar promoted for one destination did not extend
to a realistic compound utterance such as “tell Build Worker rerun … and tell
Docs Worker write ….” The new linked baseline failed zero of three: neither
message tool ran, both requested destinations were absent from speech, and the
work was silently lost behind an ambiguous/model response.

Multi-target routing now accepts the omitted word only when every explicitly
addressed destination is followed by a concrete instruction. The exact-clause
extractor uses the same boundary and injects each dictated task into its own
tool call. Conjunctions and question/source prefixes including “what,”
“whether,” and “how” are excluded, so “tell Primary what Side found” still
requires output evidence instead of becoming a blind deterministic send.

The candidate passed ten of ten targeted linked runs. Nine completed both sends
in one model round and one used the existing required-action recovery round;
all kept sticky focus. Promotion evidence is 146 passing unit tests, clean
typecheck and build, all 46 isolated trials after one HTTP 429 rerun, and all 38
stateful scenarios across 121 linked turns. The evaluations used frozen
coordinator state, no live session was read or mutated, and the excluded ESPN
session remained untouched.

### 2026-08-29 — Compound “send a message” and “let know” clauses

Hypothesis H65 came from aggregate-only inspection of the retained private
audit log. Across 223 recognized turns, 74 contained relay-like language;
“message” appeared in 33, “tell” in 15, “ask” in 13, explicit “send a message”
in eight, and five were compound relays. Only counts and event field names left
the private pod. No transcript text, session name, or identifier was printed or
copied into the repository.

The existing focused garbled-send and ordinary-send cases each passed ten of
ten, so changing that stable path was unwarranted. The uncovered boundary was
two separately addressed clauses using “send Build Worker a message to …” and
“let Docs Worker know ….” The new stateful baseline failed zero of three:
neither send ran and both destinations disappeared from the response.

Routing and exact-clause extraction now recognize those two bounded forms. A
bare “send Build Worker and …” remains ambiguous, preventing an incomplete
clause from becoming remote work. The candidate passed ten of ten targeted
runs; nine completed both tools in one model round and one used the existing
required-action recovery round. Promotion evidence is 146 passing unit tests,
clean typecheck and build, all 46 isolated trials, and all 39 stateful scenarios
across 122 linked turns. Model tests used frozen coordinator state, no live
session was read or mutated, and the excluded ESPN session remained untouched.

### 2026-08-29 — Notification ordinals and mandatory detail reads

Hypothesis H66 began with aggregate-only inspection of the private audit log.
Across 223 recognized turns, 74 were relay-shaped and 26 typed coordinator
actions were recorded. Three unsupported send-success claims existed only in
the earliest few of 52 process epochs; none occurred after the action guards
were introduced. One recent relay-shaped turn without a receipt was a
content-free preamble with no generated or played response, consistent with
utterance merging rather than a false delivery. Only aggregate counts and
event types left the private pod; no transcript, name, ID, or output was copied
into the repository.

The next uncovered state transition was a single ASR-style turn addressing two
fresh notifications independently: tell the first session to rerun a measured
probe set and tell the second to record a first-audio measurement, without
changing sticky focus. The baseline passed zero of three runs because only one
`send_message` was selected. In one proactive run the model had also omitted a
numeric fact from the two-session completion announcement.

The harness now retains notification order, resolves every separately
addressed ordinal, requires distinct destinations and complete clauses, and
injects the exact per-session instruction. Incomplete or repeated clauses fail
closed. A safe batch of two or three completion summaries is rendered directly
within the existing 300-character speech bound, eliminating the lossy model
round. The candidate passed ten of ten linked runs across 30 turns; every
notification batch used zero model rounds and every compound action used one.

The first full promotion run then exposed an older intermittent weakness: after
a content-free completion notification, an ASR-style request for where that
session left off could answer without reading its output. A notification detail
question now forces `get_output` for the server-owned announced target. A read
is also forced for any read-shaped follow-up when the notification has no
summary or output; a sufficient retained summary remains usable for an ordinary
question. The formerly flaky isolated case passed ten of ten in one model round.

Final promotion evidence is 147 passing unit tests, clean typecheck and build,
all 46 isolated model trials, and all 40 stateful scenarios across 125 linked
turns with no invalid trials. All model evaluations used frozen coordinator
state. No live Omnigent session was read or mutated, and the excluded ESPN
session remained untouched.

### 2026-08-29 — Tool-free persona isolation probe

Persona work became the human's explicit priority after the H66 coordinator
checkpoint. The first implementation reuses the production Discord, streaming
ASR, semantic endpointing, barge-in, Celeris, Pocket TTS, memory compaction, and
private audit path while omitting construction of the Omnigent client,
coordinator, and MCP client. Rendered persona deployment configuration also
withholds all Omnigent URLs and secret keys from the voice container.

A sanitized three-turn live Celeris probe tested conversational tone, an ASR-
style qualification, and recall of why the speaker liked rainy mornings. The
first run exposed one raw internal control marker instead of speech on the third
turn. The harness now classifies leaked channel/control markers as invalid,
discards them before speech, and retries once with a bounded adjacent repair
instruction. The corrected linked run returned natural answers in 342, 234,
and 146 ms respectively while preserving the original preference and later
qualification. No tool schema or coordinator snapshot was present in any
persona request, and no Omnigent session was read or mutated.

### 2026-08-29 — Preflight updates cannot erase compound actions

Hypothesis H67 came from a production control-flow audit after the persona
checkpoint. A linked ASR-style turn told two named background sessions to do
different work while also asking what arrived during speech. A third session's
stable output was already present in the atomic snapshot at speech
finalization. The baseline failed zero of three runs: it rendered that update
in 0–5 ms and returned before either requested `send_message` call ran.

The direct arrival renderer now runs only when the turn requests no additional
coordinator work. For a compound arrival-and-send turn, the harness forces the
first `send_message`; the existing required-destination guard then executes
every remaining separately addressed send before speech. Verified receipts and
the concurrent update are composed deterministically when they fit the spoken
budget. The update's session identity and opaque cursor remain in notification
history, and sticky focus is unchanged.

The candidate passed five of five targeted linked runs across fifteen turns.
Every compound turn completed both exact sends in one model round, spoke the
third-session update, continued from its cursor on the next turn, and answered
the two-action/focus audit in zero model rounds. Five neighboring notification,
decision, action, ordinal, and cursor scenarios also passed. Promotion evidence
is 159 passing unit tests, clean typecheck and build, and all 41 stateful
scenarios across 128 linked turns. The isolated corpus passed 45 of 46 on its
first aggregate sweep; the unrelated context-description case that produced
one unapproved number then passed five of five targeted reruns, so it remains
recorded as stochastic evidence rather than a quality pass. All coordinator
executions were frozen. No live Omnigent session was read or mutated, and the
excluded ESPN session remained untouched.

### 2026-08-29 — Voice-directed “tell me” is not a session message

Hypothesis H68 extended the H67 speech-finalization boundary beyond sends. One
linked ASR-style work sequence renamed a temporary session, archived it back to
the prior focus, approved a background prompt, explicitly switched focus, and
continued a concurrent update cursor. Every action turn also asked what arrived
while the human was speaking.

The baseline failed zero of three scenario runs. Rename, archive, approval, and
cursor continuation worked, but “switch me to Build Worker and tell me if
anything else came in” was classified as both a focus and a message request.
The harness therefore executed an unrequested `send_message`, then omitted the
Metrics Watch update. The deterministic cause was the single-name routing
fallback: it treated voice-directed “tell me” as an outbound verb because the
same transcript happened to name the focus target.

Message routing now removes voice-directed tell/ask clauses unless a separate
outbound verb or addressed recipient remains. Explicit and deictic sends retain
their existing routes. The focused-session receipt also names the previous
focus when the typed tool result supplies it, making the state transition clear
without a model round. The repaired scenario passed five of five runs across
25 linked turns; all four distinct actions ran exactly once, every concurrent
update was spoken, and the final opaque cursor continued without changing
focus.

Promotion evidence is 159 passing unit tests, clean typecheck and build, all 42
stateful scenarios across 133 linked turns, and the six closest focus, action,
notification, and cursor scenarios. The isolated corpus passed 45 of 46 on its
aggregate run; the unrelated partial-name read that emitted one malformed
model ID then passed five of five targeted reruns. All coordinator executions
were frozen. No live Omnigent session was read or mutated, and the excluded
ESPN session remained untouched. The live persona pod was not redeployed
by this coordinator-only source change.

### 2026-08-29 — Compound rename boundaries and required follow-on actions

Hypothesis H69 tested whether the generic “multiple actions per turn” behavior
actually extends beyond send-and-switch. A realistic ASR-style turn renamed the
focused temporary session and then dictated a rerun instruction back to that
same session. The baseline failed zero of five runs: Celeris renamed the
session and immediately acknowledged it, silently dropping the requested
message every time.

The shared harness now recognizes the bounded focused form “tell it rerun …”
without requiring a spoken `to`, copies the full user-supplied clause, and
requires both `rename_session` and `send_message` before speech. The local
rename title is likewise parsed only through the next explicit action clause
and injected into the tool call. A second baseline exposed why that boundary is
important: in “rename this session latency lab and then switch me back to
primary work,” the old cross-clause `to` matcher selected “primary work” as the
new title in five of five runs. The bounded parser now preserves “latency lab,”
and explicit named focus participates in the same required-action set.

The focused rename-and-send candidate passed ten of ten initial action trials,
then five of five linked runs across ten turns including a follow-up audit of
the exact instruction and current renamed focus. The rename-and-switch candidate
passed five of five runs in one model round. Promotion evidence is 160 passing
unit tests, clean typecheck and build, and all 46 isolated trials. The full
stateful sweep passed 43 of 44 scenarios across 136 linked turns; its only miss
was an unrelated older evidence scenario adding the forbidden phrase “keep an
eye.” That scenario immediately passed five of five targeted reruns across 25
turns, while both H69 scenarios and every neighboring action scenario passed in
the aggregate. After the unrelated H70 evidence fix, the same complete stateful
suite passed 44 of 44 scenarios across 136 turns. All tests use the same
production conversation and in-memory MCP path with frozen coordinator results.
No live Omnigent session was read or mutated, and the excluded ESPN session
remained untouched.

### 2026-08-29 — Evidence answers cannot offer model-owned monitoring

Hypothesis H70 came from the only miss in H69's full stateful sweep. On a
follow-up correctly observing that a background update did not contain the
requested estimate, Celeris sometimes appended “keep an eye” language despite
the base capability rule. A one-turn reconstruction through the exact
production harness measured the baseline at 19 of 20. The factual comparison
was correct; the unsupported future offer was the only failure.

An adjacent prompt-only prohibition did not generalize: it regressed to 17 of
20 and was reverted. The final candidate uses a narrower execution boundary.
Only retained-backend-evidence comparisons buffer the short completion instead
of streaming it, then discard any whole sentence that offers model-owned
monitoring, watching, reporting, or later notification before TTS. Current
evidence sentences remain untouched, and the runtime's real proactive-event
capability is still described normally on capability questions. An initial
20-run reconstruction happened not to emit the forbidden phrase, but the first
canonical rerun exposed that “it didn't say how long” was outside the older
`responded`/`replied` intent predicate and scored only eight of ten. The final
intent boundary also recognizes retained-event questions asking whether the
agent said, gave, provided, mentioned, or answered something. With that scope
fixed, the canonical case passed 30 of 30, while the neighboring proactive-
runtime capability case passed ten of ten and the original five-turn scenario
passed five of five across 25 turns. Promotion evidence is 161 passing unit
tests, clean typecheck and build, all 47 isolated cases, and all 44 stateful
scenarios across 136 linked turns with no invalid trials. The sanitized failure
is now a permanent corpus case; every coordinator execution was frozen, no live
session was accessed, and the excluded ESPN session remained untouched.

### 2026-08-29 — New-session tasks exclude voice update controls

Hypothesis H71 first tested two other compound-action boundaries: archive plus
an exact relay, and approval plus an exact relay. Both passed ten of ten through
the unchanged shared harness, so no speculative action enforcement was added.
The uncovered failure was start-session plus a request to report events that
arrived during speech. In all five baseline runs, the correct session was
started and the concurrent update was spoken, but the injected coding task was
`profile the phone endpointing cutoff and tell me what came in while i was
talking`. The voice-only update control had leaked into remote work.

`voiceStartInstruction` now removes only a trailing voice-directed arrival
clause while preserving legitimate continuations such as “and tell me how to
reproduce it.” The bounded task remains harness-injected, and an explicit start
participates in the required-action set before speech. The candidate passed ten
of ten targeted runs in one model round with the exact task, verified start
receipt, concurrent Metrics Watch source, 190-millisecond measurement, and zero
false-cut result. All coordinator results were frozen; no live session was read
or mutated. Promotion evidence is 161 passing unit tests, clean typecheck and
build, all 47 isolated cases, and all 45 stateful scenarios across 137 linked
turns with no invalid trials. The excluded ESPN session remained untouched.

### 2026-08-29 — Nested mutation language is relay content, not authority

Hypothesis H72 audited a security-sensitive ambiguity rather than another
surface paraphrase: “tell Build Worker rename/archive …” is an outbound coding
instruction, not permission for the voice coordinator to mutate sticky focus.
The baseline nested-rename flow failed zero of twenty. Every run first called
the locally exposed `rename_session` on the focused session, then needed a
second round for the intended background send. The nested-archive model behavior
happened to pass twenty of twenty, but static request inspection showed that
the destructive local archive tool was exposed under the same lexical rule.

Local rename and archive tools are now included only for a direct voice command
at the start of the turn. Nested action words remain in the exact dictated
`send_message` clause, and a direct archive participates in the verified
required-action set. The candidate passed forty of forty targeted model runs:
each used only one exact send to Build Worker in one round, never changed focus,
and never exposed a local mutation as an executable choice. The first full
sweep then showed that a start-of-string-only direct-action grammar was too
strict for the real ASR prefix “yeah that's enough archive …”; it withheld the
valid archive tool. A forced empty-schema tool-choice experiment also failed and
was reverted. The final scope test accepts natural discourse before a mutation
unless an addressed outbound relay precedes it. The original temporary-session
flow then passed ten of ten across fifty linked turns.

Promotion evidence is 162 passing unit tests, clean typecheck and build, all 47
isolated cases, and all 47 stateful scenarios across 139 linked turns with no
invalid trials. The permanent pair tests both the observed rename failure and
the archive safety boundary. All coordinator results were frozen; no live
session was accessed, and the excluded ESPN session remained untouched.

### 2026-08-29 — Addressed task navigation remains remote work

Hypothesis H73 tested whether H72's addressed-relay boundary generalizes beyond
the destructive mutation verbs that motivated it. Coding instructions commonly
contain phrases that look like voice navigation, including “focus on the
reconnect timeout” and “switch branches to latency experiment.” In both cases,
the user explicitly addressed Build Worker and also said not to switch the
voice coordinator's focus. The correct behavior is one exact message to Build
Worker with sticky focus unchanged.

The unchanged production harness passed twenty of twenty targeted trials in one
model round, so no speculative implementation change was warranted. Both flows
are now permanent stateful regressions. Static promotion gates passed 162 unit
tests, typecheck, and build. The complete isolated corpus passed all 45 valid
trials; two API-throttled trials were invalid and each passed its immediate
targeted rerun. The complete stateful sweep passed 47 of 48 valid scenarios;
one unrelated three-source comparison omitted its deterministic relay receipt,
then passed five of five targeted reruns across ten linked turns. One throttled
scenario also passed its immediate rerun. The corpus now contains 49 stateful
scenarios and 141 specified linked turns. All executions used frozen coordinator
results, no live Omnigent session was accessed or mutated, and the excluded ESPN
session remained untouched.

### 2026-08-29 — General navigation verbs remain scoped to addressed work

Hypothesis H74 extended the addressed-task authority audit to four ordinary
coding verbs that overlap the voice coordinator's navigation vocabulary:
“open,” “select,” “choose,” and “use.” The first pair asked Build Worker to open
the reconnect configuration and select the latest trace; the second asked it to
choose a safer retry and use the stable branch. In both cases sticky focus was
Primary Work and only one exact send to Build Worker was valid.

Variants with an explicit “don't switch me” hint passed forty of forty trials.
The stronger variants removed that hint and independently passed another forty
of forty, always in one model round. The unchanged production harness therefore
already scopes these words correctly and no speculative runtime change was
made. The two stronger flows are permanent stateful regressions. Promotion used
the same harness and frozen coordinator as production, with 162 passing unit
tests, clean typecheck and build, and eighteen of eighteen targeted promotion
runs across all six nested navigation cases. The corpus now contains 51
stateful scenarios and 143 specified linked turns. No live Omnigent session was
accessed or mutated, and the excluded ESPN session remained untouched.

### 2026-08-29 — New side work does not absorb a separate relay

Hypothesis H75 covered an untested compound boundary: one ASR-style utterance
started a side session to investigate reconnect jitter and separately told
Primary Work to retain its current branch until a benchmark finished. Celeris
selected both correct tools, targets, and clauses, but the voice harness then
overrode the model's correct `start_session.instruction` with the complete
utterance. The baseline failed zero of five because the new side session
received both its own task and the unrelated Primary Work instruction.

`voiceStartInstruction` now accepts only the session names that the existing
message router independently resolved, finds the earliest explicit relay clause
to one of those sessions, and bounds the new-session task before that clause.
This does not use a generic action-word split: continuations such as “and tell
me how to reproduce it” remain part of the coding task. The explicit start and
send already participate in the shared required-action gate, and their typed
success results now yield one deterministic compound receipt without another
model round.

The repaired canonical flow passed ten of ten trials. A held-out “make a side
chat … then ask Docs Worker …” grammar also passed ten of ten with its distinct
180-millisecond result preserved. Both completed in one model round. Promotion
evidence is 162 passing unit tests, clean typecheck and build, all 47 isolated
cases, and all 53 stateful scenarios across 145 linked turns with no invalid
trials. The two compound flows are permanent regressions. All coordinator
execution was frozen, no live Omnigent session was accessed or mutated, and the
excluded ESPN session remained untouched. The live Audrey persona pod was not
redeployed for this coordinator-only change.

### 2026-08-29 — Temporary-session descriptors are not rename titles

Hypothesis H76 audited the compound mutation “rename this temporary session,
then archive it.” Tool order matters: rename must apply to the temporary session
before archive restores Primary Work. Across the baseline, Celeris preserved
that order, but all twenty canonical runs injected the title `temporary session
reconnect scratch` instead of `reconnect scratch`. The parser had treated only
the word “this” as the target reference and absorbed its descriptive session
words into the title. A held-out “call this session … then archive it” grammar
passed twenty of twenty.

The bounded rename parser now recognizes common qualified references including
temporary, temp, current, focused, active, and side sessions, chats, or
conversations before extracting the exact title. It still stops at the next
explicit action clause, so archive remains a separate required action. The
canonical and held-out pair then passed all 38 valid trials; two HTTP 429 calls
were invalid and excluded. Every valid run renamed first, archived the renamed
session second, restored Primary Work, and spoke all three names within two
model rounds.

The two ordered mutation flows are permanent stateful regressions. Promotion
evidence is 162 passing unit tests, clean typecheck and build, all 47 isolated
cases, and all 55 stateful scenarios across 147 linked turns with no invalid
trials. All coordinator execution was frozen; no live Omnigent session was
accessed or mutated, and the excluded ESPN session remained untouched. The live
Audrey persona pod was not redeployed for this coordinator-only change.

### 2026-08-29 — Explicit new-session names and tasks remain verbatim

Hypothesis H77 tested a natural compound request: make a new session called
Reconnect Lab to investigate websocket jitter, then tell Primary Work to keep
its release branch unchanged. Both coordinator actions executed in all twenty
baseline trials, and the model preserved the title, but seventeen trials
rewrote the task as `Investigate websocket jitter.` rather than copying the
user's exact `investigate websocket jitter`. The harness did not recognize a
`session called NAME to TASK` form, so it neither enforced the start nor
injected the bounded title and instruction.

Named starts now recognize session, chat, or conversation plus called/named and
to/for grammar. The runtime copies both explicit fields into `start_session`,
bounds the task before any separately routed known-session relay, and includes
the start in the existing required-action set. An ordinary unnamed start still
lets Celeris choose its title, and user task continuations remain unchanged.

The repaired canonical flow passed twenty of twenty. A held-out `chat named
Audio Probe for ...` request with a distinct Docs Worker relay and a
180-millisecond fact also passed twenty of twenty. Every successful result
preserved the exact title, task, relay target, and relay content within two
model rounds. The two flows are permanent stateful regressions. Promotion
evidence is 162 passing unit tests, clean typecheck and build, a final 47-of-47
isolated confirmation, and all 57 stateful scenarios across 149 linked turns
with no invalid trials. Two unrelated isolated cases missed once in the first
sweep, passed five of five immediate targeted reruns each, and passed in the
final complete confirmation. All coordinator execution was frozen; no live
Omnigent session was accessed or mutated, and the excluded ESPN session remained
untouched. The live Audrey persona pod was not redeployed for this
coordinator-only change.

### 2026-08-29 — Single-recipient relay forms remain verbatim

Hypothesis H78 compared two common single-recipient dictation forms with the
already deterministic multi-recipient grammar. “Send Build Worker a message to
rerun all 48 packet probes unless reconnect is stable” happened to pass twenty
of twenty baseline trials exactly. “Let Docs Worker know the first audio result
was 180 milliseconds” passed only three of twenty: seventeen messages added
punctuation, capitalization, or a false “voice coordinator reports”
attribution.

The bounded single-recipient extractor now covers send-NAME-a-message,
message-NAME-to, and let-NAME-know forms. It resolves only the independently
matched known-session target, copies the dictated payload, and continues to
strip only separate voice navigation controls. Read-dependent relays still use
model synthesis because their message must be grounded in returned evidence.

After the change, both canonical forms passed twenty of twenty with exact
outbound text and one model round. They are permanent stateful regressions.
Promotion evidence is 163 passing unit tests, clean typecheck and build, all 47
isolated cases, and all 59 stateful scenarios across 151 linked turns with no
invalid trials. All
coordinator execution was frozen; no live Omnigent session was accessed or
mutated, and the excluded ESPN session remained untouched. The live Audrey
persona pod was not redeployed for this coordinator-only change.

### 2026-08-29 — Post-tool summaries retain verified action receipts

The first H78 promotion sweep exposed a separate long-standing failure in the
three-source comparison flow. The send itself was grounded, validated, and
accepted, but the final Celeris synthesis sometimes spoke only the comparison.
It omitted both that a send occurred and the Release Work destination. The
complete sweep missed once, a five-run targeted check missed once, and a traced
ten-run reproduction missed once. This was not an action failure; it was a
spoken truthfulness failure after a verified action.

Post-action synthesis rounds are now buffered instead of streamed. The harness
derives receipts only from successful typed tool results, preserves exact
receipts already present in model speech, and prefixes any omitted receipt
before the synthesized detail. The combined speech is still bounded to 300
characters, with verified action outcome prioritized over optional detail.

The three-source comparison then passed twenty of twenty runs across forty
linked turns, including every destination and send acknowledgement. Both H78
single-recipient cases remained green in ten of ten adjacent runs. Promotion
evidence is 163 passing unit tests, clean typecheck and build, all 47 isolated
cases, and all 59 stateful scenarios across 151 linked turns with no invalid
trials. All coordinator
execution was frozen; no live Omnigent session was accessed or mutated, and the
excluded ESPN session remained untouched. The live Audrey persona pod was not
redeployed for this coordinator-only change.

### 2026-08-29 — Plain named check-ins skip lossy rewording

The first post-H79 isolated sweep exposed a reproducible four-of-five failure in
the existing unique-partial-name read case. The harness always resolved Release
Login Audit, injected its authoritative ID, and received the correct typed
assistant result. It then unnecessarily requested a second Celeris synthesis
round for the ordinary phrase “check in on,” and that round occasionally omitted
both the session name and its result.

Plain non-mutating `check in` reads now share the existing bounded direct-read
path used for latest, status, progress, and doing questions. A safe assistant
message of at most 240 characters and three lines is named and spoken directly
after `get_output`; URLs, code fences, updates, and action language still fail
closed to model synthesis.

The formerly flaky case passed twenty of twenty after the change, always in one
model round. Its median model time was about 157 milliseconds; the cold first
request was 515 milliseconds. Promotion evidence is 163 passing unit tests,
clean typecheck and build, all 47 isolated cases, and all 59 stateful scenarios
across 151 linked turns with no invalid trials. All coordinator execution was
frozen; no live Omnigent session was accessed or mutated, and the excluded ESPN
session remained untouched. The live Audrey persona pod was not redeployed for
this coordinator-only change.

### 2026-08-29 — Inverse-address send forms remain verbatim

Hypothesis H81 came from a coverage mismatch in the relay grammar. Session
routing recognized “send a message to Build Worker to …,” but the deterministic
payload extractor recognized only “send Build Worker a message to ….” The
uncovered form therefore passed through model-authored tool arguments. A
twenty-run baseline reached the correct destination every time but preserved the
exact numeric and conditional payload only seventeen times; three runs changed
capitalization or punctuation.

The bounded extractor now recognizes `send a|the message to NAME to|that` after
the independently resolved known-session target. It copies only the following
payload and continues to use the existing navigation-clause cleanup. This does
not weaken destination resolution or permit a model-supplied session ID.

After the change, the canonical form and a held-out “send the message to Docs
Worker that …” form passed all 38 valid trials in one model round; two HTTP 429
responses were invalid transport trials and excluded. Promotion evidence is 163
passing unit tests, clean typecheck and build, all 47 isolated cases, and 60 of
61 stateful scenarios across 153 linked turns. The sole broad-sweep miss was an
unchanged older notification scenario whose speech omitted the literal word
“approval”; it immediately passed ten of ten targeted scenario runs across 50
linked turns, so this relay-only change did not expand into a notification
wording fix. All coordinator execution was frozen; no live Omnigent session was
accessed or mutated, and the excluded ESPN session remained untouched. The live
Audrey persona pod was not redeployed for this coordinator-only change.

### 2026-08-29 — Decision scenarios use the production event shape

Hypothesis H82 investigated H81's sole broad-sweep miss rather than dismissing
it as model variance. One proactive Side Beta decision notification omitted the
literal word “approval,” although the action state and later deictic reference
were correct. The unchanged five-turn scenario then passed ten of ten immediate
reruns, confirming stochastic wording but not explaining why a typed decision
had used Celeris at all.

Source inspection found that the scenario's decision event was the only one in
the corpus without structured `prompts`. The coordinator always publishes the
current prompt registry with a real `decision_needed` event. Its direct renderer
requires that production shape so it can preserve confirmation versus form
semantics and the exact question. The stale summary-only fixture therefore
forced a model round that production would not use.

The fixture now carries its prompt ID, confirmation mode, and exact restart
question. The scenario loader also rejects any future decision notification
without at least one production-shaped prompt containing an ID, message, and
mode; a deliberately malformed probe failed before making a model request. The
corrected scenario passed five of five runs across 25 linked turns. Its decision
notice was exact in zero model rounds and measured 0 milliseconds in every run.

Promotion evidence is 163 passing unit tests, clean typecheck and build, all 47
isolated cases, and all 61 stateful scenarios across 153 linked turns with no
invalid trials. This cycle changed evaluation fidelity rather than production
runtime behavior. All coordinator execution was frozen; no live Omnigent
session was accessed or mutated, and the excluded ESPN session remained
untouched. The live Audrey persona pod was not redeployed.

### 2026-08-30 — Persona context quality and delayed-answer playback

The retained live transcript showed three distinct failures rather than one
generic model-quality problem. A creative adviser returned after 3.4 seconds,
and Pocket synthesized the final joke, but Discord had already moved the raw
player to idle after the hold line; the caller heard no answer. Direct questions
about memory and idea provenance then received false denials because the prompt
required Audrey to hide the very mechanisms whose records were in context. A
phonetic “deep sea flash” reference was also interpreted as an invented visual
effect even though recent dialogue supported DeepSeek Flash. Prompt size was
only about 2,210 tokens, so compaction was not the cause.

The first corrective hypothesis is that high-value context must be prepared
before endpoint without becoming a latency dependency. Partial ASR now launches
one DeepSeek structured turn brief, while local embedding retrieval continues in
parallel. A ready prefix-related brief supplies an interpretation, selected
facts, response strategy, and at most two response ideas; a late brief is simply
omitted. Creative requests fall back to the explicit adviser, and a silent PCM
keepalive preserves the Discord stream between its acknowledgment and result.

Memory extraction now requires a canonical key, source speaker, and exact
evidence quote. Runtime validation rejects source mismatches and assistant-only
claims about the human. Weak memory matches below 0.40 are excluded, and the
observed 0.60-confidence background thoughts are now eligible. Verified
capability and per-turn provenance records replace blanket secrecy: Audrey
should not volunteer internals, but a direct question must receive a truthful
answer. Focused typecheck and 15 tests pass; live latency and behavioral
scenario results remain the promotion gate.

### 2026-08-30 — Persona prepared replies, provenance, and stateful scenarios

The first stateful persona corpus turned the live observations into seven
sanitized linked scenarios: memory truth, a garbled DeepSeek reference, creative
generation plus provenance and criticism, grounded async memory, a correction
overriding stale memory, emotional open-loop continuity plus distraction, and
the speech-only sensory boundary. Every scenario instantiates the production
`PersonaConversation`, memory runtime, streaming callbacks, chronological hot
history, and ASR-style partial revisions. The coordinator and all real user
sessions remain outside this suite.

The initial four-of-seven pass showed that a good DeepSeek interpretation could
still be lost in a second Celeris rewrite. The planner now streams a complete
candidate first and, when enabled, the harness speaks a safe candidate directly.
Ordinary DeepSeek draft availability measured about 1.4–2.3 seconds during
simulated speech; once prepared, endpoint response measured 0–5 milliseconds.
Ordinary Celeris fallbacks measured roughly 110–575 milliseconds. Direct typed
answers for generation provenance and the verified DeepSeek Flash alias remove
two recurring small-model truth failures.

Single creative candidates were not robust: DeepSeek and Celeris both produced
stock scarecrow or library jokes, alleged trivia, and fabricated first-person
anecdotes. Creative planning and adviser fallback now generate three candidates;
the harness rejects known templates, factual framing, invented experiences, and
answers over fifty words. The original ASR transcript controls classification so
a Celeris tool paraphrase cannot erase a word such as “distract.” Three linked
creative runs passed after this change. Directly speaking creative planner
drafts proved unsafe when a later probe presented purported animal trivia as a
joke, so those requests now always use the bounded candidate race. Ordinary
prepared replies retain the 0–5 millisecond endpoint path. Adviser fallbacks have an
immediate hold line and usually completed in about 2–4 seconds, but one Pareto
tail reached 19 seconds. A later hot-path experiment raced structured DeepSeek
advice against a separate three-candidate Celeris pass and capped the adviser at
six seconds. After adding the same grounding and novelty filter to both sides,
the Celeris fallback won three of three linked creative runs in 402–956
milliseconds total, including the initial tool-routing round; typed provenance
correctly identified the fast background candidate. The slower asynchronous
memory-analysis timeout remains separate.

Explicit preference corrections and selected emotional open loops now expose a
required lexical anchor to the hot path. A Celeris fallback is buffered and
retried once if it omits that anchor. The stale espresso correction passed three
of three runs at 291–489 milliseconds, and the presentation or distraction flow
passed three of three linked runs after the anchor and creative-safety changes.
Memory capability or provenance passed two of two linked runs. Promotion still
requires one final full-corpus pass, clean typecheck and build, and the complete
unit suite before deployment.

The promotion run completed with all seven stateful scenarios passing and no
invalid trials. Prepared ordinary replies completed in 0–2 milliseconds at the
endpoint, ordinary Celeris replies in 147–487 milliseconds, and the bounded
creative/distraction race in 613–684 milliseconds after its immediate hold
line. Typecheck and build were clean, and all 180 unit and integration tests
passed. The next corpus expansion should emphasize longitudinal friendship:
subtle preference callbacks, resolving emotional open loops, sparse memory use,
initiative without constant questions, and refusing invented shared history.

### 2026-08-30 — Broader companion continuity corpus

Five non-work companion scenarios expanded the corpus beyond creative prompts:
a subtle preference callback, restraint with an irrelevant real memory,
resolution of an anxious interview thread plus its Friday follow-up, refusal of
invented shared physical history, and low-energy initiative without turning the
reply into an interview. The first baseline passed ten of twelve. It either
ignored the useful rainy-Sunday detail or forced unrelated pottery into a tired
work-call response; it also varied between preserving the interview and its
new Friday next step.

Retrieved records now retain their similarity score. The hot context excludes
scored memories below 0.55 even though the database's broader candidate floor
remains 0.40. High-confidence relevant preferences derive a canonical callback
anchor, while DeepSeek emits its own typed memory decision before the candidate.
The voice layer preserves every applicable memory and schedule anchor, validates
prepared drafts against them, and uses a short grounded repair prefix only after
three model misses. False shared physical memories use a deterministic truthful
response, and the async extractor is explicitly told that questions and denied
premises are not evidence. The eval matcher now uses token boundaries rather
than allowing accidental substrings such as `rain` inside `train`.

Targeted callback and open-loop tests each passed three of three after the
change. The complete twelve-scenario promotion corpus then passed twelve of
twelve with no invalid trials. In that run, prepared ordinary turns completed
in 3–8 milliseconds, normal Celeris turns in 141–404 milliseconds, the open-loop
composition in 364 milliseconds, and the bounded creative path in 589
milliseconds after its immediate hold line. All 181 unit and integration tests,
typecheck, and build passed before promotion.

### 2026-08-30 — Longitudinal rhythm, cold recall, and delayed playback

A retained live exchange separated three new failure classes. A short direct
name question reached endpoint before memory prefetch and Celeris falsely denied
the known fact. A mechanism question confused a phonetic DeepSeek Flash alias
with a visual effect, and a creative provenance question denied real background
help. The latter two already had deterministic typed fixes in the pending
deployment. The name case revealed the remaining timing hole: its retrieval
completed about 119 ms after endpoint, too late for the frozen context.

Explicit personal-recall questions now get one bounded cold lookup of at most
250 ms when partial prefetch missed; ordinary conversation remains nonblocking.
A sanitized cold-name scenario returned the selected name in 399 ms instead of
denying it. Three linked memory/provenance runs then passed, with the first turns
at 193–503 ms and typed follow-ups at 0–3 ms. The memory-analysis prompt now
requires explicit names, preference changes, dated follow-ups, and new open
loops; the resolved-interview flow retained its Friday next step in three of
three runs.

The same live trace proved the delayed creative answer was a playback bug, not
model latency. The 37-character hold line began in 45 ms and produced 2.16
seconds of audio, then Discord went idle. The adviser completed at 3.56 seconds
and Pocket still rendered 8.08 seconds of final audio in 1.33 seconds, but that
audio was appended to the already-dead resource and never played. Staged speech
now creates and awaits a fresh Discord resource for every coalesced batch. This
retains streaming within each batch and makes the final answer independently
auditable in `conversation.assistant.playback_started`.

Five new sanitized scenarios expanded the corpus to seventeen: cold recall, a
five-turn friendship rhythm, one-time background-thought use, preference
evolution, and kind disagreement. The evaluator now scores aggregate question
frequency, consecutive question runs, and repeated three-word openings. A
four-reply rhythm guard asks for a declarative contribution after repeated
questions or a short acknowledgment, while direct contribution requests cannot
be replaced with a question. The five-turn exchange passed with zero questions
after acknowledgments and 136–564 ms model times. The background thought was
used specifically and disappeared on the unrelated next turn in three of three
linked runs; one prepared reply completed in 1 ms. A full sweep reached sixteen
of seventeen; its only miss was an intentionally corrected lexical overfit that
rejected an otherwise clear “world-class hermit” disagreement for omitting an
arbitrary noun.

The next full sweep exposed a real longer-flow failure: an ordinary reflective
turn selected the optional adviser, and the parallel Celeris candidate pool
ended partway through its third JSON string. The old parser treated that raw
envelope as a spoken candidate. Candidate parsing now recovers only complete
closed strings, the pool budget is 384 tokens, and the final speech gate rejects
all raw structured payloads. The five-turn flow then passed three of three runs.
The final complete sweep passed all seventeen scenarios with no invalid trials:
median endpoint generation was 175 ms, p95 746 ms, and maximum 808 ms. The full
188-test unit and integration suite passed, and typecheck, build, and diff checks
were clean before promotion.

### 2026-08-30 — Live companion audit and provider comparison seam

Fifteen retained phone turns showed that the transport path is no longer the
dominant problem. Ten Smart Turn endpoints reached first Discord audio in
roughly 281–588 ms after speech ended. Five semantic fallbacks took roughly
750–941 ms because they still paid the 350 ms merge grace. ASR final drain was
48–110 ms and Pocket first audio was 41–60 ms. The creative answer text was
ready about 807 ms after endpoint, but the 2.16-second hold line delayed its
second audio resource until roughly 2.95 seconds. The new independent resource
did play the final answer, confirming the prior playback-lifetime fix.

The same trace falsified the assumption that Pareto turn planning was helping
ordinary live replies: zero of fifteen snapshots had a partial or complete hot
plan. Serialized post-turn reflection did run, varying from about one second to
more than fourteen seconds. Database inspection found three precision failures:
an ambiguous “a decent memory” fragment became a user fact, fictional joke
material became a shared episode, and latency feedback became a durable fact.
Several short-lived thoughts explicitly encouraged another question or evasion,
which matched the passive interview-like replies heard in Discord.

The harness now rejects those memory and thought classes locally, shortens the
creative hold to “One second,” retains exact background provenance for direct
DeepSeek follow-ups, and configures production's fallback merge grace at 150 ms.
The immediate persona backend also gained provider-neutral runtime settings and
an exact OpenRouter provider pin. A first free Gemma 4 31B scenario was invalid:
Google AI Studio's shared free pool returned HTTP 429 on all requests. That run
exposed and fixed an evaluator bug where the local recovery phrase could satisfy
weak turn assertions; chat transport failures now invalidate the whole scenario.
Retry the free route after the upstream shared-pool limit clears before drawing
any quality conclusion.

The paid same-weight comparison separated output quality from provider speed.
Gemma through ModelRun and Cerebras each passed the full seventeen-scenario,
twenty-seven-turn corpus once. ModelRun's run had 349 ms median total model time,
1.315 s p95, and 1.613 s maximum. Cerebras had 277 ms median, 922 ms p95, and one
6.444 s creative-race outlier. Qualitatively, Gemma more often contributed a
specific image, opinion, or concise disagreement than Celeris and was less prone
to paraphrasing the human or conducting an interview. It still produced an
occasional needless question, mechanical memory receipt, familiar joke, or
unsupported confidence claim, so the same local gates remain necessary.

Completion throughput was the wrong live comparison. After instrumenting the
first complete segment handed to TTS, three runs of the same five-turn friendship
flow produced fifteen samples per provider. Celeris measured 164 ms median and
297 ms p95; Gemma ModelRun measured 298 ms median and 532 ms p95; Gemma Cerebras
measured 324 ms median and 688 ms p95. Maxima were 346 ms, 1.434 s, and 1.413 s
respectively. ModelRun therefore beat Cerebras on the voice-critical metric while
also costing less, despite Cerebras's much higher advertised output throughput.

For inexpensive development fallback, CoreWeave was rejected after three
consecutive ten-second conversation timeouts. DeepInfra Turbo passed the same
five-turn flow; its first TTS-ready segments ranged from 293 to 1,443 ms and all
answers passed. The operational policy is free Gemma for bulk development,
explicit DeepInfra Turbo reruns when the free shared pool returns 429, and only a
measured low-TTFT provider for real speech. Automatic OpenRouter fallback remains
disabled so cost and latency cannot change invisibly.

The final Celeris promotion sweep passed every quality assertion in all
seventeen scenarios. Sixteen scenarios completed in the main run; one Pareto
post-turn analysis exceeded its thirty-second transport deadline and was
correctly classified as invalid rather than a quality failure, then passed on
an isolated retry. Across the main run's twenty-seven spoken turns, first
TTS-ready text measured 159 ms median, 524 ms p95, and 680 ms maximum. Total
conversation generation measured 170 ms median, 553 ms p95, and 701 ms maximum.
The complete suite passed 194 tests with clean typecheck, build, and diff checks.
