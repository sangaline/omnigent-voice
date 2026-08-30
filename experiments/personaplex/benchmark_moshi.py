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
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np
import torch
from huggingface_hub import hf_hub_download
from moshi.models import LMGen, loaders


FRAME_BUDGET_MS = 80.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True, help="A real speech WAV file")
    parser.add_argument("--hf-repo", default="kyutai/moshiko-pytorch-bf16")
    parser.add_argument("--revision")
    parser.add_argument(
        "--runtime",
        choices=("auto", "upstream", "personaplex"),
        default="auto",
        help="Select the Kyutai or NVIDIA vendored Moshi API",
    )
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
    with wave.open(str(path), "rb") as source:
        if source.getcomptype() != "NONE":
            raise ValueError("input WAV must use uncompressed PCM")
        channels = source.getnchannels()
        source_rate = source.getframerate()
        sample_width = source.getsampwidth()
        raw = source.readframes(source.getnframes())
    if sample_width == 1:
        values = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128) / 128
    elif sample_width == 2:
        values = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
    elif sample_width == 4:
        values = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648
    else:
        raise ValueError(f"unsupported PCM sample width: {sample_width} bytes")
    values = values.reshape(-1, channels).mean(axis=1)
    pcm = torch.from_numpy(values.copy()).view(1, 1, -1)
    if source_rate != sample_rate:
        target_samples = round(pcm.shape[-1] * sample_rate / source_rate)
        pcm = torch.nn.functional.interpolate(
            pcm,
            size=target_samples,
            mode="linear",
            align_corners=False,
        )
    if pcm.shape[-1] < samples:
        raise ValueError(
            f"input must contain at least {samples / sample_rate:.2f} seconds of speech"
        )
    return pcm[:, :, :samples].to(device=device, dtype=torch.float32)


def set_graph_mode(mode: str) -> None:
    if mode == "eager":
        os.environ["NO_CUDA_GRAPH"] = "1"
    else:
        os.environ.pop("NO_CUDA_GRAPH", None)


@dataclass
class ModelRuntime:
    name: str
    mimi: Any
    lm: Any
    make_lm_gen: Callable[[], Any]
    agent_codes: Callable[[torch.Tensor], torch.Tensor]


def restore_q8_scales(
    lm: torch.nn.Module,
    weights: Path,
    device: torch.device,
) -> None:
    """Undo an upstream loader cast that changes Q8 scales to bfloat16.

    Kyutai's QLinear kernel requires its small ``*_scb`` scale tensors to stay
    float32. Current ``get_moshi_lm`` casts every floating checkpoint tensor to
    the requested activation dtype, so reload just those scales losslessly.
    """
    from safetensors import safe_open

    scales: dict[str, torch.Tensor] = {}
    with safe_open(str(weights), framework="pt", device="cpu") as reader:
        for key in reader.keys():
            if key.endswith("_scb"):
                scales[key] = reader.get_tensor(key).to(device=device, dtype=torch.float32)
    if not scales:
        raise RuntimeError("quantized checkpoint contains no *_scb scale tensors")
    incompatible = lm.load_state_dict(scales, strict=False, assign=True)
    if incompatible.unexpected_keys:
        raise RuntimeError(
            f"could not restore Q8 scale tensors: {incompatible.unexpected_keys[:3]}"
        )
    invalid = [
        name
        for name, parameter in lm.named_parameters()
        if name.endswith("weight_scb") and parameter.dtype != torch.float32
    ]
    if invalid:
        raise RuntimeError(f"Q8 scales still have the wrong dtype: {invalid[:3]}")


