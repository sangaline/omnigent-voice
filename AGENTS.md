# Omnigent Voice

Minimal, speech-only Discord interface for an existing Omnigent deployment.

## Invariants

- The public repository and container image contain no credentials, account IDs,
  channel IDs, personal paths, private hostnames, or deployment-specific defaults.
- Secrets and deployment configuration enter only through runtime environment
  variables. Never use Docker build arguments for secrets.
- The deployed application is one outbound-only container. It exposes no HTTP
  service and needs no Kubernetes Service or Ingress.
- Treat the coordinator tools as remote-code-execution authority: messages can
  cause coding agents to run commands. The voice runtime must use only its
  in-process MCP transport, and the standalone server must remain stdio-only.
  Never add a public listener, Service, Ingress, or unauthenticated remote MCP
  transport. Any future network transport requires an explicit security review,
  private reachability, strong user authentication, narrow authorization, and
  auditable caller identity before it is enabled.
- Keep the interaction voice-first: no web UI, buttons, menus, or required slash
  commands.

## Architecture

Discord voice receive -> local sherpa-onnx streaming ASR -> Celeris conversation
layer -> direct spoken reply or small Omnigent MCP coordinator tools -> local
Pocket TTS -> Discord voice. Coordinator actions return immediately;
Celeris never waits for a coding agent to complete work before acknowledging it.

The bundled runtime models are the int8 0.6B Nemotron English streaming
transducer with 560 ms chunks, dynamically quantized Pocket TTS 3.0.2 with the
public `alba` voice, and Piper US English Lessac medium as a fallback. The public
image deliberately uses `kyutai/pocket-tts-without-voice-cloning`; it cannot
clone a new voice. The full gated Pocket checkpoint can condition on a private
audio prompt, but those weights and any derived voice state must enter through
private runtime storage rather than the public image. Speech models run on
CPU; ASR and Piper use `sherpa-onnx-node`, while Pocket stays warm behind a
private stdio Python bridge. Model
archives and checksums belong in the container build, never in git. TTS progress
chunks stream into Discord as they are generated; do not regress to buffering a
complete utterance before playback. Each Discord utterance also owns a live ASR
stream: decoded 16 kHz packets are accepted and decoded while the caller is
still speaking, and end-of-turn performs only right-context padding and a final
drain. Do not regress to accumulating the full waveform before recognition.
Pocket is the staged deployment default because it retains Piper-class first
audio latency with a substantially more natural voice. The exact stripped
container loaded and warmed Pocket in about 5.05 seconds, produced first audio
in 34 ms, and generated 3.28 seconds of audio in 437 ms across 41 chunks.
Startup is outside the live turn path. Three 3.28-4.08 second intelligibility
probes generated in 0.51-0.68 seconds and were independently recognized by the
bundled Nemotron model with only two minor word omissions. Returning `false`
from the Discord chunk callback sends a real cancellation to the warm bridge;
do not regress to rendering an unheard long reply before accepting the next TTS
request. Piper remains selectable with `TTS_RUNTIME=piper`.

Production Celeris requests use OpenAI-compatible SSE whenever the round is not
forcing a named tool. Complete natural speech segments are queued into one
continuous Discord/Pocket stream, so the first segment may synthesize while a
conventional autoregressive provider is still generating later text. Celeris-1
itself is a diffusion model and currently returns its whole completion in one
burst: a live 279-character probe delivered the first speech segment at 474 ms
and completed at 475 ms. Its SSE support therefore provides protocol symmetry,
not token-level overlap. Do not add fake typing delays or wait to synthesize the
whole assistant response after that burst. Named tool forcing stays buffered
because Celeris rejects forced tools on streaming requests. Startup sends the
documented authenticated `/echo` warmup with a five-second best-effort timeout;
it invokes no model and establishes the network connection before the caller's
first turn.

Nemotron replaced the smaller 80 ms NeMo fast-conformer after the live Discord
transcript showed severe omissions and substitutions. On the host, the 560 ms
int8 model loaded in about 1.24 seconds at roughly 951 MiB RSS, decoded bundled
samples at about 0.08 realtime, and flushed final tokens in about 42 ms. Its
chunk latency is overlapped with live speech. The verified model archive is
463,945,051 bytes; accuracy must be judged through live phone tests because the
formal bundled samples were transcribed correctly by both models.

