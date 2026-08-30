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
Discord -> local streaming ASR -> Smart Turn endpointing -> Celeris persona
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
calls Celeris immediately. It never waits for an embedding or adviser request.

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
model while `PERSONA_ADVISER_MODEL` uses a faster conversational model.

The same adviser is exposed to Celeris through one narrow `ask_adviser` tool.
Celeris answers ordinary turns directly. For a genuinely difficult creative or
emotionally delicate request it may speak a short acknowledgment, call the
adviser, and then finish the answer. The tool cannot perform external actions.

Required durable-memory variables are listed in `.env.example`. Database,
embedding, and adviser failures are logged without request text or credentials;
the ordinary persona conversation remains usable when a prefetch is late.

Persona mode is not PersonaPlex and does not use the native KAME experiment.
The current variant deliberately keeps the verified staged voice, including a
private Pocket conditioning state when one is mounted. Restore the Omnigent
assistant with `CONVERSATION_MODE=coordinator`; coordinator mode again requires
the Omnigent URL, refresh token, and workspace configuration.
