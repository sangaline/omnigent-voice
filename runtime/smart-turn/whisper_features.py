# Copyright (c) 2024-2026, Daily
# SPDX-License-Identifier: BSD-2-Clause

"""NumPy-only Whisper log-mel features used by Smart Turn v3.

Adapted from Pipecat's ``_whisper_features.py``. The implementation mirrors
``transformers.WhisperFeatureExtractor`` without carrying the Transformers
runtime into the voice image.
"""

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

_N_FFT = 400
_HOP_LENGTH = 160
_N_MELS = 80
_SAMPLE_RATE = 16_000
_MEL_FLOOR = 1e-10
_NORM_VARIANCE_EPS = 1e-7


def _hertz_to_mel_slaney(freq: np.ndarray) -> np.ndarray:
    min_log_hertz = 1_000.0
    min_log_mel = 15.0
    logstep = 27.0 / np.log(6.4)
    freq = np.atleast_1d(np.asarray(freq, dtype=np.float64))
    mels = 3.0 * freq / 200.0
    log_region = freq >= min_log_hertz
    mels[log_region] = min_log_mel + np.log(freq[log_region] / min_log_hertz) * logstep
    return mels


def _mel_to_hertz_slaney(mels: np.ndarray) -> np.ndarray:
    min_log_hertz = 1_000.0
    min_log_mel = 15.0
    logstep = np.log(6.4) / 27.0
    mels = np.atleast_1d(np.asarray(mels, dtype=np.float64))
    freq = 200.0 * mels / 3.0
    log_region = mels >= min_log_mel
    freq[log_region] = min_log_hertz * np.exp(logstep * (mels[log_region] - min_log_mel))
    return freq


def _build_mel_filterbank() -> np.ndarray:
    mel_min = float(_hertz_to_mel_slaney(np.array([0.0]))[0])
    mel_max = float(_hertz_to_mel_slaney(np.array([_SAMPLE_RATE / 2.0]))[0])
    mel_freqs = np.linspace(mel_min, mel_max, _N_MELS + 2)
    filter_freqs = _mel_to_hertz_slaney(mel_freqs)
    fft_freqs = np.linspace(0, _SAMPLE_RATE // 2, _N_FFT // 2 + 1)
    filter_diff = np.diff(filter_freqs)
    slopes = np.expand_dims(filter_freqs, 0) - np.expand_dims(fft_freqs, 1)
    down_slopes = -slopes[:, :-2] / filter_diff[:-1]
    up_slopes = slopes[:, 2:] / filter_diff[1:]
    filters = np.maximum(np.zeros(1), np.minimum(down_slopes, up_slopes))
    filters *= np.expand_dims(
        2.0 / (filter_freqs[2 : _N_MELS + 2] - filter_freqs[:_N_MELS]),
        0,
    )
    return filters


_HANN_WINDOW = np.hanning(_N_FFT + 1)[:-1]
_MEL_FILTERS = _build_mel_filterbank()


def compute_whisper_log_mel_features(audio: np.ndarray) -> np.ndarray:
    """Return the normalized ``(80, 800)`` Smart Turn input tensor."""

    if audio.ndim != 1:
        raise ValueError(f"Expected 1-D audio, got shape {audio.shape}")
    x = np.asarray(audio, dtype=np.float32)
    sample_count = _SAMPLE_RATE * 8
    if x.size < sample_count:
        x = np.pad(x, (0, sample_count - x.size), mode="constant")
    elif x.size > sample_count:
        x = x[:sample_count]
    x = (x - x.mean()) / np.sqrt(x.var() + _NORM_VARIANCE_EPS)

    padded = np.pad(x.astype(np.float64), (_N_FFT // 2, _N_FFT // 2), mode="reflect")
    windows = sliding_window_view(padded, _N_FFT)[::_HOP_LENGTH]
    spectrum = np.fft.rfft(windows * _HANN_WINDOW.astype(np.float64), axis=-1)
    magnitudes = (np.abs(spectrum) ** 2).T
    mel_spectrum = np.maximum(_MEL_FLOOR, _MEL_FILTERS.T @ magnitudes)
    log_spectrum = np.log10(mel_spectrum)[:, :-1]
    log_spectrum = np.maximum(log_spectrum, log_spectrum.max() - 8.0)
    return ((log_spectrum + 4.0) / 4.0).astype(np.float32)
