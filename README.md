# Omnigent Voice

A minimal speech-only Discord interface for Omnigent. One process receives
Discord voice, transcribes it locally, and uses Celeris as a fast conversational
layer. Celeris answers ordinary turns directly and uses a small in-process MCP
coordinator when a request depends on real sessions or requires agent work.
Work is queued asynchronously, so the spoken acknowledgement does not wait for
a coding agent to finish. Speech is synthesized locally and streamed back into
the same voice channel.

ASR runs incrementally while the caller is speaking. Celeris responses are
currently short batch completions, while low-latency Piper TTS audio is sent to
Discord as the synthesizer produces each chunk.

The project is intentionally narrow: one caller, one focused Omnigent session,
one container, and no text or web interface.

Structured JSON logs are written to stdout. When `LOG_FILE` is set, the same
events are appended to that file for durable retention. Conversation events
include recognized user transcripts, generated assistant responses, and the
exact assistant text whose audio begins playing. These logs are intentionally
sensitive and belong only on private runtime storage; they are never built into
the image.

The coordinator exposes nine tools: list and explicitly focus sessions, read
recent output, poll only stable new output, send an immediate or deliberately
queued message, archive the focused session, answer a structured prompt, start
a session, and drain background updates. Focus is server-owned state included
in every tool result. Archiving a temporary focused session restores the prior
valid focus and reports both sides of the transition for the spoken response.
The same server can run over stdio with `npm run mcp`; the voice process uses an
in-memory MCP transport to avoid network latency.

A native poll loop keeps collecting focused-session output while audio is
playing and while the human is speaking. When recognition finalizes, the model
receives one atomic snapshot of everything collected through that instant.
Later events stay buffered for the next turn rather than changing an in-flight
completion. Completion, failure, and decision-needed events can also produce a
proactive spoken update while the channel is idle.

Discord speaking events alone do not stop playback: decoded audio must cross a
configurable energy threshold, preventing phone echo from truncating speech.
Adjacent ASR segments are merged briefly before the coordinator snapshot so a
natural pause does not become two conflicting model turns.

These tools carry effective remote-code-execution authority through Omnigent.
There is intentionally no network MCP listener, HTTP port, Service, or Ingress.
The stdio transport is for trusted local processes only.

## Development

Requires Node.js 22.12 or newer.

```bash
npm ci
npm run check
npm test
npm run dev
```

Copy `.env.example` to an untracked `.env` for local runs. Speech models are
downloaded separately and addressed through runtime paths; the container build
fetches pinned model artifacts itself.

At startup the bot either uses explicit Discord guild/channel IDs or discovers
them when it can see exactly one guild with exactly one voice channel. Omnigent
host auto-discovery is similarly limited to exactly one online external host;
otherwise set `OMNIGENT_HOST_ID`.

## Container

```bash
podman build -t omnigent-voice:dev .
podman run --rm --env-file .env omnigent-voice:dev
```

The image has no embedded deployment configuration or credentials. See
`.env.example` for the runtime interface. Set `LOG_FILE` to a writable runtime
path to retain the JSONL event log across process restarts.