def load_runtime(args: argparse.Namespace, device: torch.device) -> ModelRuntime:
    detected = "upstream" if hasattr(loaders, "CheckpointInfo") else "personaplex"
    selected = detected if args.runtime == "auto" else args.runtime
    if selected != detected:
        raise RuntimeError(
            f"selected {selected} runtime but mounted source exposes {detected} API"
        )

    if selected == "upstream":
        checkpoint = loaders.CheckpointInfo.from_hf_repo(
            args.hf_repo,
            revision=args.revision,
        )
        mimi = checkpoint.get_mimi(device=device)
        lm = checkpoint.get_moshi(device=device, dtype=torch.bfloat16)
        if checkpoint.lm_config and checkpoint.lm_config.get("quantize"):
            restore_q8_scales(lm, checkpoint.moshi_weights, device)
        return ModelRuntime(
            name="upstream",
            mimi=mimi,
            lm=lm,
            make_lm_gen=lambda: LMGen(
                lm,
                cfg_coef=1.0,
                **checkpoint.lm_gen_config,
            ),
            agent_codes=lambda tokens: tokens[:, 1:],
        )

    mimi_path = hf_hub_download(
        args.hf_repo,
        loaders.MIMI_NAME,
        revision=args.revision,
    )
    lm_path = hf_hub_download(
        args.hf_repo,
        loaders.MOSHI_NAME,
        revision=args.revision,
    )
    mimi = loaders.get_mimi(mimi_path, device=device)
    lm = loaders.get_moshi_lm(lm_path, device=device, dtype=torch.bfloat16)
    lm.eval()
    return ModelRuntime(
        name="personaplex",
        mimi=mimi,
        lm=lm,
        make_lm_gen=lambda: LMGen(
            lm,
            device=device,
            audio_silence_frame_cnt=int(0.5 * mimi.frame_rate),
            sample_rate=mimi.sample_rate,
            frame_rate=mimi.frame_rate,
        ),
        agent_codes=lambda tokens: tokens[:, 1:9],
    )


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
            "encoder": bool(
                getattr(getattr(state, "graphed_encoder", None), "_graph", None)
            ),
            "encoder_transformer": bool(
                getattr(state.graphed_tr_enc, "_graph", None)
                if state.graphed_tr_enc is not None
                else False
            ),
        }
    return codes, wall_ms, graph_state


def run_core_loop(
    runtime: ModelRuntime,
    codes: list[torch.Tensor],
    warmup_frames: int,
) -> dict[str, Any]:
    mimi = runtime.mimi
    lm_gen = runtime.make_lm_gen()
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
                mimi.decode(runtime.agent_codes(tokens))
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
            "decoder": bool(
                getattr(getattr(mimi_state, "graphed_decoder", None), "_graph", None)
            ),
        }
    return {
        "lm_and_decode_wall_ms": summary(frame_wall_ms),
        "lm_gpu_ms": summary(lm_gpu_ms),
        "decode_gpu_ms": summary(decode_gpu_ms),
        "graph_captured": graph_state,
    }


def run_full_loop(
    runtime: ModelRuntime,
    pcm: torch.Tensor,
    frame_size: int,
    warmup_frames: int,
) -> dict[str, Any]:
    mimi = runtime.mimi
    lm_gen = runtime.make_lm_gen()
    wall_ms: list[float] = []
    with torch.inference_mode(), lm_gen.streaming(1), mimi.streaming(1):
        for index, frame in enumerate(pcm.split(frame_size, dim=-1)):
            torch.cuda.synchronize()
            started = time.perf_counter()
            code = mimi.encode(frame)
            tokens = lm_gen.step(code)
            if tokens is not None:
                mimi.decode(runtime.agent_codes(tokens))
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
    runtime: ModelRuntime,
    pcm: torch.Tensor,
    frame_size: int,
    warmup_frames: int,
) -> dict[str, Any]:
    set_graph_mode(mode)
    gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    mimi = runtime.mimi
    codes, encode_ms, encode_graphs = encode_input(mimi, pcm, frame_size, warmup_frames)
    core = run_core_loop(runtime, codes, warmup_frames)
    full = run_full_loop(runtime, pcm, frame_size, warmup_frames)
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
    runtime = load_runtime(args, device)
    load_seconds = time.perf_counter() - load_started
    mimi = runtime.mimi
    frame_size = int(mimi.sample_rate / mimi.frame_rate)
    pcm = load_audio(args.audio, mimi.sample_rate, total_frames * frame_size, device)

    result: dict[str, Any] = {
        "benchmark": "moshi_streaming_frame_loop_v1",
        "model": args.hf_repo,
        "runtime": runtime.name,
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
                run_mode(mode, runtime, pcm, frame_size, args.warmup_frames)
            )
        except Exception as error:
            result["runs"].append(
                {"mode": mode, "error_type": type(error).__name__, "error": str(error)}
            )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
