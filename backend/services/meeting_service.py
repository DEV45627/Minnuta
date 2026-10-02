"""Meeting domain helpers."""

from __future__ import annotations

import secrets
import string
from datetime import datetime

from sqlalchemy.orm import Session

from backend.config import public_meeting_url
from backend.models import Meeting, MeetingParticipant, Transcript
from backend.services.auth_service import hash_password


def generate_public_id(length: int = 8) -> str:
    """Cryptographically random meeting ID (not sequential)."""
    alphabet = string.ascii_uppercase + string.digits
    # Avoid ambiguous chars
    alphabet = alphabet.replace("O", "").replace("0", "").replace("I", "").replace("1", "")
    return "".join(secrets.choice(alphabet) for _ in range(length))


def meeting_to_dict(meeting: Meeting, base_url: str | None = None) -> dict:
    """Serialize a meeting. Shareable `link` always uses MINUTA_BASE_URL."""
    _ = base_url  # kept for call-site compatibility; ignored on purpose
    return {
        "id": meeting.id,
        "public_id": meeting.public_id,
        "title": meeting.title,
        "description": meeting.description,
        "agenda": meeting.agenda,
        "scheduled_start": meeting.scheduled_start.isoformat() if meeting.scheduled_start else None,
        "duration_minutes": meeting.duration_minutes,
        "status": meeting.status,
        "host_id": meeting.host_id,
        "allow_guest_transcript": meeting.allow_guest_transcript,
        "requires_password": bool(meeting.join_password_hash),
        "tags": meeting.tags or [],
        "started_at": meeting.started_at.isoformat() if meeting.started_at else None,
        "ended_at": meeting.ended_at.isoformat() if meeting.ended_at else None,
        "created_at": meeting.created_at.isoformat() if meeting.created_at else None,
        "is_demo": meeting.is_demo,
        "participant_count": len(meeting.participants or []),
        "has_transcript": bool(meeting.transcript and (meeting.transcript.full_text or meeting.transcript.segments)),
        "has_notes": meeting.note is not None,
        "has_recording": bool(meeting.recording and meeting.recording.status == "completed"),
        "link": public_meeting_url(meeting.public_id),
        "participants": [
            {
                "id": p.id,
                "display_name": p.display_name,
                "role": p.role,
                "user_id": p.user_id,
            }
            for p in (meeting.participants or [])
        ],
    }


def create_meeting(
    db: Session,
    *,
    title: str,
    host_id: str | None,
    description: str | None = None,
    agenda: str | None = None,
    scheduled_start: datetime | None = None,
    duration_minutes: int = 60,
    participants: list[str] | None = None,
    tags: list[str] | None = None,
    is_demo: bool = False,
    join_password: str | None = None,
) -> Meeting:
    public_id = generate_public_id()
    while db.query(Meeting).filter(Meeting.public_id == public_id).first():
        public_id = generate_public_id()

    meeting = Meeting(
        public_id=public_id,
        title=title,
        description=description,
        agenda=agenda,
        scheduled_start=scheduled_start,
        duration_minutes=duration_minutes,
        host_id=host_id,
        tags=tags or [],
        is_demo=is_demo,
        status="scheduled",
        join_password_hash=hash_password(join_password) if join_password else None,
    )
    db.add(meeting)
    db.flush()

    host_name = None
    if host_id:
        host = db.get(__import__("backend.models", fromlist=["User"]).User, host_id)
        host_name = host.full_name if host else "Host"
        db.add(
            MeetingParticipant(
                meeting_id=meeting.id,
                user_id=host_id,
                display_name=host_name,
                role="host",
            )
        )

    for name in participants or []:
        name = name.strip()
        if not name:
            continue
        if host_name and name.lower() == host_name.lower():
            continue
        db.add(
            MeetingParticipant(
                meeting_id=meeting.id,
                display_name=name,
                role="participant",
            )
        )

    db.add(Transcript(meeting_id=meeting.id, status="draft", full_text=""))
    db.commit()
    db.refresh(meeting)
    return meeting