The bot auto-discovers its voice channel only when exactly one accessible guild
and voice channel exist. Explicit runtime IDs override discovery. Discord's raw
speaking event does not stop playback; decoded audio must cross
`DISCORD_BARGE_IN_PEAK` (default `0.08`). This rejects the short low-energy
phone echo bursts that previously cut speech off mid-word. Confirmed human
speech stops playback and cancels further TTS generation, but backend output
polling continues. A Discord receive stream remains provisional until decoded
audio crosses `0.002` peak amplitude. Zero-energy tail streams therefore never
clear a ready transcript timer or count as active recordings; live logs showed
that the old behavior added 710-770 ms after otherwise completed turns. Keep
the provisional receive subscription alive for its normal silence lifetime so
real speech arriving on it can still activate the existing ASR and barge-in
path. Semantic endpointing is enabled by default. Silero VAD
observes the live 16 kHz stream and proposes an endpoint after 180 ms of
silence; Smart Turn v3.2 classifies up to the latest eight seconds of the raw
current-turn waveform. A complete decision closes the live ASR stream
immediately, while an incomplete or failed decision keeps listening until the
700 ms hard fallback. New speech invalidates an in-flight decision and the
full updated turn is classified after the next pause. This replaces the staged
450 ms capture stop plus 350 ms transcript merge; when semantic endpointing is
disabled, those legacy settings remain available. Only explicit cancel
language interrupts the focused running Omnigent session.

Smart Turn runs as a persistent local Python bridge inside the same container,
using its 8.7 MB int8 ONNX model and Pipecat's NumPy-only Whisper feature
extraction. The exact container measured 37.7 ms mean, 47.1 ms p95, and 47.7 ms
maximum across twenty complete decisions on the host. A full fixture scored
0.957 complete while a mid-sentence cut scored 0.490. Silero and Smart Turn
model downloads are checksum-pinned in the image build. Never log retained raw
endpoint audio.

Omnigent auth uses a runtime refresh token. At boot, the coordinator focuses the
most recently active native session but does not create one. Focus is sticky:
reading or listing sessions never changes it, and `focus_session` is only for an
explicit user-requested switch. Every coordinator result includes the focused
session, and send acknowledgements include their actual target session.
Starting or explicitly focusing a session records the prior focus in a bounded
server-owned stack. Archiving the focused session restores the newest still-valid
prior focus, falling back to the most recently active unarchived session. The
archive result identifies both the archived and newly focused sessions, and the
voice layer must speak that transition rather than relying on model memory.
Every result also includes the last five entries from a bounded server-owned
`recent_actions` ledger. It records exact outbound message text and target,
delivery mode, focus changes, starts, archives, and prompt resolutions with a
preformatted summary. This is authoritative after Celeris history compaction;
absence from short spoken history is never evidence that an action did not
happen. Action summaries are retained in the private JSONL audit log.

The coordinator polls recent session summaries and stable conversation items
every two seconds, including while the human is speaking. At ASR finalization,
`check_updates` atomically drains the focused session's cursor-backed output
delta into the model context. Output arriving later remains buffered for the
next turn. Persisted conversation items exclude transient terminal animations.
Completion, failure, new-decision, and stable assistant-progress events remain
in a bounded replay log. A running monitored session emits `session_output`
only when a newly persisted assistant message appears; tool-only terminal
activity does not interrupt the user. If the same poll also detects completion,
failure, or a decision, that lifecycle event owns the accumulated output so it
is not announced twice.
Every tool result includes only this MCP connection's unread `updates` plus an
`update_cursor`; `check_updates(after_event_id)` can replay from an explicit
cursor for clients without notifications. A cursor beyond the current process
or older than the retained window sets `update_cursor_expired` and returns the
available window. Events are never globally drained by one caller.
When the channel is idle, those real events are sent to Celeris without tools
and spoken proactively; a human turn takes priority and receives any unspoken
event in its frozen context. The voice consumer advances its event cursor only
after proactive playback completes.
One plain `session_output` message or `session_completed` summary up to 240
characters and three lines is spoken directly in zero model rounds. This keeps
short proactive facts exact instead of risking lossy paraphrase. Bounded batches
of up to three structured `decision_needed` events are also rendered directly
from their prompt messages: confirmation mode says “needs your approval,” while
other modes say “needs your input.” URLs, code fences, longer output, and other
multi-event batches still use Celeris adaptation.
One safe short `session_completed` summary may be combined directly with that
bounded decision batch, preserving both the completed session's exact outcome
and every structured prompt field without a model round.
When a coordinator-managed queued message leaves the queue, the coordinator
emits `message_delivered` only after the backend accepts the send. A lone event,
or a bounded pair with the same session's prior-turn completion, is rendered
directly in zero model rounds so speech preserves both the prior outcome and the
fact that the queued message was actually sent. The same direct path may append
a bounded unrelated `decision_needed` prompt, preserving the dispatch and the
new approval request without trusting a lossy model paraphrase. The complete
speech must fit 300 characters; unsafe or longer batches fall back to Celeris.
The action ledger records the
same dispatch as `message_sent` with `delivery: queued_after_turn`; an immediate
delivery audit and current-focus question is answered from that typed evidence.
`waiting_for_input` is a
voice-facing filter for a nonzero pending-elicitation count, not an Omnigent
status (the native statuses are `idle`, `running`, `waiting`, and `failed`).

