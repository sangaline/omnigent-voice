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

The bundled runtime models are the int8 80 ms NeMo fast-conformer transducer
and Piper US English Lessac medium. Both run on CPU through `sherpa-onnx-node`; model
archives and checksums belong in the container build, never in git. TTS progress
chunks stream into Discord as they are generated; do not regress to buffering a
complete utterance before playback. Each Discord utterance also owns a live ASR
stream: decoded 16 kHz packets are accepted and decoded while the caller is
still speaking, and end-of-turn performs only right-context padding and a final
drain. Do not regress to accumulating the full waveform before recognition.
Piper replaced Kokoro because same-host measurements reduced first TTS audio
from roughly 0.9-1.2 seconds to 35-52 ms and full generation from 2.2-3.5
seconds to 87-190 ms for short voice replies.

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

The coordinator polls recent session summaries and stable conversation items
every two seconds, including while the human is speaking. At ASR finalization,
`check_updates` atomically drains the focused session's cursor-backed output
delta into the model context. Output arriving later remains buffered for the
next turn. Persisted conversation items exclude transient terminal animations.
Completion, failure, and new-decision events remain buffered in `updates`.
When the channel is idle, those real events are sent to Celeris without tools
and spoken proactively; a human turn takes priority and receives any unspoken
event in its frozen context. Proactive delivery acknowledgement removes the
event only after playback completes.
`waiting_for_input` is a
voice-facing filter for a nonzero pending-elicitation count, not an Omnigent
status (the native statuses are `idle`, `running`, `waiting`, and `failed`).

Celeris owns the low-latency conversation and uses its OpenAI-compatible native
tool-call shape to invoke a real MCP client/server pair connected in memory.
The voice harness removes `send_message.session_id` from the model-visible
schema so messages can only target the focused session. It also withholds and
rejects `focus_session` unless the current transcript explicitly requests a
switch/select/open/focus action or an ordinal selection. This is a runtime
safety guard in addition to the prompt; ordinary latest/current-output language
cannot mutate focus.
The eight tools are `list_sessions`, `focus_session`, `get_output`,
`poll_output`, `send_message`, `answer_prompt`, `start_session`, and
`check_updates`. `poll_output` accepts and returns an explicit opaque cursor,
returns only stable newer output, and never changes focus. This makes the tool
usable by stateless remote MCP clients; omission returns the bounded buffered
window. `send_message` defaults to
`delivery: immediate`, the Omnigent create-or-steer path; the backend's HTTP
`queued: true` response means asynchronous acceptance, not deferred delivery,
and is exposed as such. `delivery: queued` is an explicit coordinator-managed
wait until the current session turn becomes idle.
`get_output` reads `/v1/sessions/{id}/items`; arbitrary tmux scrollback is not
available through the Omnigent HTTP API and must not be implied. Structured MCP
elicitations resolve through their dedicated endpoint and may target a child
session. Direct turns keep a small in-memory history. A stdio MCP entry point is
available with `npm run mcp`; authenticated remote HTTP transport is deliberately
deferred.

Logs are newline-delimited JSON on stdout and, when `LOG_FILE` is configured,
appended to that runtime file. `conversation.user.recognized` contains each ASR
transcript. `conversation.assistant.generated` records the response and whether
it was superseded before playback. `conversation.assistant.playback_started`
records the exact text whose audio actually began and its retry number. This is
an intentional conversation audit trail and is sensitive private data. Keep the
file on private runtime storage, never add it to an image or repository, and
never log tool arguments, tokens, environment values, or credentials. The
Kubernetes chart mounts a retained PVC at `/var/lib/omnigent-voice` and sets
`LOG_FILE=/var/lib/omnigent-voice/events.jsonl`.

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
- Keep pure state/normalization logic unit tested, but prioritize real voice-loop
  integration.
- Retain conversation transcripts and assistant speech only in the designated
  private runtime JSONL log. Never log tool arguments, configuration values, or
  credentials.
- The Docker Hub image is public but intentionally has no Hub description,
  README sync, source link, author label, or deployment-specific metadata.
- Update this file when runtime assumptions or operational procedures change.
