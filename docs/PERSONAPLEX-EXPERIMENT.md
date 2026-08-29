# PersonaPlex / Moshi feasibility experiment

## Question

Can the PyTorch Moshi frame loop sustain full-duplex 12.5 Hz inference on a
Ryzen AI Max+ 395 / Radeon 8060S (`gfx1151`) without adding enough buffering to
erase PersonaPlex's latency advantage?

PersonaPlex is a fine-tune of Moshi with role and voice conditioning. The public
stock Moshiko checkpoint is therefore the first runtime control: it isolates
Mimi, the temporal transformer, the eight-step depth transformer, PyTorch, and
ROCm before gated PersonaPlex weights or Omnigent integration are involved.

## Decision gate

- Strong pass: BF16 encode + LM step + decode mean below 65 ms and p95 below
  80 ms.
- Borderline: mean 65-90 ms or p95 at/above 80 ms. Investigate graph stability,
  quantization, and scheduling jitter before integration.
- Fail: mean above 90 ms or required HIP graph capture does not work. Prefer a
  quantized native/Vulkan runtime rather than building the voice harness around
  the PyTorch path.

The checked-in benchmark uses a real uncompressed PCM speech WAV, excludes 20
graph/warm-up frames, measures 250 frames, reports eager and HIP-graph modes,
and separately reports Mimi encode, LM GPU, Mimi decode GPU, isolated LM+decode
wall time, and the true encode+LM+decode wall time. Every wall measurement
synchronizes the device. No audio, tokens, model output, host paths,
credentials, or account data are written to the result.

## Current environment

- 32 CPU threads and 128 GiB unified memory.
- The kernel reports a 1 GiB visible VRAM aperture and roughly 124 GiB GTT;
  PyTorch reports 124 GiB available to the `gfx1151` device.
- Isolated container control: PyTorch 2.9.1 with ROCm 7.12.
- Basic BF16 control before model download: 4096-square matmul mean 4.85 ms,
  p95 5.17 ms; one-token SDPA over a 256-token cache mean 0.13 ms; HIP graph
  capture and replay succeeded.
- PersonaPlex weights are gated. License acceptance and a local Hugging Face
  login are required; a token is never passed as a CLI argument or committed.

## Measurements on this machine

The full streaming frame loop includes Mimi encode, one temporal/depth-model
step, and Mimi decode. Moshi produces one frame every 80 ms, so sustained
realtime operation requires both mean and tail latency below that deadline.

| Runtime | Mean frame | p95 frame | Throughput | Result |
| --- | ---: | ---: | ---: | --- |
| PyTorch BF16, default attention | 195.969 ms | 196.221 ms | 5.103 fps | fail |
| PyTorch BF16, experimental AOTriton, ROCm 7.12 | 145.957 ms | 146.462 ms | 6.851 fps | fail |
| PyTorch BF16, experimental AOTriton, ROCm 7.13 | 145.876 ms | 146.118 ms | 6.855 fps | fail |
| PyTorch Q8/bitsandbytes | 198.464 ms | 200.411 ms | 5.039 fps | fail |
| Native Vulkan Q4 | 67.25 ms | pending instrumentation | 14.871 fps | promising |

The native result is a complete encode/model/decode run using the public
PersonaPlex Q4 checkpoint, a real WAV voice prompt, and the Radeon 8060S Vulkan
device. It used about 7.31 GiB of device memory and loaded in 1.344 seconds. The
upstream native executable currently reports only aggregate throughput; p95 and
maximum frame time must be instrumented before deployment is considered safe.

The precomputed PersonaPlex voice embeddings exercise a BF16-to-F32 Vulkan copy
operation that the current `gfx1151` backend does not implement. Supplying the
original WAV voice prompt avoids that conversion and proves that the actual
realtime model loop works. Treat cached-voice support as a small native runtime
fix, not as a model feasibility failure.

These measurements reject the PyTorch integration path on this GPU. Continue
with native Q4/Vulkan and preserve the staged ASR/Celeris/TTS pipeline as the
fallback until native frame tails and guided response behavior are verified.

## Run

Clone the official [Kyutai Moshi repository](https://github.com/kyutai-labs/moshi)
and choose a real speech WAV of at least 21.6 seconds. Set private host paths only
in the shell:

```bash
export PERSONAPLEX_MOSHI_SOURCE=/path/to/moshi
export PERSONAPLEX_INPUT_WAV=/path/to/speech.wav
export PERSONAPLEX_HF_CACHE=/private/path/to/huggingface-cache

experiments/personaplex/run-benchmark.sh --mode both \
  > .personaplex-results/moshiko-bf16.json
```

The default checkpoint is the public `kyutai/moshiko-pytorch-bf16`. After
accepting the [PersonaPlex model terms](https://huggingface.co/nvidia/personaplex-7b-v1)
and authenticating the same local cache, use:

```bash
experiments/personaplex/run-benchmark.sh --mode both \
  --runtime personaplex \
  --hf-repo nvidia/personaplex-7b-v1 \
  > .personaplex-results/personaplex-bf16.json
```

For that command, point `PERSONAPLEX_MOSHI_SOURCE` at the official NVIDIA
PersonaPlex checkout rather than the Kyutai checkout. `--runtime auto` detects
either vendored API, while an explicit runtime fails closed if the wrong source
tree is mounted.

Set `PERSONAPLEX_ENABLE_AOTRITON=1` to opt into PyTorch's explicitly
experimental gfx1151 memory-efficient attention path. Keep its results separate
from the default run because this changes the selected attention kernel.

The official PersonaPlex repository currently pins an older Moshi package and
PyTorch range. The initial control deliberately uses current upstream Moshi,
whose package range includes PyTorch 2.9, then PersonaPlex compatibility is
tested separately so a model-code pin does not get confused with a ROCm runtime
failure.
