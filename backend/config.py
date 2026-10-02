"""Application configuration from environment variables."""

from __future__ import annotations

import json
import socket
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent


def detect_lan_ip() -> str:
    """Best-effort LAN IPv4 for same-Wi-Fi testing (not for production)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            candidate = info[4][0]
            if candidate and not candidate.startswith("127."):
                return candidate
    except OSError:
        pass
    return "127.0.0.1"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Minuta"
    environment: str = "development"  # development | production
    secret_key: str = "dev-minuta-change-me-in-production"
    access_token_expire_minutes: int = 60 * 24 * 7

    # Shareable meeting links (no trailing slash).
    # development: http://localhost:8000
    # LAN testing: auto  OR  http://192.168.x.x:8000
    # production:  https://minuta.example.com
    minuta_base_url: str = "http://localhost:8000"
    minuta_port: int = 8000

    # Comma-separated origins, or * for local/LAN. Production: https://your-domain
    cors_origins: str = "*"

    # WebRTC ICE — STUN (public) + optional TURN (relay for hard NATs)
    # STUN_URLS can be comma-separated.
    stun_urls: str = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
    turn_url: str | None = None
    turn_username: str | None = None
    turn_password: str | None = None
    # Optional JSON override for full iceServers list (advanced). Keep secrets in env only.
    ice_servers_json: str | None = None

    database_url: str = f"sqlite:///{(ROOT / 'minuta.db').as_posix()}"
    storage_path: str = str(ROOT / "storage")
    whisper_model: str = "tiny"
    ai_provider: str = "demo"
    openai_api_key: str | None = None
    max_upload_mb: int = 50
    algorithm: str = "HS256"
    rate_limit_per_minute: int = 120

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"

    @property
    def public_base_url(self) -> str:
        raw = (self.minuta_base_url or "").strip().rstrip("/")
        if not raw or raw.lower() in {"auto", "lan", "detect"}:
            return f"http://{detect_lan_ip()}:{self.minuta_port}"
        return raw

    @property
    def cors_origin_list(self) -> list[str]:
        value = (self.cors_origins or "*").strip()
        if value == "*":
            return ["*"]
        return [part.strip() for part in value.split(",") if part.strip()]

    def ice_servers(self) -> list[dict]:
        """Build RTCIceServer list for browsers. TURN secrets stay in env, not frontend source."""
        if self.ice_servers_json:
            try:
                parsed = json.loads(self.ice_servers_json)
                if isinstance(parsed, list):
                    return parsed
            except json.JSONDecodeError:
                pass

        servers: list[dict] = []
        stun = [u.strip() for u in self.stun_urls.split(",") if u.strip()]
        if stun:
            servers.append({"urls": stun if len(stun) > 1 else stun[0]})

        if self.turn_url and self.turn_username and self.turn_password:
            servers.append(
                {
                    "urls": self.turn_url,
                    "username": self.turn_username,
                    "credential": self.turn_password,
                }
            )
        return servers


@lru_cache
def get_settings() -> Settings:
    return Settings()


def public_meeting_url(meeting_id: str) -> str:
    """Build a shareable meeting URL from MINUTA_BASE_URL."""
    return f"{get_settings().public_base_url}/meeting/{meeting_id}"
