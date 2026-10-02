"""Local filesystem storage abstraction."""

from __future__ import annotations

from pathlib import Path

from backend.config import get_settings


class StorageService:
    def __init__(self) -> None:
        self.root = Path(get_settings().storage_path)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "recordings").mkdir(exist_ok=True)
        (self.root / "uploads").mkdir(exist_ok=True)

    def recording_path(self, meeting_id: str, filename: str) -> Path:
        folder = self.root / "recordings" / meeting_id
        folder.mkdir(parents=True, exist_ok=True)
        return folder / filename

    def upload_path(self, filename: str) -> Path:
        return self.root / "uploads" / filename


storage_service = StorageService()
