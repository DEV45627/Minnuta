"""Legacy + core analyze/transcribe/health endpoints."""

from __future__ import annotations

import tempfile
from datetime import date
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from backend.config import ROOT, get_settings
from backend.schemas import AnalyzeRequest
from backend.services.ai_service import ai_service
from backend.services.transcription_service import transcription_service

router = APIRouter(tags=["core"])
SAMPLES = ROOT / "samples"


@router.get("/api/health")
def health():
    settings = get_settings()
    return {
        "status": "ok",
        "product": "Minuta",
        "tagline": "Meet. Talk. Capture. Understand.",
        "base_url": settings.public_base_url,
    }


@router.get("/api/config/public")
def public_config():
    """Frontend-safe public configuration (no secrets)."""
    from backend.config import detect_lan_ip

    settings = get_settings()
    lan_ip = detect_lan_ip()
    return {
        "product": settings.app_name,
        "environment": settings.environment,
        "base_url": settings.public_base_url,
        "minuta_base_url_setting": settings.minuta_base_url,
        "lan_ip": lan_ip,
        "lan_url": f"http://{lan_ip}:{settings.minuta_port}",
        "local_url": f"http://127.0.0.1:{settings.minuta_port}",
        "port": settings.minuta_port,
        "bind": "0.0.0.0",
        "cors_origins": settings.cors_origins,
        "https_required_for_production": True,
        "mode_note": (
            "Set MINUTA_BASE_URL to your public HTTPS domain for internet invites. "
            "LAN/auto is same-Wi-Fi testing only. STUN alone does not guarantee global WebRTC; configure TURN."
        ),
    }



@router.get("/api/sample")
def sample_transcript():
    path = SAMPLES / "sample_meeting.txt"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Sample transcript not found")
    return {
        "transcript": path.read_text(encoding="utf-8"),
        "title": "Weekly Project Sync",
        "participants": ["Alex", "Jordan", "Sam", "Priya"],
    }


@router.post("/api/analyze")
def analyze(payload: AnalyzeRequest):
    return ai_service.generate_minutes(
        payload.transcript,
        meeting_title=payload.meeting_title,
        meeting_date=payload.meeting_date or str(date.today()),
        participants=payload.participants or None,
    )


@router.post("/api/transcribe")
@router.post("/api/transcription/file")
@router.post("/api/transcription/chunk")
async def transcribe(
    file: UploadFile = File(...),
    model_size: str = Form(None),
):
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    allowed = {".wav", ".mp3", ".m4a", ".ogg", ".webm", ".mp4", ".mpeg", ".mpga"}
    if suffix.lower() not in allowed:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {suffix}")

    content = await file.read()
    max_bytes = 50 * 1024 * 1024
    if len(content) > max_bytes:
        raise HTTPException(status_code=400, detail="File too large (max 50MB)")

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        result = transcription_service.transcribe_file(tmp_path, model_size=model_size)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=503,
            detail=f"Transcription failed or Whisper unavailable: {exc}",
        ) from exc
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    return result