Celeris owns the low-latency conversation and uses its OpenAI-compatible native
tool-call shape to invoke a real MCP client/server pair connected in memory.
For successful `send_message`, `focus_session`, `start_session`,
`rename_session`, `archive_session`, and `answer_prompt` results with no
concurrent updates, the
harness renders deterministic natural receipts from typed fields and skips the
second Celeris request. This includes a compound model response when every tool
call has a verified renderable action result. If one call fails, verified
receipts for the other completed actions are spoken before the deterministic
failure. A compound turn that combines those action results with one safe,
short assistant `latest_message` from `get_output` is also rendered directly:
the typed action receipt is followed by a named session update, reducing the
turn from two model rounds to one. The current turn's typed action receipt
becomes `last_verified_action_outcome` even when another read still needs model
synthesis, so a follow-up audit cannot repeat a stale older action. Do not
weaken the success predicates or drop the updates-empty guard: unsafe reads,
uncertain results, and composites containing a non-renderable result still need
model synthesis.
Every tool-using turn also records `last_verified_tool_workflow`, an ordered,
process-local list of successful named reads and typed actions. It contains no
opaque IDs. The next model turn uses it to answer whether two sources were
actually read before a send; a new read is never evidence about prior ordering.
The action ledger remains the durable authority for what exact message was sent.
Immediately before every human message, the harness inserts a current-turn
action invariant: no coordinator action has happened yet, requested actions and
required reads must use a tool before speech, prior ledger entries do not satisfy
new/retry requests, and promises or success claims without a later successful
tool result are forbidden. Keep this reminder adjacent to the human turn; the
same rule in the longer base prompt was not salient enough when the model copied
a prior send acknowledgement instead of making a second tool call. Celeris runs
at temperature 0 with seed 7 so prompt replay and action selection are stable.
The base prompt also resolves replies to proactive notifications against the
notified session and requires an immediate read when a prior answer was empty or
incorrect. The adjacent current-turn reminder makes two additional semantics
explicit for the small fast model: a follow-up to a spoken notification reads
the session id embedded in that notification without changing sticky focus, and
a correction that a requested send was missing repeats `send_message` rather
than substituting an output read. Celeris must not invent missing context or
access as the cause of a prior bad answer; when no exact cause is established it
states only that it misinterpreted the available data.
`send_message` creates a user-role item in Omnigent. For normal relays Celeris
preserves the human's intent, but a report about the voice interface's own
mistake must explicitly name “the voice coordinator” and distinguish the human;
an unqualified first-person self-report is forbidden because the destination
would attribute it to the human. An attribution correction ending in “do you
get what I mean” is an understanding check, not permission to promise or perform
another send. A later explicit send request still requires the real tool.
After a generic coordinator failure, a short “try again” or unique short session
name inherits the nearest failed read operation and target from recent raw
dialogue. For that narrow retry turn the harness injects the server-owned read
target and withholds `send_message`, preventing an older successful send from
resurfacing. Failed send retries do not take this path. A successful read of a
clarified or nonfocused session names its typed target in speech and never
changes sticky focus.
Notification history records are authoritative for resolving “that one,” “the
first one,” and “the other one”; a read copies the referenced notification's
session ID rather than substituting sticky focus. The harness enforces this
outside the model: a read-shaped follow-up after one spoken notification hides
the opaque ID and injects the notification's recorded target even if Celeris
emits sticky focus. Ordinals resolve against notification order. An unqualified
read after multiple notifications returns an immediate zero-round clarification
that names the candidates; it never guesses or offers a read tool. A changed `output_delta`
directly answers “what's new” and “since then” without an older-output read.
For a plain current/latest/progress question with no concurrent update, pending
decision, or action language, the harness voices a short safe focused-session
`output_delta` directly in zero model rounds. An explicit switch to the session
that is already focused is likewise a typed zero-round receipt. These paths must
remain narrow: compound or ambiguous turns still go to Celeris.
A model-selected `get_output` for a plain non-mutating latest/status/progress
question similarly voices one safe short assistant `latest_message` directly
after the read, skipping the second Celeris round. An explicit question about a
newer message from the human may copy a safe typed `role: user` latest message.
This direct path is disabled for send, queue, focus, archive, approval, retry,
and other compound action language.
Imperative pronoun follow-ups after a spoken notification burst are also
resolved by the harness. It preserves notification order since the last human
turn, maps “first,” “second,” “third,” and “last” to the corresponding
server-owned session ID, and injects that target into `send_message` while
sticky focus remains unchanged. An unqualified “that one” after multiple
sessions fails closed instead of guessing; once another human turn intervenes,
the narrow deterministic reference expires.
ASR discourse repairs such as “no wait” do not select queued delivery; only an
explicit request to queue or wait for the current turn does. For a true output
visibility check, the response combines the action ledger's delivery evidence
with whether the sent user item appears in the read result.
The voice harness removes `send_message.session_id` from the model-visible
schema. Messages default to the focused session; when one known destination is
explicitly named, deterministic grammar resolves its server-owned ID and the
harness injects that target without changing focus. If the human gives a clear,
separate instruction to each of several known destinations, the voice schema
exposes only those names as a required enum and the harness resolves each to a
server-owned ID, deduplicates attempts, and requires every destination before
speech. Merely mentioning several sessions without one clear instruction per
target still fails closed. `queue` is message-action language too: ASR phrasing
such as “when Side Worker wraps this one, queue it to …” receives the same named
ID injection instead of silently defaulting to sticky focus. When a message
depends on another session's output,
Celeris must read that source before sending unless the human already supplied
the finding in the current request. A `send_message` emitted in the same model
completion as any output read is never executed because those results could not
have informed it; the harness returns a typed deferral and forces a grounded send
on the next round without repeating the reads. For an explicit multi-source
comparison, an outbound message that omits any successfully read source name is
also withheld and retried with the missing names. Clear dictated forms such as
“queue it a message to …” and “tell Side Worker to …” copy the exact task clause
into `send_message` when no read participated, stripping only separate voice
navigation controls such as “then switch me there” or “don't switch me.” This
prevents the fast model from corrupting or shortening user-supplied work while
leaving evidence-dependent messages model-composed. A read-only question that
names exactly one known session receives the same protection: the model-visible `get_output` or
`poll_output` schema omits `session_id`, and the harness injects the authoritative
ID while focus remains sticky. This prevents malformed or invented read IDs.
The harness also withholds and rejects
`focus_session` unless the current transcript explicitly requests a
switch/select/open/focus action or an ordinal selection. This is a runtime
safety guard in addition to the prompt; ordinary latest/current-output language
cannot mutate focus. Conservative name-token matching also withholds
`focus_session` when the requested target is already focused. One explicitly
named focus target is resolved against `known_sessions`; the model-visible
schema omits the opaque ID and the harness injects the authoritative value even
if Celeris emits a malformed one. Multiple named targets without a clear
destination fail closed. A positive switch to a name absent from the fresh map
forces `list_sessions`; if that result resolves one name, the harness injects
its ID and requires `focus_session` before speech. Task instructions such as
“tell it to focus on the cutoff” do not activate this navigation guard. The harness
withholds `check_updates` from the voice model because it calls that tool
atomically before constructing every turn and later tool results carry updates.
When one utterance explicitly asks both to message a named session and to
switch focus, deterministic speech cannot finish until both actions have been
attempted. If Celeris emits only one, the next round is forced to the missing
tool and verified results accumulate across rounds. Negated focus language such
as “don't switch me” is excluded. This recovery adds a model round only when
the normal one-round compound call is incomplete.
When the previous assistant claimed a send, no retained `message_sent` receipt
exists, and the human makes a declarative correction that the message is
missing, a narrow evidence guard requires `send_message` for the first model
round. It never sends by itself: Celeris still reconstructs the intended
message and the real coordinator must confirm success. Explicit inspection
questions and ledger-backed visibility questions are excluded from this guard.
The ten tools are `list_sessions`, `focus_session`, `get_output`,
`poll_output`, `send_message`, `archive_session`, `rename_session`,
`answer_prompt`, `start_session`, and `check_updates`. `archive_session` is
withheld unless the human explicitly says archive, and its voice-facing schema
can only target the focused session. `rename_session` is likewise withheld
unless the human explicitly asks to rename or call the current session; its
voice schema requires only the new title, the coordinator returns both names,
and focus never changes. General stdio MCP clients may supply a session ID for
either action. `poll_output` accepts and returns an explicit opaque cursor,
returns only stable newer output, and never changes focus. This makes the tool
usable by stateless remote MCP clients; omission returns the bounded buffered
window. `send_message` defaults to
`delivery: immediate`, the Omnigent create-or-steer path; the backend's HTTP
`queued: true` response means asynchronous acceptance, not deferred delivery,
and is exposed as such. `delivery: queued` is an explicit coordinator-managed
wait until the current session turn becomes idle. Successful deferred dispatch
records a `queued_after_turn` action and emits `message_delivered`; a failed
dispatch is put back into the in-process queue and emits no false success.
For clear “start/make/create/open a session to/for …” language, the harness
copies the user's exact task clause into `start_session.instruction`; Celeris
still selects the tool and may choose the title, agent, and workspace.
`get_output` reads `/v1/sessions/{id}/items`; arbitrary tmux scrollback is not
available through the Omnigent HTTP API and must not be implied. It returns a
JSON array instead of flattening the page into text. Page 1 contains the most
recent page of items, but items within every page are returned in explicit
`oldest_to_newest` order so cursor-based incremental updates continue the same
chronology. Every retained item has a one-based position, normalized timestamp,
preformatted age, kind, text, and message role or tool name where applicable.
`latest_message` is the newest conversation message on the most recent page; it is
generic and may be from either role, so consumers must still inspect `role`.
`recent_delivery_visibility` compares the latest server-recorded sent or queued
message for that session with typed user messages on the returned page. Its
status is exactly `visible_on_page` or `not_visible_on_page`; absence from one
page is not a claim about all history or whether the agent replied. The voice
harness renders a visibility-only result directly from this typed field after
Celeris selects `get_output`, avoiding a second model round.
Internal terminal/tool activity remains separate from conversation messages.
Item text is shortened by preserving both its beginning and end, and only
complete items are admitted to the bounded result. The voice client preserves
tool results as valid JSON and structurally compacts oversized strings/arrays
rather than slicing serialized JSON in the middle. Structured MCP
elicitations resolve through their dedicated endpoint and may target a child
session. The coordinator maintains a server-owned `pending_decisions` registry
across all watched sessions. Every snapshot and tool result repeats unresolved
prompts with exact session IDs, prompt IDs, natural-language messages, modes,
and schemas until successful resolution; the decision event carries the same
prompt data. Celeris must copy these opaque IDs, never recreate them from a
spoken name. Form-mode prompts pass their JSON schema to Celeris;
`answer_prompt.answers` must preserve the caller's typed field values.
Successful resolution removes the prompt before the result is
returned and the action ledger becomes authoritative for later verification.
The result includes a typed `target_session`, allowing one or several
successful prompt resolutions to be acknowledged without another model round.
An immediate outcome audit such as “did both actually happen?” repeats only the
last typed receipt and says that the outcomes are recorded; it never calls stale
prompt IDs again.
A stdio MCP entry point is
available with `npm run mcp`; authenticated remote HTTP transport is deliberately
deferred.

