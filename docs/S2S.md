# Guided speech-to-speech runtime

The optional `kame` voice runtime is a native Q4/Vulkan full-duplex path. It is
kept alongside the original staged ASR/Celeris/TTS runtime, selected with
`VOICE_RUNTIME=staged|kame`; `staged` remains the default and rollback requires
only that environment change.

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
Discord audio goes to KAME and local streaming ASR in parallel. Final ASR text
still goes through the production Celeris/coordinator harness; its verified
spoken result replaces the current oracle stream. This preserves the existing
session tools and action invariants while KAME supplies low-latency continuous
speech and barge-in behavior.

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

## Control protocol

Each descriptor-3 command is one UTF-8 line. `R<TAB>text` clears unconsumed
guidance, queues KAME's initial oracle token, then queues `text`; `A<TAB>text`
appends. Newlines and tabs are normalized by the Node client. Descriptor 4
emits tab-delimited events: `R` readiness metadata, `G` accepted token count,
`T` generated speech transcript, `M` frame statistics, and `E` errors.

The bridge reports p95, p99, and maximum over rolling 125-frame windows. A mean
under 80 ms is insufficient by itself: recurrent p95 deadline misses will
create gaps or an ever-growing input/output backlog. Do not make KAME the
deployment default until a real Discord run shows stable tails and the oracle
speech follows Celeris closely enough for tool-action claims.
