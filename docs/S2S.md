# Guided speech-to-speech runtime

The optional `kame` voice runtime is a native Q4/Vulkan full-duplex path. It is
kept alongside the original staged ASR/Celeris/TTS runtime, selected once at
process startup with `VOICE_RUNTIME=staged|kame`; `staged` remains the default
and rollback requires that environment change plus a restart. It is never a
per-turn choice: a live KAME conversation has one consistent audible voice.

KAME uses the Moshi/Mimi audio architecture plus one oracle text embedding. A
small patch against `Codes4Fun/moshi.cpp` loads and quantizes that embedding and
consumes one queued oracle token per 80 ms audio frame. The native bridge:

- reads 24 kHz mono float32 audio frames from stdin;
- writes 24 kHz mono float32 response frames to stdout;
- accepts replacement or append-only oracle text on file descriptor 3;
- reports readiness, generated transcript text, and rolling frame latency on
  file descriptor 4; and
- keeps diagnostics on stderr so they cannot corrupt the binary audio stream.

The Discord process clocks the stream continuously at 12.5 frames per second.
Discord audio goes to local streaming ASR immediately and through a bounded
delay queue before KAME. Final ASR text still goes through the production
Celeris/coordinator harness; its verified spoken result replaces the current
oracle stream before KAME reaches the caller's endpoint. The queue defaults to
640 ms through `KAME_INPUT_DELAY_MS`. This is the native equivalent of KAME's
official speculative partial-transcript guidance without allowing speculative
tool claims.

Native output is fail-closed. Every frame is discarded until a verified guided
transaction detects speech; timeout, completion, barge-in, or shutdown closes
the gate immediately. Normal completion is eight trailing silent frames. A
guidance-length-scaled 10-120 second watchdog is only a runaway circuit breaker,
not normal endpointing, so longer answers are not truncated at a fixed limit.

Proactive coordinator updates use the same audible KAME voice. After the
channel has been idle, the local TTS engine synthesizes a short input-side
question and feeds it only to KAME; that trigger is never played to Discord.
Piper is therefore a hidden stimulus, not an audible fallback in KAME mode.
The coordinator's verified update becomes oracle guidance while that hidden
input is still entering KAME. Output energy must show real speech followed by eight silent
frames before the coordinator event cursor advances. This avoids both an
audible voice swap and the earlier false success condition where accepting
oracle tokens was mistaken for speaking them.

KAME occasionally accepts guidance without choosing to speak. A proactive turn
therefore gets five seconds to begin and a guidance-scaled watchdog after
speech starts. The runtime tries one fresh hidden-input turn after a start
failure. If that also produces no speech, it retains and requeues the
coordinator event; the caller never hears Piper and the event cursor does not
advance. Ordinary human turns use the same one-retry policy only when no KAME
speech began; a long or malformed response is never repeated automatically.

## Runtime files

No speech-to-speech weights or deployment-specific values belong in the image.
Mount these public model artifacts at runtime and supply their paths through
environment variables:

- the KAME config and locally converted Q4 GGUF model;
- the compatible Mimi GGUF codec;
- the 32k SentencePiece tokenizer; and
- the `kame-bridge` executable built into the image.

The source integration is pinned to `Codes4Fun/moshi.cpp` commit
`f1fabbd14a506076d4d0a9755811598220ee9e13` and its `Codes4Fun/ggml`
`for_moshi` commit `8cf09e9cd3c227ecb42aefc544c820b6c63a28f3`. Apply
`native/moshi-kame.patch`, build the shared Moshi library with dynamic CPU and
Vulkan ggml backends, then compile `native/kame_bridge.cpp` against it.
`native/kame_quantize.cpp` is the offline converter used to create the mounted
Q4 GGUF from the official public safetensors checkpoint; it is not used in the
live audio loop.

The converter is available in the image so model material never has to enter
the public build context. Bind-mount the accepted `SakanaAI/kame` checkpoint and
a private output directory, then run:

```text
/opt/omnigent-voice/bin/kame-quantize CONFIG MODEL_SAFETENSORS OUTPUT_GGUF CPU
```

KAME's checkpoint stores attention projections as separate tensors, unlike the
fused layout used by some Moshi checkpoints. The pinned native patch supports
both layouts. The resulting Q4_K GGUF is about 4.1 GiB and remains a private
runtime mount; it is never copied into the image.

## Control protocol

Each descriptor-3 command is one UTF-8 line. `R<TAB>text` clears unconsumed
guidance, queues KAME's initial oracle token, then queues `text`; `A<TAB>text`
appends. Newlines and tabs are normalized by the Node client. Descriptor 4
emits tab-delimited events: `R` readiness metadata, `G` accepted token count,
`T` generated speech transcript, `M` frame statistics, and `E` errors.

The bridge reports p95, p99, and maximum over rolling 125-frame windows. A mean
under 80 ms is insufficient by itself: recurrent p95 deadline misses will
create gaps or an ever-growing input/output backlog. KAME should be enabled only
after a real Discord run shows stable tails and the oracle speech follows
Celeris closely enough for tool-action claims.

On the target Radeon 8060S, a 20-frame warmup followed by 250 full
Mimi-encode/KAME/Mimi-decode frames measured 63.445 ms mean, 64.335 ms p95,
64.597 ms p99, and 65.145 ms maximum (15.762 fps). A separate real-time smoke
test injected guidance after public test speech; the native generated-text
stream and an independent local ASR pass both recovered, “I hear you clearly.
The guided real-time voice path is working.” The bridge logs every frame over
the 80 ms deadline separately so cold-start and recurrent misses cannot hide in
a rolling percentile. The target driver incurs a roughly 617 ms first-frame
shader warmup. A controlled follow-up found that 20 frames warmed the GPU but
did not always establish enough idle dialogue context for an immediate first
turn. The deployed runtime therefore primes 64 discarded silent frames before
Discord connects. With the longer idle lead-in, both the known public-speech
fixture and a hidden local-TTS trigger produced 34-37 active output frames, and
independent local ASR recovered the guided sentence exactly. The hidden trigger
keeps KAME as the only voice audible to the caller.

The first live phone rollout disproved the earlier synthetic gate. Discord
received and locally recognized three real turns, but every native output frame
was forwarded from process startup, including KAME's unguided continuous
channel. The caller heard nonstop multilingual-sounding gibberish. Four replies
hit 20-30 second speech timeouts, seven playbacks were interrupted, and 52 input
backlog warnings appeared. The deployment was stopped and rolled back.

The post-incident offline gate uses four paced turns, including a 28-word long
answer, and independently transcribes only gated audio. With input delayed 720
ms and a conservative 400 ms guidance simulation, two sequences passed all
seven turns; recognized guidance recall ranged from 77.8% to 100%. The long
answer produced 12.8 seconds of audio, ended naturally, and recovered 96.4% of
the intended words. A 400 ms delay missed a turn, so the faster setting is not
eligible for live rollout. A real phone conversation remains a required gate;
offline English and termination are necessary but not sufficient.

Every guided transaction owns a fresh Discord raw-audio resource. The resource
is created in the buffering state before guidance and ended when the transaction
settles. `@discordjs/voice` destroys a playing resource after five missing 20 ms
frames, so a process-lifetime resource cannot survive the deliberately silent
gaps between guided turns. Closed-gate KAME frames remain discarded rather than
being forwarded as audible or silent keepalive audio.
