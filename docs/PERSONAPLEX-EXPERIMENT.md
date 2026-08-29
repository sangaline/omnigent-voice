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

The checked-in benchmark uses real 24 kHz speech, excludes 20 graph/warm-up
frames, measures 250 frames, reports eager and HIP-graph modes, and separately
reports Mimi encode, LM GPU, Mimi decode GPU, isolated LM+decode wall time, and
the true encode+LM+decode wall time. Every wall measurement synchronizes the
device. No audio, tokens, model output, host paths, credentials, or account data
are written to the result.

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
  --hf-repo nvidia/personaplex-7b-v1 \
  > .personaplex-results/personaplex-bf16.json
```

The official PersonaPlex repository currently pins an older Moshi package and
PyTorch range. The initial control deliberately uses current upstream Moshi,
whose package range includes PyTorch 2.9, then PersonaPlex compatibility is
tested separately so a model-code pin does not get confused with a ROCm runtime
failure.
