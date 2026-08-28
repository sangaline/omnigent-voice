# Omnigent Voice

Minimal, speech-only Discord interface for an existing Omnigent deployment.

## Invariants

- The public repository and container image contain no credentials, account IDs,
  channel IDs, personal paths, private hostnames, or deployment-specific defaults.
- Secrets and deployment configuration enter only through runtime environment
  variables. Never use Docker build arguments for secrets.
- The deployed application is one outbound-only container. It exposes no HTTP
  service and needs no Kubernetes Service or Ingress.
- Keep the interaction voice-first: no web UI, buttons, menus, or required slash
  commands.

## Architecture

Discord voice receive -> local sherpa-onnx streaming ASR -> Celeris conversation
layer -> direct spoken reply or small Omnigent MCP coordinator tools -> local
sherpa-onnx TTS -> Discord voice. Coordinator actions return immediately;
Celeris never waits for a coding agent to complete work before acknowledging it.

The bundled runtime models are the int8 80 ms NeMo fast-conformer transducer
and int8 Kokoro English v0.19. Both run on CPU through `sherpa-onnx-node`; model
archives and checksums belong in the container build, never in git. TTS progress
chunks stream into Discord as they are generated; do not regress to buffering a
complete utterance before playback. Each Discord utterance also owns a live ASR
stream: decoded 16 kHz packets are accepted and decoded while the caller is
still speaking, and end-of-turn performs only right-context padding and a final
drain. Do not regress to accumulating the full waveform before recognition.

The bot auto-discovers its voice channel only when exactly one accessible guild
and voice channel exist. Explicit runtime IDs override discovery. A new human
utterance stops current playback and cancels further TTS chunk generation; only
explicit cancel language interrupts the focused running Omnigent session.

Omnigent auth uses a runtime refresh token. At boot, the coordinator focuses the
most recently active native session but does not create one. It polls recent
session summaries every two seconds and buffers only completion, failure, and
new-decision events. Each tool drains the buffer in an `updates` array, and the
voice harness also drains it between turns. `waiting_for_input` is a
voice-facing filter for a nonzero pending-elicitation count, not an Omnigent
status (the native statuses are `idle`, `running`, `waiting`, and `failed`).

Celeris owns the low-latency conversation and uses its OpenAI-compatible native
tool-call shape to invoke a real MCP client/server pair connected in memory.
The seven tools are `list_sessions`, `focus_session`, `get_output`,
`send_message`, `answer_prompt`, `start_session`, and `check_updates`.
`get_output` reads `/v1/sessions/{id}/items`; arbitrary tmux scrollback is not
available through the Omnigent HTTP API and must not be implied. Structured MCP
elicitations resolve through their dedicated endpoint and may target a child
session. Direct turns keep a small in-memory history. A stdio MCP entry point is
available with `npm run mcp`; authenticated remote HTTP transport is deliberately
deferred. Logs contain timing, character counts, tool names, and event names but
never transcripts or tool arguments.

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
- Log timings and opaque operation labels, never transcript contents or secrets.
- The Docker Hub image is public but intentionally has no Hub description,
  README sync, source link, author label, or deployment-specific metadata.
- Update this file when runtime assumptions or operational procedures change.
