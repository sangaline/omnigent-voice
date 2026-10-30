#!/usr/bin/env python3
# SPDX-License-Identifier: MIT

"""Persistent binary bridge for local Smart Turn v3 inference.

stdin requests:  uint32 request id, uint32 sample count, float32 samples
stdout results: uint32 request id, float32 probability, float32 elapsed ms
"""

import argparse
import struct
import sys
import time

import numpy as np
import onnxruntime as ort

from whisper_features import compute_whisper_log_mel_features

_REQUEST = struct.Struct("<II")
_RESULT = struct.Struct("<Iff")
_MAX_SAMPLES = 8 * 16_000


def _read_exact(size: int) -> bytes | None:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sys.stdin.buffer.read(size - len(chunks))
        if not chunk:
            return None
        chunks.extend(chunk)
    return bytes(chunks)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--threads", type=int, default=1)
    args = parser.parse_args()

    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = args.threads
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(args.model, sess_options=options)

    while True:
        header = _read_exact(_REQUEST.size)
        if header is None:
            return
        request_id, sample_count = _REQUEST.unpack(header)
        payload = _read_exact(sample_count * 4)
        if payload is None:
            return
        started = time.perf_counter()
        audio = np.frombuffer(payload, dtype="<f4")
        if audio.size > _MAX_SAMPLES:
            audio = audio[-_MAX_SAMPLES:]
        elif audio.size < _MAX_SAMPLES:
            audio = np.pad(audio, (_MAX_SAMPLES - audio.size, 0), mode="constant")
        features = np.expand_dims(compute_whisper_log_mel_features(audio), axis=0)
        outputs = session.run(None, {"input_features": features})
        probability = float(np.asarray(outputs[0]).reshape(-1)[0])
        elapsed_ms = (time.perf_counter() - started) * 1_000.0
        sys.stdout.buffer.write(_RESULT.pack(request_id, probability, elapsed_ms))
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
