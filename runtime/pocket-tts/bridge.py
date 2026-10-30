#!/usr/bin/env python3
"""Persistent newline-framed Pocket TTS bridge for the Node voice runtime."""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import queue
import sys
import threading
from typing import Any


protocol = sys.stdout.buffer
protocol_lock = threading.Lock()


def emit(message: dict[str, Any]) -> None:
    with protocol_lock:
        protocol.write(json.dumps(message, separators=(",", ":")).encode("utf-8") + b"\n")
        protocol.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", default="alba")
    parser.add_argument("--quantize", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--warmup-text", default="Ready.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    os.environ.setdefault("POCKET_TTS_NO_BEARTYPE", "1")

    # Keep all library diagnostics away from the protocol stream.
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        from pocket_tts import TTSModel

        model = TTSModel.load_model(quantize=args.quantize)
        voice_state = model.get_state_for_audio_prompt(args.voice)
        for _chunk in model.generate_audio_stream(voice_state, args.warmup_text):
            pass

    emit({"type": "ready", "sample_rate": model.sample_rate})

    requests: queue.Queue[dict[str, Any] | None] = queue.Queue()
    cancelled: set[int] = set()
    active: set[int] = set()
    state_lock = threading.Lock()

    def read_requests() -> None:
        for raw_line in sys.stdin.buffer:
            request: Any = None
            try:
                request = json.loads(raw_line)
                request_id = request.get("id")
                if not isinstance(request_id, int) or request_id <= 0:
                    raise ValueError("invalid request id")
                if request.get("type") == "cancel":
                    with state_lock:
                        if request_id in active:
                            cancelled.add(request_id)
                    continue
                text = request.get("text")
                if not isinstance(text, str) or not text.strip():
                    raise ValueError("empty text")
                requests.put(request)
            except Exception as error:  # Keep request text and arbitrary detail private.
                emit(
                    {
                        "type": "error",
                        "id": request.get("id", 0) if isinstance(request, dict) else 0,
                        "error": type(error).__name__,
                    }
                )
        requests.put(None)

    threading.Thread(target=read_requests, daemon=True).start()
    while True:
        request = requests.get()
        if request is None:
            break
        request_id = request["id"]
        was_cancelled = False
        try:
            with state_lock:
                active.add(request_id)
            with contextlib.redirect_stdout(sys.stderr):
                for chunk in model.generate_audio_stream(voice_state, request["text"]):
                    with state_lock:
                        was_cancelled = request_id in cancelled
                    if was_cancelled:
                        break
                    samples = chunk.detach().cpu().to(torch.float32).contiguous().numpy()
                    emit(
                        {
                            "type": "chunk",
                            "id": request_id,
                            "audio": base64.b64encode(samples.tobytes()).decode("ascii"),
                        }
                    )
            emit({"type": "done", "id": request_id, "cancelled": was_cancelled})
        except Exception as error:  # Keep request text and arbitrary exception detail private.
            emit({"type": "error", "id": request_id, "error": type(error).__name__})
        finally:
            with state_lock:
                cancelled.discard(request_id)
                active.discard(request_id)


if __name__ == "__main__":
    main()
