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
Background events are retained in a bounded log and every result carries an
event cursor. Clients without server notifications can safely poll
`check_updates` with their last cursor; one client reading events does not drain
them for other clients.
Every result also repeats a bounded recent-action ledger with preformatted
summaries. This lets a small model accurately recall message delivery targets
and focus transitions after conversational history has been compacted.
The same server can run over stdio with `npm run mcp`; the voice process uses an
in-memory MCP transport to avoid network latency.

The voice model keeps a large raw dialogue tail. After the configurable working
set reaches 80 messages or 48,000 characters, an idle background request
compresses the oldest dialogue into working memory while retaining at least 24
recent messages verbatim. New speech preempts compaction, so maintenance does
not sit in the conversational response path. Exact transcripts remain in the
private JSONL audit log; model working memory itself resets with the process.

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

## Prompt replay

The private audit log can replay a recognized turn against Celeris without
calling Omnigent or mutating any session. This restores the preceding spoken
dialogue, supplies a fake coordinator snapshot and real tool schemas, then
reports whether the first model response chose speech or a tool. A private
`--tool-results-file` can map tool names to synthetic or previously captured
result objects; when supplied, replay continues through the tool loop and also
reports the final spoken answer. Use
`--omit-action-invariant`, `--action-invariant-file`,
`--system-prompt-file`, or `--system-prompt-suffix-file` to compare prompt
variants. Replay defaults to the runtime's temperature 0 and seed 7;
`--temperature` and `--seed` can compare alternatives.

```bash
CELERIS_API_KEY=... npm run replay -- \
  --log /private/path/events.jsonl \
  --target-time 2026-01-01T00:00:00.000Z \
  --tool-results-file /private/path/tool-results.json
```

The optional result file is a JSON object such as
`{"get_output":{"order":"newest_first","items":[]}}`; use an array when the
same tool is called more than once. Replay output and supplied tool results can
contain private transcript or session text and tool arguments. Keep them local
and never commit copied logs, result fixtures, or reports.
