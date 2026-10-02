"""Speech-to-text service abstraction (Whisper today)."""

from __future__ import annotations

from pathlib import Path

from backend.config import get_settings


class TranscriptionService:
    def transcribe_file(self, audio_path: str | Path, model_size: str | None = None) -> dict:
        from src.speech_to_text import transcribe_audio

        size = model_size or get_settings().whisper_model
        return transcribe_audio(audio_path, model_size=size)

    def transcribe_audio_chunk(self, audio_path: str | Path, model_size: str | None = None) -> dict:
        return self.transcribe_file(audio_path, model_size=model_size)

    def process_transcript(self, text: str) -> str:
        return (text or "").strip()


transcription_service = TranscriptionService()
