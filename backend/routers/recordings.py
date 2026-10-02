"""Recording metadata and upload."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, joinedload

from backend.database import get_db
from backend.deps import get_current_user
from backend.models import Meeting, Recording, User
from backend.services.storage_service import storage_service

router = APIRouter(prefix="/api/recordings", tags=["recordings"])


def _meeting(db: Session, public_id: str) -> Meeting:
    m = (
        db.query(Meeting)
        .options(joinedload(Meeting.recording))
        .filter(Meeting.public_id == public_id)
        .first()
    )
    if not m:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return m


@router.get("/{public_id}")
def get_recording(public_id: str, db: Session = Depends(get_db)):
    meeting = _meeting(db, public_id)
    r = meeting.recording
    if not r:
        return {"status": "none"}
    return {
        "id": r.id,
        "status": r.status,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "ended_at": r.ended_at.isoformat() if r.ended_at else None,
        "duration_seconds": r.duration_seconds,
        "has_file": bool(r.file_path and Path(r.file_path).exists()),
    }


@router.post("/{public_id}/start")
def start_recording(
    public_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    meeting = _meeting(db, public_id)
    if meeting.host_id != user.id:
        raise HTTPException(status_code=403, detail="Only the host can start recording")
    if not meeting.recording:
        meeting.recording = Recording(meeting_id=meeting.id)
        db.add(meeting.recording)
    meeting.recording.status = "recording"
    meeting.recording.started_at = datetime.utcnow()
    meeting.recording.ended_at = None
    db.commit()
    return {"status": "recording", "message": "Recording started. All participants should be informed."}


@router.post("/{public_id}/stop")
async def stop_recording(
    public_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    file: UploadFile | None = File(None),
):
    meeting = _meeting(db, public_id)
    if meeting.host_id != user.id:
        raise HTTPException(status_code=403, detail="Only the host can stop recording")
    if not meeting.recording:
        raise HTTPException(status_code=400, detail="Recording was not started")

    rec = meeting.recording
    if file is not None:
        suffix = Path(file.filename or "recording.webm").suffix or ".webm"
        path = storage_service.recording_path(meeting.id, f"recording{suffix}")
        path.write_bytes(await file.read())
        rec.file_path = str(path)

    rec.status = "completed"
    rec.ended_at = datetime.utcnow()
    if rec.started_at:
        rec.duration_seconds = int((rec.ended_at - rec.started_at).total_seconds())
    db.commit()
    return {"status": "completed", "duration_seconds": rec.duration_seconds}


@router.get("/{public_id}/download")
def download_recording(public_id: str, db: Session = Depends(get_db)):
    meeting = _meeting(db, public_id)
    if not meeting.recording or not meeting.recording.file_path:
        raise HTTPException(status_code=404, detail="Recording file not found")
    path = Path(meeting.recording.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Recording file missing on disk")
    return FileResponse(path, filename=path.name)
