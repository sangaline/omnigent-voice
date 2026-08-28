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

The coordinator exposes seven tools: list and focus sessions, read recent
output, send a message, answer a structured prompt, start a session, and drain
background updates. The same server can run over stdio with `npm run mcp`; the
voice process uses an in-memory MCP transport to avoid network latency.

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
`.env.example` for the runtime interface.
