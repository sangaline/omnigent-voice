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
