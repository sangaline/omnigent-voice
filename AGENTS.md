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
Completion, failure, and new-decision events remain in a bounded replay log.
Every tool result includes only this MCP connection's unread `updates` plus an
`update_cursor`; `check_updates(after_event_id)` can replay from an explicit
cursor for clients without notifications. A cursor beyond the current process
or older than the retained window sets `update_cursor_expired` and returns the
available window. Events are never globally drained by one caller.
When the channel is idle, those real events are sent to Celeris without tools
and spoken proactively; a human turn takes priority and receives any unspoken
event in its frozen context. The voice consumer advances its event cursor only
after proactive playback completes.
`waiting_for_input` is a
voice-facing filter for a nonzero pending-elicitation count, not an Omnigent
status (the native statuses are `idle`, `running`, `waiting`, and `failed`).

Celeris owns the low-latency conversation and uses its OpenAI-compatible native
tool-call shape to invoke a real MCP client/server pair connected in memory.
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
The voice harness removes `send_message.session_id` from the model-visible
schema so messages can only target the focused session. It also withholds and
rejects `focus_session` unless the current transcript explicitly requests a
switch/select/open/focus action or an ordinal selection. This is a runtime
safety guard in addition to the prompt; ordinary latest/current-output language
cannot mutate focus.
The nine tools are `list_sessions`, `focus_session`, `get_output`,
`poll_output`, `send_message`, `archive_session`, `answer_prompt`,
`start_session`, and `check_updates`. `archive_session` is withheld unless the
human explicitly says archive, and its voice-facing schema can only target the
focused session. `poll_output` accepts and returns an explicit opaque cursor,
returns only stable newer output, and never changes focus. This makes the tool
usable by stateless remote MCP clients; omission returns the bounded buffered
window. `send_message` defaults to
`delivery: immediate`, the Omnigent create-or-steer path; the backend's HTTP
`queued: true` response means asynchronous acceptance, not deferred delivery,
and is exposed as such. `delivery: queued` is an explicit coordinator-managed
wait until the current session turn becomes idle.
`get_output` reads `/v1/sessions/{id}/items`; arbitrary tmux scrollback is not
available through the Omnigent HTTP API and must not be implied. It returns a
JSON array instead of flattening the page into text. Page 1 contains the most
recent page of items, but items within every page are returned in explicit
`oldest_to_newest` order so cursor-based incremental updates continue the same
chronology. Every retained item has a one-based position, normalized timestamp,
preformatted age, kind, text, and message role or tool name where applicable.
`latest_message` is the newest conversation message on the most recent page; it is
generic and may be from either role, so consumers must still inspect `role`.
Internal terminal/tool activity remains separate from conversation messages.
Item text is shortened by preserving both its beginning and end, and only
complete items are admitted to the bounded result. The voice client preserves
tool results as valid JSON and structurally compacts oversized strings/arrays
rather than slicing serialized JSON in the middle. Structured MCP
elicitations resolve through their dedicated endpoint and may target a child
session. A stdio MCP entry point is
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

The Discord voice channel is currently part of the MVP trust boundary. Before
using a channel with more than one trusted human, configure
`ALLOWED_DISCORD_USER_ID`; do not rely on Celeris to authenticate callers.

## Commands

```bash
npm ci
npm run check
npm test
npm run build
npm run dev
npm run mcp
podman build -t omnigent-voice:dev .
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