Every Celeris turn also receives an explicit context contract. Spoken dialogue
is append-only in the hot path. By default, the harness retains raw dialogue
until 80 messages or 48,000 characters, then uses a tool-free Celeris request
after five idle seconds to compact the oldest prefix. At least 24 recent
messages remain verbatim and the compressed memory is placed before that raw
tail. A new human turn preempts maintenance rather than waiting for it; the
uncompacted history remains usable and compaction is retried after the turn.
The exact thresholds are runtime configurable with the
`CELERIS_HISTORY_*` variables. This gives appended turns a stable prompt prefix
between infrequent compactions, although Celeris does not publicly document a
prompt-cache guarantee. Celeris's live endpoint accepted a measured 12,015-token
probe in August 2026; current primary documentation advertises 131,072 tokens,
while older cookbook pages still show a stale 8,192-token value. Keep the
defaults conservative until long-context latency is measured from real calls.
Working memory is process-local; the full transcript remains durable in the
private JSONL audit log but is not automatically replayed into the model after a
restart. Focused-session state, recent actions, output cursors, and prompts stay
authoritative regardless of conversational compaction.

The process also repeats `last_verified_action_outcome`, a short receipt derived
only from typed tool results, after an action turn. It preserves partial-failure
evidence that cannot appear in the successful-action ledger. An immediate
follow-up asking only which part happened and where the user is is rendered
directly from that receipt plus `focused_session`; visibility checks and new
actions still go through Celeris. A completion containing neither text nor a
valid tool call is retried once because no action ran; a second empty result
fails the turn normally.

