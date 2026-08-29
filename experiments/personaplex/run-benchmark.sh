#!/usr/bin/env bash
set -euo pipefail

: "${PERSONAPLEX_MOSHI_SOURCE:?Set this to a checkout of kyutai-labs/moshi}"
: "${PERSONAPLEX_INPUT_WAV:?Set this to a real speech WAV file}"
: "${PERSONAPLEX_HF_CACHE:?Set this to a private Hugging Face cache directory}"

personaplex_image="${PERSONAPLEX_ROCM_IMAGE:-docker.io/rocm/vllm:rocm7.12.0_gfx1151_ubuntu24.04_py3.12_pytorch_2.9.1_vllm_0.16.0}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec podman run --rm \
  --device /dev/kfd \
  --device /dev/dri \
  --group-add keep-groups \
  --ipc=host \
  --mount "type=bind,src=${PERSONAPLEX_MOSHI_SOURCE},dst=/src/moshi,ro=true" \
  --mount "type=bind,src=${PERSONAPLEX_INPUT_WAV},dst=/input.wav,ro=true" \
  --mount "type=bind,src=${PERSONAPLEX_HF_CACHE},dst=/hf-cache" \
  --mount "type=bind,src=${script_dir},dst=/bench,ro=true" \
  --env HF_HOME=/hf-cache \
  --env HF_HUB_DISABLE_PROGRESS_BARS=1 \
  --env PYTHONPATH=/src/moshi/moshi \
  --entrypoint python \
  "${personaplex_image}" \
  -u /bench/benchmark_moshi.py --audio /input.wav "$@"
