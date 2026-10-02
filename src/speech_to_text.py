"""Speech-to-text conversion using OpenAI Whisper."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import whisper

_MODEL_CACHE: dict[str, whisper.Whisper] = {}


def load_whisper_model(model_size: str = "base"):
    """Load (and cache) a Whisper model. Use tiny/base for demos, small+ for quality."""
    if model_size not in _MODEL_CACHE:
        _MODEL_CACHE[model_size] = whisper.load_model(model_size)
    return _MODEL_CACHE[model_size]


def transcribe_audio(
    audio_path: str | Path,
    model_size: str = "base",
    language: Optional[str] = "en",
) -> dict:
    """
    Convert an audio file into text.

    Returns:
        {
            "text": full transcript,
            "segments": timed segments,
            "language": detected/used language
        }
    """
    path = Path(audio_path)
    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {path}")

    model = load_whisper_model(model_size)
    result = model.transcribe(
        str(path),
        language=language,
        verbose=False,
        fp16=False,
    )

    segments = [
        {
            "start": float(seg.get("start", 0)),
            "end": float(seg.get("end", 0)),
            "text": (seg.get("text") or "").strip(),
        }
        for seg in result.get("segments", [])
    ]

    return {
        "text": (result.get("text") or "").strip(),
        "segments": segments,
        "language": result.get("language", language or "unknown"),
    }