The context contract also says that
`output_delta` is only new stable output through speech finalization, and older
output is absent until a tool returns it. Celeris has no page/token introspection
and must never estimate how much context it has or invent an explanation for a
dropped utterance or delay.

Logs are newline-delimited JSON on stdout and, when `LOG_FILE` is configured,
appended to that runtime file. `conversation.user.recognized` contains each ASR
transcript. `conversation.assistant.generated` records the response and whether
it was superseded before playback. `conversation.assistant.playback_started`
records the exact text whose audio actually began and its retry number.
`coordinator.action.recorded` records the exact action summary, including
outbound message text, so delivery claims can be audited after model history is
trimmed. This is
an intentional conversation audit trail and is sensitive private data. Keep the
file on private runtime storage, never add it to an image or repository, and
never log tool arguments, tokens, environment values, or credentials. The
Kubernetes chart mounts a retained PVC at `/var/lib/omnigent-voice` and sets
`LOG_FILE=/var/lib/omnigent-voice/events.jsonl`.

Use `npm run replay -- --log <private-jsonl> --target-time <recognized-event-time>`
to reproduce the first Celeris decision for a late logged turn without touching
Omnigent. Replay instantiates the production `CelerisConversation` and the same
in-process MCP client/tool schemas as the live bot, restores up to 80 dialogue
messages since the last process startup, and substitutes only a frozen
coordinator executor. Pass `--tool-results-file <private-json>` to supply
synthetic coordinator results and continue through as many as five exact
production tool rounds; without a result, the frozen executor returns an error
and the harness exercises its deterministic failure speech. The JSON object
maps each tool name to one result object or an ordered array of results. Compare
the old behavior with `--omit-action-invariant`, or replace the base prompt with
`--system-prompt-file`. Replay output and supplied results are private because
they can include transcripts, session output, and proposed tool arguments;
never commit them.

