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
sherpa-onnx TTS -> Discord voice. Coordinator actions return immediately;
Celeris never waits for a coding agent to complete work before acknowledging it.

The bundled runtime models are the int8 0.6B Nemotron English streaming
transducer with 560 ms chunks and Piper US English Lessac medium. Both run on
CPU through `sherpa-onnx-node`; model
archives and checksums belong in the container build, never in git. TTS progress
chunks stream into Discord as they are generated; do not regress to buffering a
complete utterance before playback. Each Discord utterance also owns a live ASR
stream: decoded 16 kHz packets are accepted and decoded while the caller is
still speaking, and end-of-turn performs only right-context padding and a final
drain. Do not regress to accumulating the full waveform before recognition.
Piper replaced Kokoro because same-host measurements reduced first TTS audio
from roughly 0.9-1.2 seconds to 35-52 ms and full generation from 2.2-3.5
seconds to 87-190 ms for short voice replies.

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
polling continues. Adjacent recognized segments are joined for
`DISCORD_UTTERANCE_MERGE_MS` (default 350 ms) before one model turn, preventing
natural pauses from superseding half an utterance. Only explicit cancel
language interrupts the focused running Omnigent session.

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
One plain `session_output` message up to 240 characters and three lines is
spoken directly with its session name in zero model rounds. URLs, code fences,
longer output, and multi-event batches still use Celeris adaptation.
`waiting_for_input` is a
voice-facing filter for a nonzero pending-elicitation count, not an Omnigent
status (the native statuses are `idle`, `running`, `waiting`, and `failed`).

Celeris owns the low-latency conversation and uses its OpenAI-compatible native
tool-call shape to invoke a real MCP client/server pair connected in memory.
For successful `send_message`, `focus_session`, `start_session`,
`rename_session`, and `archive_session` results with no concurrent updates, the
harness renders deterministic natural receipts from typed fields and skips the
second Celeris request. This includes a compound model response when every tool
call has a verified renderable action result. If one call fails, verified
receipts for the other completed actions are spoken before the deterministic
failure. Do not weaken the success predicates or drop the updates-empty guard:
reads, uncertain results, and composites containing a non-renderable result
still need model synthesis.
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
Notification history records are authoritative for resolving “that one,” “the
first one,” and “the other one”; a read copies the referenced notification's
session ID rather than substituting sticky focus. A changed `output_delta`
directly answers “what's new” and “since then” without an older-output read.
ASR discourse repairs such as “no wait” do not select queued delivery; only an
explicit request to queue or wait for the current turn does. For a true output
visibility check, the response combines the action ledger's delivery evidence
with whether the sent user item appears in the read result.
The voice harness removes `send_message.session_id` from the model-visible
schema. Messages default to the focused session; when one known destination is
explicitly named, deterministic grammar resolves its server-owned ID and the
harness injects that target without changing focus. Multiple direct
destinations fail closed. When a message depends on another session's output,
Celeris must read that source before sending unless the human already supplied
the finding in the current request. The harness also withholds and rejects
`focus_session` unless the current transcript explicitly requests a
switch/select/open/focus action or an ordinal selection. This is a runtime
safety guard in addition to the prompt; ordinary latest/current-output language
cannot mutate focus. Conservative name-token matching also withholds
`focus_session` when the requested target is already focused. One explicitly
named focus target is resolved against `known_sessions`; the model-visible
schema omits the opaque ID and the harness injects the authoritative value even
if Celeris emits a malformed one. Multiple named targets without a clear
destination fail closed. The harness
withholds `check_updates` from the voice model because it calls that tool
atomically before constructing every turn and later tool results carry updates.
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
wait until the current session turn becomes idle.
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
spoken name. Successful resolution removes the prompt before the result is
returned and the action ledger becomes authoritative for later verification.
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
inference frame takes roughly 617 ms to compile/initialize; `KameS2SRuntime`
therefore sends and discards 20 silent frames before the Discord bot connects.
Do not remove that startup warmup or expose its output to callers.

The guided native experiment is implemented behind `VOICE_RUNTIME=kame`; the
default remains `staged`. `native/moshi-kame.patch` adds KAME's oracle embedding
and one-token-per-frame queue to pinned `Codes4Fun/moshi.cpp`, while
`native/kame_bridge.cpp` exposes raw 24 kHz float32 audio over stdin/stdout and
guidance/events on descriptors 3/4. `src/s2s.ts` owns the subprocess and
`src/discord.ts` clocks 80 ms full-duplex frames while the existing local ASR
runs in parallel. Celeris tool results replace oracle guidance; KAME's generated
text and rolling frame tails are retained in structured runtime logs. Model
weights remain external runtime mounts. See `docs/S2S.md`.

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
