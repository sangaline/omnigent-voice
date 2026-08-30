# Persona mode

Persona mode is a companion-oriented conversational variant of the Discord
voice bot.
It is selected independently from the audio runtime:

```bash
CONVERSATION_MODE=persona
VOICE_RUNTIME=staged
TTS_RUNTIME=pocket
```

It keeps the production streaming path unchanged:

```text
Discord -> local streaming ASR -> Smart Turn endpointing -> OpenAI-compatible persona chat (Celeris default)
        -> streaming local Pocket TTS -> Discord
```

The process does not construct an Omnigent client, coordinator, or MCP client.
There are no coordinator snapshots or external-action tools in Celeris
requests.
Saying `stop` still cancels the current response locally, and ordinary barge-in
continues to abort generation and playback as it does in coordinator mode.

The built-in prompt is deliberately generic and contains no deployment or
speaker identity. Override it at runtime with `PERSONA_SYSTEM_PROMPT`; never
bake a private persona, name, biography, or relationship into the public image.
`PERSONA_MAX_RESPONSE_CHARACTERS` defaults to 420 and
`PERSONA_TEMPERATURE` defaults to 0.4. The harness rejects leaked model control
markers and retries once rather than speaking them.

The hot model is configured through the provider-neutral `PERSONA_CHAT_API_KEY`,
`PERSONA_CHAT_BASE_URL`, and `PERSONA_CHAT_MODEL` variables. Empty values inherit
the existing `CELERIS_*` configuration, so the deployed default remains Celeris
without maintaining a second harness. OpenRouter experiments may additionally
set `PERSONA_CHAT_OPENROUTER_PROVIDER` to an exact endpoint slug; the request
then uses only that endpoint with fallback disabled. Provider keys, routing, and
model names remain runtime configuration and never enter the image.

For OpenRouter development, run the free Gemma route first. Its Google AI
Studio shared pool can return upstream 429s; retry later or explicitly rerun the
same corpus with the paid Gemma model pinned to `deepinfra/turbo`. Do not enable
OpenRouter's implicit provider fallback, and do not use that cheaper, slower
route for live voice. Production speech must pin a provider selected by measured
first TTS-ready segment latency. The current small comparison favored
`modelrun/fp4` over `cerebras/fp16` for that metric despite Cerebras's greater
completion throughput. Celeris remained materially faster than either.

Recent dialogue is retained verbatim and uses the same idle compaction
thresholds as coordinator mode. Persona compaction preserves preferences,
relationships, named topics, commitments, emotional context, running jokes,
and unresolved questions while explicitly forbidding invented events or
biographical facts. Working memory is process-local; the sensitive full audit
trail remains on private runtime storage and is not replayed automatically when
durable memory is disabled.

## Durable companion memory

Set `PERSONA_MEMORY_ENABLED=true` to add a persistent companion-memory layer.
The application stores completed turns and typed memories in a dedicated
Postgres database with pgvector. A local Ollama embedding endpoint handles
semantic retrieval. Live ASR partials start retrieval while the caller is still
speaking; at endpoint the harness takes only the latest completed result and
calls Celeris immediately. One narrow exception prevents a known identity or
preference from being falsely denied: an explicit personal-recall question with
no usable partial may wait up to 250 milliseconds for one cold retrieval. It
still never waits for the conversational adviser.

The same partial transcript starts a DeepSeek context planner after it contains
enough words. Reasoning is disabled for this latency-sensitive job. It streams
a complete Audrey reply first; creative requests add two alternatives. Closed
candidate strings are usable before the whole structured response completes.
With `PERSONA_PREPARED_DRAFTS_ENABLED=true`, the first grounded candidate can be
spoken directly at endpoint without another model call for an ordinary turn.
Creative and entertainment drafts are never spoken directly; they remain useful
planning context for the bounded candidate race. The final transcript
remains authoritative: repairs and meaningful suffix growth reject or restart a
partial plan. Local validation preserves named corrections and emotional open
loops while rejecting fake trivia, invented experiences, familiar joke
templates, and overlong creative replies. If no safe plan is ready, Celeris
continues immediately on ordinary turns.

The ordinary structured plan budget is 192 tokens. This leaves enough room for
the memory-anchor field and closing JSON after a voice-sized draft while still
keeping the completed candidate near the front of the stream.