Use `npm run eval -- --api-key-file <private-key-file>` to run the sanitized
ASR-style corpus in `evals/cases.json`. It uses the same production conversation
and MCP path with a frozen coordinator per case. `--case <id>` selects a case,
`--runs <n>` measures stability, and prompt override flags match replay. HTTP
rate limits and transport failures are invalid trials excluded from the quality
rate; empty model turns remain real failures. Add sanitized held-out paraphrases
before promoting a targeted change.

Use `npm run eval:scenarios -- --api-key-file <private-key-file>` for linked
multi-session flows in `evals/scenarios.json`. One scenario preserves the real
`CelerisConversation`, spoken history, proactive-notification history, and MCP
event cursor across every turn while only swapping deterministic coordinator
snapshots and tool results. This is the regression gate for notification
references, sticky focus, incremental output, explicit focus changes, and
archive restoration. A scenario passes only if every valid turn passes; never
replace it with isolated case invocations when evaluating stateful behavior.
Use `--json --include-trace` only with sanitized or otherwise private scenario
data when raw completion shapes are needed to diagnose an empty model turn.
The frozen coordinator filters `updates` against the MCP consumer cursor on
every call, matching the production server's per-connection replay semantics;
do not reintroduce already-consumed events into later tool fixtures.

The Discord voice channel is currently part of the MVP trust boundary. Before
using a channel with more than one trusted human, configure
`ALLOWED_DISCORD_USER_ID`; do not rely on Celeris to authenticate callers.

