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

An optional guided speech-to-speech experiment keeps the same coordinator but
replaces staged playback with native KAME Q4/Vulkan audio. Discord audio is fed
to local streaming ASR immediately and through a short bounded delay before
KAME, allowing verified Celeris results to reach the oracle-text stream before
the model observes the user's endpoint. Native audio is fail-closed outside a
verified response. Set `VOICE_RUNTIME=kame` and mount the required model files
to enable the experiment. `VOICE_RUNTIME=staged` retains the original
ASR/Celeris/Piper path as an immediate fallback. See `docs/S2S.md` for the
native protocol, incident record, and live-test gates.

Structured JSON logs are written to stdout. When `LOG_FILE` is set, the same
events are appended to that file for durable retention. Conversation events
include recognized user transcripts, generated assistant responses, and the
exact assistant text whose audio begins playing. These logs are intentionally
sensitive and belong only on private runtime storage; they are never built into
the image.

The coordinator exposes ten tools: list and explicitly focus sessions, read
recent output, poll only stable new output, send an immediate or deliberately
queued message, archive or rename a session, answer a structured prompt, start
a session, and drain background updates. Focus and a bounded current
name-to-ID map are server-owned state included in every tool result. The voice
harness can route a message to one explicitly named known session without
changing focus; ambiguous destinations fail closed. Archiving a temporary
focused session restores the prior valid focus and reports both sides of the
transition for the spoken response. Renaming reports the old and new names and
does not change focus. Explicit named focus changes are resolved through the
same authoritative map, so the small model never has to reproduce an opaque
session ID and ambiguous targets fail closed.
Background events are retained in a bounded log and every result carries an
event cursor. Clients without server notifications can safely poll
`check_updates` with their last cursor; one client reading events does not drain
them for other clients.
Every result also repeats a bounded recent-action ledger with preformatted
summaries. This lets a small model accurately recall message delivery targets
and focus transitions after conversational history has been compacted.
Unresolved structured prompts are likewise repeated in `pending_decisions`
with their exact session and prompt identifiers until resolution. This lets an
approval arriving on a later utterance target the real prompt without relying
on the model to remember or reconstruct opaque IDs.
Output reads include a typed page-local comparison between the latest recorded
delivery and returned user messages. Visibility questions are spoken directly
from that result after Celeris selects the read, keeping “sent,” “visible,” and
“agent replied” as separate facts.
The same server can run over stdio with `npm run mcp`; the voice process uses an
in-memory MCP transport to avoid network latency.

Successful action receipts for sends, focus changes, starts, renames, and
archives are spoken directly from verified structured tool results when no
background update also needs narration. Multiple action receipts can be
combined when every result is verified; if one action fails, completed actions
are still acknowledged before the failure. This removes a second model request
from common control turns and prevents the fast model from dropping or changing
target names. Composite reads and turns carrying updates still return to
Celeris for natural synthesis.
The most recent verified action receipt is repeated in model context. A narrow
immediate follow-up asking only which part happened and where the user is can be
answered directly from that receipt and current focus, avoiding an unnecessary
model request or output read.

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
completion. Completion, failure, decision-needed, and newly persisted assistant
progress messages can produce a proactive spoken update while the channel is
idle. Tool-only terminal activity is retained for reads but does not trigger an
unsolicited interruption.
One short plain progress message is spoken directly with its session name;
longer, multi-event, code-heavy, or URL-bearing updates use Celeris adaptation.

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
calling Omnigent or mutating any session. It runs the production conversation
class and in-process MCP client, restores the preceding spoken dialogue, and
replaces only the Omnigent coordinator with frozen state and supplied results.
It reports the first model decision, every coordinator call, and final speech.
A private `--tool-results-file` can map tool names to synthetic or previously
captured result objects; without one, an attempted tool receives a controlled
error so the failure path can be evaluated. Use
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
`{"get_output":{"order":"oldest_to_newest","items":[]}}`; use an array when the
same tool is called more than once. Replay output and supplied tool results can
contain private transcript or session text and tool arguments. Keep them local
and never commit copied logs, result fixtures, or reports.

## Harness evaluation

The public `evals/cases.json` corpus contains sanitized spontaneous-speech and
ASR-like interactions derived from observed failure patterns. The evaluator
runs the production conversation class, MCP schemas, prompt assembly, and tool
loop; only Omnigent is replaced by deterministic frozen state and results.

```bash
npm run eval -- --api-key-file /private/path/celeris-key
npm run eval -- --api-key-file /private/path/celeris-key \
  --case retry_missing_send --runs 5
npm run eval:scenarios -- --api-key-file /private/path/celeris-key
```

Prompt override flags match replay. HTTP rate limits and transport failures are
reported as invalid rather than quality failures, while empty model turns and
wrong tool behavior still fail. `evals/scenarios.json` keeps one production
conversation and MCP connection alive across linked human turns and proactive
notifications. It exercises sticky focus, notification references, event
cursors, chronological output chunks, actions during fresh output, named
cross-session sends, structured decisions, rename, compound action receipts,
partial failures, proactive running-session progress, and
archive-to-previous-focus behavior. The longest scenario combines primary,
background, and temporary work over thirteen turns so accumulated state and
references are tested rather than only isolated primitives. A scenario passes
only when every turn passes.
For sanitized diagnostic fixtures, `--json --include-trace` includes raw model
completion shapes so empty or malformed responses can be investigated.
Keys, reports, and cases copied from private transcripts must remain outside the
repository.
