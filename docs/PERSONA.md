# Persona mode

Persona mode is a tool-free conversational variant of the Discord voice bot.
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
There are no tool definitions or coordinator snapshots in Celeris requests.
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
trail remains on private runtime storage and is not replayed automatically.

Persona mode is not PersonaPlex and does not use the native KAME experiment.
The current variant deliberately keeps the verified staged voice, including a
private Pocket conditioning state when one is mounted. Restore the Omnigent
assistant with `CONVERSATION_MODE=coordinator`; coordinator mode again requires
the Omnigent URL, refresh token, and workspace configuration.
