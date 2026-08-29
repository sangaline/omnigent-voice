#!/usr/bin/env python3
"""Measure the stock Moshi streaming frame loop on a CUDA-compatible device.

ROCm exposes its HIP device through torch.cuda, so this same benchmark covers
CUDA and ROCm. Results contain only model/runtime measurements and no audio or
credential data.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import os
import random
import statistics
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import torch
import torchaudio
from moshi.models import LMGen, loaders


FRAME_BUDGET_MS = 80.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True, help="A real speech WAV file")
    parser.add_argument("--hf-repo", default="kyutai/moshiko-pytorch-bf16")
    parser.add_argument("--revision")
    parser.add_argument("--mode", choices=("eager", "graph", "both"), default="both")
    parser.add_argument("--warmup-frames", type=int, default=20)
    parser.add_argument("--measure-frames", type=int, default=250)
    parser.add_argument("--seed", type=int, default=4242)
    return parser.parse_args()


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise ValueError("cannot summarize an empty sample")
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def summary(values: Iterable[float]) -> dict[str, float]:
    samples = list(values)
    return {
        "mean": round(statistics.fmean(samples), 3),
        "p50": round(percentile(samples, 0.50), 3),
        "p95": round(percentile(samples, 0.95), 3),
        "min": round(min(samples), 3),
        "max": round(max(samples), 3),
    }


def load_audio(path: Path, sample_rate: int, samples: int, device: torch.device) -> torch.Tensor:
    pcm, source_rate = torchaudio.load(path)
    if pcm.shape[0] > 1:
        pcm = pcm.mean(dim=0, keepdim=True)
    if source_rate != sample_rate:
        pcm = torchaudio.functional.resample(pcm, source_rate, sample_rate)
    if pcm.shape[-1] < samples:
        raise ValueError(
            f"input must contain at least {samples / sample_rate:.2f} seconds of speech"
        )
    return pcm[:, :samples].unsqueeze(0).to(device=device, dtype=torch.float32)


def set_graph_mode(mode: str) -> None:
    if mode == "eager":
        os.environ["NO_CUDA_GRAPH"] = "1"
    else:
        os.environ.pop("NO_CUDA_GRAPH", None)


def make_lm_gen(checkpoint: loaders.CheckpointInfo, lm: torch.nn.Module) -> LMGen:
    return LMGen(lm, cfg_coef=1.0, **checkpoint.lm_gen_config)


def encode_input(
    mimi: torch.nn.Module,
    pcm: torch.Tensor,
    frame_size: int,
    warmup_frames: int,
) -> tuple[list[torch.Tensor], list[float], dict[str, bool]]:
    codes: list[torch.Tensor] = []
    wall_ms: list[float] = []
    graph_state = {"encoder": False, "encoder_transformer": False}
    with torch.inference_mode(), mimi.streaming(1):
        for index, frame in enumerate(pcm.split(frame_size, dim=-1)):
            torch.cuda.synchronize()
            started = time.perf_counter()
            code = mimi.encode(frame)
            torch.cuda.synchronize()
            elapsed_ms = (time.perf_counter() - started) * 1000
            codes.append(code.clone())
            if index >= warmup_frames:
                wall_ms.append(elapsed_ms)
        state = mimi._streaming_state
        graph_state = {
            "encoder": bool(getattr(state.graphed_encoder, "_graph", None)),
            "encoder_transformer": bool(
                getattr(state.graphed_tr_enc, "_graph", None)
                if state.graphed_tr_enc is not None
                else False
            ),
        }
    return codes, wall_ms, graph_state


def run_core_loop(
    checkpoint: loaders.CheckpointInfo,
    lm: torch.nn.Module,
    mimi: torch.nn.Module,
    codes: list[torch.Tensor],
    warmup_frames: int,
) -> dict[str, Any]:
    lm_gen = make_lm_gen(checkpoint, lm)
    frame_wall_ms: list[float] = []
    lm_gpu_ms: list[float] = []
    decode_gpu_ms: list[float] = []
    graph_state = {"lm": False, "depth": False, "decoder": False}
    with torch.inference_mode(), lm_gen.streaming(1), mimi.streaming(1):
        for index, code in enumerate(codes):
            lm_start = torch.cuda.Event(enable_timing=True)
            lm_end = torch.cuda.Event(enable_timing=True)
            decode_start = torch.cuda.Event(enable_timing=True)
            decode_end = torch.cuda.Event(enable_timing=True)
            torch.cuda.synchronize()
            started = time.perf_counter()
            lm_start.record()
            tokens = lm_gen.step(code)
            lm_end.record()
            if tokens is not None:
                decode_start.record()
                mimi.decode(tokens[:, 1:])
                decode_end.record()
            torch.cuda.synchronize()
            elapsed_ms = (time.perf_counter() - started) * 1000
            if index >= warmup_frames:
                frame_wall_ms.append(elapsed_ms)
                lm_gpu_ms.append(lm_start.elapsed_time(lm_end))
                if tokens is not None:
                    decode_gpu_ms.append(decode_start.elapsed_time(decode_end))
        lm_state = lm_gen._streaming_state
        mimi_state = mimi._streaming_state
        graph_state = {
            "lm": bool(getattr(lm_state.graphed_main, "_graph", None)),
            "depth": bool(
                getattr(lm_state.graphed_depth, "_graph", None)
                if lm_state.graphed_depth is not None
                else False
            ),
            "decoder": bool(getattr(mimi_state.graphed_decoder, "_graph", None)),
        }
    return {
        "lm_and_decode_wall_ms": summary(frame_wall_ms),
        "lm_gpu_ms": summary(lm_gpu_ms),
        "decode_gpu_ms": summary(decode_gpu_ms),
        "graph_captured": graph_state,
    }


def run_full_loop(
    checkpoint: loaders.CheckpointInfo,
    lm: torch.nn.Module,
    mimi: torch.nn.Module,
    pcm: torch.Tensor,
    frame_size: int,
    warmup_frames: int,
) -> dict[str, Any]:
    lm_gen = make_lm_gen(checkpoint, lm)
    wall_ms: list[float] = []
    with torch.inference_mode(), lm_gen.streaming(1), mimi.streaming(1):
        for index, frame in enumerate(pcm.split(frame_size, dim=-1)):
            torch.cuda.synchronize()
            started = time.perf_counter()
            code = mimi.encode(frame)
            tokens = lm_gen.step(code)
            if tokens is not None:
                mimi.decode(tokens[:, 1:])
            torch.cuda.synchronize()
            if index >= warmup_frames:
                wall_ms.append((time.perf_counter() - started) * 1000)
    timings = summary(wall_ms)
    return {
        "encode_lm_decode_wall_ms": timings,
        "frames_per_second": round(1000 / timings["mean"], 3),
        "realtime_margin_ms": round(FRAME_BUDGET_MS - timings["p95"], 3),
        "meets_80ms_p95": timings["p95"] < FRAME_BUDGET_MS,
    }


def run_mode(
    mode: str,
    checkpoint: loaders.CheckpointInfo,
    lm: torch.nn.Module,
    mimi: torch.nn.Module,
    pcm: torch.Tensor,
    frame_size: int,
    warmup_frames: int,
) -> dict[str, Any]:
    set_graph_mode(mode)
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    codes, encode_ms, encode_graphs = encode_input(mimi, pcm, frame_size, warmup_frames)
    core = run_core_loop(checkpoint, lm, mimi, codes, warmup_frames)
    full = run_full_loop(checkpoint, lm, mimi, pcm, frame_size, warmup_frames)
    return {
        "mode": mode,
        "mimi_encode_wall_ms": summary(encode_ms),
        "encode_graph_captured": encode_graphs,
        **core,
        **full,
        "peak_allocated_gib": round(torch.cuda.max_memory_allocated() / 2**30, 3),
        "peak_reserved_gib": round(torch.cuda.max_memory_reserved() / 2**30, 3),
    }


def main() -> None:
    args = parse_args()
    if args.warmup_frames < 2 or args.measure_frames < 1:
        raise ValueError("use at least two warm-up frames and one measured frame")
    if not torch.cuda.is_available():
        raise RuntimeError("torch.cuda is unavailable; ROCm also uses this API")

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.backends.cudnn.benchmark = False
    device = torch.device("cuda")
    modes = ["eager", "graph"] if args.mode == "both" else [args.mode]
    total_frames = args.warmup_frames + args.measure_frames

    load_started = time.perf_counter()
    checkpoint = loaders.CheckpointInfo.from_hf_repo(
        args.hf_repo,
        revision=args.revision,
    )
    mimi = checkpoint.get_mimi(device=device)
    lm = checkpoint.get_moshi(device=device, dtype=torch.bfloat16)
    load_seconds = time.perf_counter() - load_started
    frame_size = int(mimi.sample_rate / mimi.frame_rate)
    pcm = load_audio(args.audio, mimi.sample_rate, total_frames * frame_size, device)

    result: dict[str, Any] = {
        "benchmark": "moshi_streaming_frame_loop_v1",
        "model": args.hf_repo,
        "torch": torch.__version__,
        "hip": torch.version.hip,
        "device": torch.cuda.get_device_name(0),
        "architecture": getattr(torch.cuda.get_device_properties(0), "gcnArchName", None),
        "dtype": "bfloat16",
        "frame_rate_hz": mimi.frame_rate,
        "frame_budget_ms": FRAME_BUDGET_MS,
        "warmup_frames": args.warmup_frames,
        "measured_frames": args.measure_frames,
        "model_load_seconds": round(load_seconds, 3),
        "runs": [],
    }
    for mode in modes:
        try:
            result["runs"].append(
                run_mode(mode, checkpoint, lm, mimi, pcm, frame_size, args.warmup_frames)
            )
        except Exception as error:
            result["runs"].append(
                {"mode": mode, "error_type": type(error).__name__, "error": str(error)}
            )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