## PersonaPlex feasibility experiment

`experiments/personaplex/benchmark_moshi.py` is an isolated measurement harness
for evaluating whether the shared Moshi/PersonaPlex streaming architecture can
meet its 80 ms frame deadline on the Strix Halo `gfx1151` GPU. It is not part of
the production image or Node dependency graph. The benchmark runs current
upstream Moshi in an existing ROCm container, uses real speech, times eager and
HIP-graph modes, and emits sanitized JSON only. Host paths, Hugging Face cache,
and gated model authentication enter through shell variables consumed by
`run-benchmark.sh`; never add them to the repository.

Use public `kyutai/moshiko-pytorch-bf16` as the architecture-equivalent runtime
control before gated PersonaPlex weights. PersonaPlex requires the human to
accept the model terms and authenticate the local Hugging Face cache. Do not
request or print their token. The benchmark auto-detects current Kyutai versus
NVIDIA's vendored PersonaPlex Moshi API; point `PERSONAPLEX_MOSHI_SOURCE` at the
matching official checkout and use `--runtime personaplex` for the gated model.
See `docs/PERSONAPLEX-EXPERIMENT.md` for the decision thresholds and current
measurements.

Measured on the target Radeon 8060S, PyTorch BF16 is 195.969 ms/frame, its best
experimental AOTriton path is 145.876 ms/frame, and PyTorch Q8 is 198.464
ms/frame; none can meet Moshi's 80 ms cadence. Native Vulkan Q4 completes the
full PersonaPlex encode/model/decode loop at 14.871 fps (67.25 ms/frame mean)
and about 7.31 GiB device memory. Tail instrumentation remains required. The
current native backend cannot load cached BF16 voice embeddings on `gfx1151`,
but a WAV voice prompt works. Build the guided S2S experiment on native Q4 and
keep the existing staged voice pipeline selectable until the new Discord loop
is verified end to end.

Native KAME Q4 is faster than that control on the same device: after 20 warmup
frames, 250 complete encode/model/decode frames measured 63.445 ms mean,
64.335 ms p95, 64.597 ms p99, and 65.145 ms maximum (15.762 fps). The converted
GGUF is 4,399,071,712 bytes and must remain an external private runtime mount.
The official safetensors stores attention `in_projs`/`out_projs` separately;
the native patch deliberately supports both that layout and Moshi's fused
projection tensors. A paced public-audio smoke test injected oracle text after
the caller stopped, and both KAME's generated token stream and independent
local ASR recovered the intended guided sentence. Treat this as the native
runtime gate, not as a substitute for a live Discord/phone test. RADV's first
inference frame takes roughly 617 ms to compile/initialize. Twenty frames warmed
the shader but did not reliably prime an immediate first dialogue turn, so
`KameS2SRuntime` sends and discards 64 silent frames before the Discord bot
connects. Do not shorten that startup priming or expose its output to callers.

The guided native experiment is implemented behind `VOICE_RUNTIME=kame`; the
default remains `staged`. Select the runtime once at process startup; never
switch between KAME and staged voices inside a live conversation. In KAME mode,
all Discord output is KAME audio. Piper may generate a hidden input stimulus
for a proactive KAME turn, but that stimulus is never played to the caller and
Piper is not an audible fallback. `native/moshi-kame.patch` adds KAME's oracle embedding
and one-token-per-frame queue to pinned `Codes4Fun/moshi.cpp`, while
`native/kame_bridge.cpp` exposes raw 24 kHz float32 audio over stdin/stdout and
guidance/events on descriptors 3/4. `src/s2s.ts` owns the subprocess and
`src/discord.ts` clocks 80 ms full-duplex frames while the existing local ASR
runs in parallel. Local ASR sees packets immediately, while KAME receives them
through `KAME_INPUT_DELAY_MS` (640 ms by default) so final verified Celeris
guidance arrives before KAME observes the caller endpoint. Celeris tool results replace oracle guidance; KAME's generated
text and rolling frame tails are retained in structured runtime logs. Model
weights remain external runtime mounts. See `docs/S2S.md`.