The typed memory anchor and retrieval score keep memory use selective. Scored
memories below 0.55 are omitted from the hot context. A high-confidence relevant
preference derives one canonical callback anchor, while unrelated memories stay
silent. Concrete next-step days such as Friday are independent anchors, so a
relationship callback cannot erase the user's new schedule. If the small model
drops a verified anchor three times, the harness keeps its useful answer and
adds a short grounded repair prefix. Direct false premises about shared physical
history are refused locally and are not eligible for durable-memory extraction.
Natural punctuation is ignored while checking an anchor, so `bright, crisp
morning` does not trigger a needless retry for `bright crisp morning`.

After Celeris has produced the spoken response, a serialized background worker
sends that completed exchange to the configured OpenAI-compatible adviser. It
extracts explicit durable memories and an optional short-lived conversational
thought. The result is embedded and persisted asynchronously. On restart the
latest spoken turns are restored from Postgres, while older context is selected
through retrieval rather than replaying the full transcript.

The adviser can be a local Ollama OpenAI endpoint or an external provider. An
external provider receives the completed user and assistant text, so treat its
configuration as an explicit privacy decision. Keep its API key in a runtime
secret. `PERSONA_MEMORY_ANALYSIS_MODEL` may use a precise structured-output
model while `PERSONA_ADVISER_MODEL` supplies turn planning and deeper advice.
Only one structured memory analysis request runs per completed turn. Every
memory carries a stable key and an exact quote from its declared source;
runtime validation rejects user facts inferred only from Audrey's wording.
Non-self memories must be grounded in a first-person user quote; assistant-made
fiction cannot become a shared episode, a claimed name must occur in the user
evidence, and transient latency/testing feedback is discarded. Private thoughts
must contribute a concrete observation or callback rather than instructing
Audrey to interview the user, offer memory service, evade a direct mechanism
question, or steer the subject away. Logs retain
aggregate timing and token counts but never the provider request text.

The same adviser is exposed to Celeris through one narrow `ask_adviser` tool.
Celeris answers ordinary turns directly. Explaining or discussing an earlier
joke, story, poem, or roast is ordinary dialogue rather than a new creative
request. A creative or distraction request deliberately enters the bounded
candidate race, even when a planning draft arrived during speech. Creative advice is a
three-candidate structured request, and the first grounded, non-template,
voice-sized candidate streams directly to TTS without a second Celeris rewrite.
The hot path races that request against a separate three-candidate Celeris pass,
selects the first safe result, records which source actually won, and aborts the
loser. It waits 400 ms after routing for a real candidate before speaking the
short hold line, so a fast fallback is not delayed behind acknowledgment audio.
`PERSONA_ADVISER_HOT_TIMEOUT_MS` bounds this caller-facing race without
shortening the asynchronous analysis timeout. The original transcript is
authoritative even when Celeris paraphrases tool arguments. Discord receives
a fresh raw-audio resource for every delayed speech batch. A completed hold line
may go idle normally; when the adviser result arrives, its own resource starts
and is awaited through playback instead of being written into a dead earlier
stream. The tool cannot perform external actions.

The hot conversation tracks rhythm over the latest four Audrey replies. After
repeated question-bearing replies, or after a short acknowledgment such as
“okay,” a per-turn guard asks for a declarative opinion, observation, or thread
rather than another interview question. Direct “give me,” “tell me,” or “what
is your honest read” requests must deliver the contribution instead of handing
the task back to the caller. The shared production-harness scenarios score these
behaviors across linked turns.

The parallel fast fallback requests a small structured candidate pool. If the
provider stops after one or two closed JSON strings, the harness may recover
those complete candidates; the JSON envelope and any unfinished string are
never eligible for speech. Raw structured payloads are rejected by the final
speech gate.

Typed generation provenance records whether background context was merely
available, a prepared DeepSeek reply was actually used, or the adviser produced
the answer. It also retains the exact selected thought, memory text, or draft
process-locally so a specific follow-up can quote what actually reached the last
reply. Immediate questions about the last reply use this record rather than
asking the small model to infer provenance from chat history. Direct and short
pronoun follow-ups about the “deep sea flash” ASR alias receive the verified
DeepSeek Flash name and role. Explicit present-tense corrections and retrieved open loops produce a
required continuity anchor; a Celeris fallback is buffered and retried once if
it omits that anchor.

Required durable-memory variables are listed in `.env.example`. Database,
embedding, and adviser failures are logged without request text or credentials;
the ordinary persona conversation remains usable when a prefetch is late.

Persona mode is not PersonaPlex and does not use the native KAME experiment.
The current variant deliberately keeps the verified staged voice, including a
private Pocket conditioning state when one is mounted. Restore the Omnigent
assistant with `CONVERSATION_MODE=coordinator`; coordinator mode again requires
the Omnigent URL, refresh token, and workspace configuration.
