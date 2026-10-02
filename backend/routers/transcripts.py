"""Transcript persistence and segment editing."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session, joinedload

from backend.database import get_db
from backend.deps import get_optional_user
from backend.models import Meeting, Transcript, TranscriptSegment, User
from backend.schemas import TranscriptSegmentIn, TranscriptSegmentUpdate
from backend.services.rate_limit import rate_limit

router = APIRouter(prefix="/api/transcripts", tags=["transcripts"])


def _meeting(db: Session, public_id: str) -> Meeting:
    m = (
        db.query(Meeting)
        .options(joinedload(Meeting.transcript).joinedload(Transcript.segments))
        .filter(Meeting.public_id == public_id)
        .first()
    )
    if not m:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return m


def _can_view_transcript(meeting: Meeting, user: User | None) -> bool:
    if meeting.allow_guest_transcript:
        return True
    if user and meeting.host_id == user.id:
        return True
    if user and any(p.user_id == user.id for p in (meeting.participants or [])):
        return True
    return False


@router.get("/{public_id}")
def get_transcript(
    public_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    rate_limit(request)
    meeting = _meeting(db, public_id)
    if not _can_view_transcript(meeting, user):
        raise HTTPException(status_code=403, detail="Transcript is private for this meeting")
    t = meeting.transcript
    if not t:
        return {"meeting_id": meeting.public_id, "status": "none", "full_text": "", "segments": []}
    return {
        "meeting_id": meeting.public_id,
        "status": t.status,
        "full_text": t.full_text,
        "segments": [
            {
                "id": s.id,
                "speaker_label": s.speaker_label,
                "text": s.text,
                "start_sec": s.start_sec,
                "end_sec": s.end_sec,
                "confidence": s.confidence,
                "highlighted": s.highlighted,
            }
            for s in t.segments
        ],
    }


@router.post("/{public_id}/segments")
def append_segment(
    public_id: str,
    payload: TranscriptSegmentIn,
    db: Session = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    meeting = _meeting(db, public_id)
    if not meeting.transcript:
        meeting.transcript = Transcript(meeting_id=meeting.id, status="live", full_text="")
        db.add(meeting.transcript)
        db.flush()
    seg = TranscriptSegment(
        transcript_id=meeting.transcript.id,
        speaker_label=payload.speaker_label,
        text=payload.text.strip(),
        start_sec=payload.start_sec,
        end_sec=payload.end_sec,
        confidence=payload.confidence,
    )
    db.add(seg)
    meeting.transcript.full_text = (meeting.transcript.full_text + "\n" + f"{payload.speaker_label}: {payload.text}").strip()
    meeting.transcript.status = "live"
    meeting.transcript.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(seg)
    return {"id": seg.id, "ok": True}


@router.patch("/segments/{segment_id}")
def update_segment(
    segment_id: str,
    payload: TranscriptSegmentUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_optional_user),
):
    seg = db.get(TranscriptSegment, segment_id)
    if not seg:
        raise HTTPException(status_code=404, detail="Segment not found")
    if payload.text is not None:
        seg.text = payload.text
    if payload.speaker_label is not None:
        seg.speaker_label = payload.speaker_label
    if payload.highlighted is not None:
        seg.highlighted = payload.highlighted
    db.commit()
    return {"ok": True}


@router.put("/{public_id}/full")
def replace_full_text(public_id: str, body: dict, db: Session = Depends(get_db)):
    meeting = _meeting(db, public_id)
    text = (body.get("full_text") or "").strip()
    if not meeting.transcript:
        meeting.transcript = Transcript(meeting_id=meeting.id, status="final", full_text=text)
        db.add(meeting.transcript)
    else:
        meeting.transcript.full_text = text
        meeting.transcript.status = "final"
        meeting.transcript.updated_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "full_text": text}