Native Discord output is fail-closed: all frames are dropped outside a verified
guided transaction, and the gate closes immediately on completion, timeout,
barge-in, abort, or shutdown. Normal completion is eight silent frames. The
10-120 second guidance-length-scaled completion timeout is only a runaway
watchdog; never replace normal endpointing with a fixed response-duration cap.
Every guided transaction owns a fresh Discord raw-audio resource created before
guidance and ended when the transaction settles. `@discordjs/voice` destroys a
playing resource after five missing 20 ms frames, so a process-lifetime resource
cannot survive the gated idle period between responses. Do not regress to one
process-lifetime resource or forward unguided KAME frames as keepalive audio.

Unsolicited coordinator updates retain one audible voice. Local TTS generates a
short input-side question that is fed only into KAME after idle; the user never
hears that trigger. The verified Celeris update is injected while the hidden
input enters KAME. KAME output must cross the speech-energy threshold and then
produce eight silent frames before the event cursor advances. Normal guided
replies are tracked with the same detector for durable playback logs. Merely
accepting oracle tokens is not evidence that Discord received speech.
Proactive KAME output has a five-second speech-start deadline and the same
guidance-scaled completion watchdog once speech begins. If the first hidden-input
turn produces no speech, retry it once with a fresh hidden input. If both
attempts fail, retain and requeue the coordinator event; never advance its
cursor or silently discard it. A human turn may preempt this retry normally.
Proactive delivery is strictly serialized across hidden-trigger synthesis,
guidance, output detection, retry, and requeue. Newly arriving updates remain
pending until the active transaction finishes; neither the KAME settle callback
nor a queue listener may schedule a second oracle turn while one is in flight.
A live contention probe produced three queued audible KAME transactions with no
overlap between their `delivery_started`/`delivery_finished` intervals; the
probe sessions were archived after verification.

The first live phone rollout failed despite earlier proactive probes. Discord
received and ASR recognized three real turns, but the implementation forwarded
KAME's continuous unguided output from startup. Four responses timed out, seven
were interrupted, and 52 input-backlog warnings occurred. The deployment was
stopped. Never cite the earlier proactive probe as a live quality gate.

The post-incident four-turn offline test independently transcribes gated KAME
audio. A 720 ms input delay with a conservative 400 ms simulated guidance cost
passed two sequences totaling seven turns with 77.8-100% guidance-word recall.
A 28-word answer produced 12.8 seconds of audio, ended naturally, and scored
96.4%. A 400 ms delay missed turns and is rejected. Use `npm run s2s:smoke`
inside an isolated GPU runtime with the model path variables; Discord must stay
disconnected during this test. A controlled live phone test remains mandatory.

## Commands

```bash
npm ci
npm run check
npm test
npm run build
npm run eval -- --api-key-file /private/path/celeris-key
npm run eval:scenarios -- --api-key-file /private/path/celeris-key
npm run dev
npm run mcp
npm run s2s:smoke
podman build -t omnigent-voice:dev .
experiments/personaplex/run-benchmark.sh --mode both
```

The final image runs as the unprivileged `node` user. A smoke test should reach
`speech.models.ready`, `coordinator.ready`, and `discord.voice.ready`. The image
publisher intentionally disables provenance and SBOM
attestations because this experiment's Docker Hub page must not expose a source
link or deployment metadata.

## Development rules

- Commit coherent milestones; stage only owned files.
- Maintain the sanitized experiment record in `docs/AUTORESEARCH.md` for
  continuous harness research. Private transcripts and fixtures remain outside
  the repository; only generalized cases and aggregate results may be committed.
- Keep pure state/normalization logic unit tested, but prioritize real voice-loop
  integration.
- Retain conversation transcripts and assistant speech only in the designated
  private runtime JSONL log. Never log tool arguments, configuration values, or
  credentials.
- The Docker Hub image is public but intentionally has no Hub description,
  README sync, source link, author label, or deployment-specific metadata.
- Update this file when runtime assumptions or operational procedures change.
