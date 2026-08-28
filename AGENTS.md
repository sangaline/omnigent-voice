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

Discord voice receive -> local sherpa-onnx streaming ASR -> one Omnigent session
-> optional Celeris speech adaptation -> local sherpa-onnx TTS -> Discord voice.

The bundled runtime models are the int8 80 ms NeMo fast-conformer transducer
and int8 Kokoro English v0.19. Both run on CPU through `sherpa-onnx-node`; model
archives and checksums belong in the container build, never in git.

The bot auto-discovers its voice channel only when exactly one accessible guild
and voice channel exist. Explicit runtime IDs override discovery. A new human
utterance stops current playback; only explicit cancel language interrupts the
Omnigent turn.

Omnigent auth uses a runtime refresh token. At boot, the client resolves the
configured agent name and host, creates one host-launched session, opens and
primes the no-replay SSE stream before posting a turn, and reuses that session.
Native Codex sessions may emit an empty `response.completed` before their
assistant transcript is persisted, so the client briefly reconciles the session
snapshot when no streamed output is available.

Celeris is optional and only rewrites long or markup-heavy answers. A failure
falls back to deterministic markdown cleanup. Logs contain timing, character
counts, and event names but never transcripts.

## Commands

```bash
npm ci
npm run check
npm test
npm run build
npm run dev
podman build -t omnigent-voice:dev .
```

## Development rules

- Commit coherent milestones; stage only owned files.
- Keep pure state/normalization logic unit tested, but prioritize real voice-loop
  integration.
- Log timings and opaque operation labels, never transcript contents or secrets.
- The Docker Hub image is public but intentionally has no Hub description,
  README sync, source link, author label, or deployment-specific metadata.
- Update this file when runtime assumptions or operational procedures change.
