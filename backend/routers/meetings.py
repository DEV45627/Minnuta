"""Meetings CRUD and lifecycle."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session, joinedload

from backend.config import get_settings, public_meeting_url
from backend.database import get_db
from backend.deps import get_current_user, get_optional_user
from backend.models import Meeting, MeetingParticipant, User
from backend.schemas import MeetingCreate, MeetingUpdate, JoinMeetingRequest
from backend.services.meeting_service import create_meeting, meeting_to_dict
from backend.services.auth_service import verify_password
from backend.services.rate_limit import rate_limit

router = APIRouter(prefix="/api/meetings", tags=["meetings"])


def _base(_request: Request | None = None) -> str:
    return get_settings().public_base_url


def _load(db: Session, public_id: str) -> Meeting:
    meeting = (
        db.query(Meeting)
        .options(
            joinedload(Meeting.participants),
            joinedload(Meeting.transcript),
            joinedload(Meeting.note),
            joinedload(Meeting.recording),
        )
        .filter(Meeting.public_id == public_id)
        .first()
    )
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return meeting


@router.get("")
def list_meetings(
    request: Request,
    status: str | None = None,
    q: str | None = None,
    filter: str | None = Query(None, alias="filter"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = (
        db.query(Meeting)
        .options(
            joinedload(Meeting.participants),
            joinedload(Meeting.transcript),
            joinedload(Meeting.note),
            joinedload(Meeting.recording),
        )
        .filter((Meeting.host_id == user.id) | Meeting.participants.any(MeetingParticipant.user_id == user.id))
    )
    if status:
        query = query.filter(Meeting.status == status)
    if filter == "upcoming":
        query = query.filter(Meeting.status.in_(["scheduled", "live"]))
    elif filter == "completed":
        query = query.filter(Meeting.status == "ended")
    elif filter == "recorded":
        query = query.filter(Meeting.recording.has())
    elif filter == "has_transcript":
        query = query.filter(Meeting.transcript.has())
    elif filter == "has_notes":
        query = query.filter(Meeting.note.has())
    if q:
        like = f"%{q}%"
        query = query.filter(Meeting.title.ilike(like) | Meeting.description.ilike(like))
    meetings = query.order_by(Meeting.created_at.desc()).all()
    base = _base(request)
    return [meeting_to_dict(m, base) for m in meetings]


@router.post("")
def create(
    payload: MeetingCreate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rate_limit(request, limit=30)
    meeting = create_meeting(
        db,
        title=payload.title,
        host_id=user.id,
        description=payload.description,
        agenda=payload.agenda,
        scheduled_start=payload.scheduled_start,
        duration_minutes=payload.duration_minutes,
        participants=payload.participants,
        tags=payload.tags,
        join_password=payload.join_password,
    )
    meeting = _load(db, meeting.public_id)
    return meeting_to_dict(meeting, _base(request))


@router.get("/{public_id}")
def get_meeting(
    public_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    meeting = _load(db, public_id)
    return meeting_to_dict(meeting, _base(request))


@router.patch("/{public_id}")
def update_meeting(
    public_id: str,
    payload: MeetingUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    meeting = _load(db, public_id)
    if meeting.host_id != user.id:
        raise HTTPException(status_code=403, detail="Only the host can edit this meeting")
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(meeting, key, value)
    db.commit()
    meeting = _load(db, public_id)
    return meeting_to_dict(meeting, _base(request))


@router.post("/{public_id}/start")
def start_meeting(
    public_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    meeting = _load(db, public_id)
    if meeting.host_id != user.id:
        raise HTTPException(status_code=403, detail="Only the host can start the meeting")
    meeting.status = "live"
    meeting.started_at = datetime.utcnow()
    db.commit()
    return meeting_to_dict(_load(db, public_id), _base(request))


@router.post("/{public_id}/end")
def end_meeting(
    public_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    meeting = _load(db, public_id)
    if meeting.host_id != user.id:
        raise HTTPException(status_code=403, detail="Only the host can end the meeting")
    meeting.status = "ended"
    meeting.ended_at = datetime.utcnow()
    db.commit()
    return meeting_to_dict(_load(db, public_id), _base(request))


@router.get("/{public_id}/link")
def meeting_link(public_id: str, db: Session = Depends(get_db)):
    meeting = _load(db, public_id)
    link = public_meeting_url(meeting.public_id)
    return {
        "title": meeting.title,
        "public_id": meeting.public_id,
        "link": link,
        "share_text": f"Join '{meeting.title}' on Minuta: {link}",
    }


@router.post("/{public_id}/join")
def join_meeting(
    public_id: str,
    request: Request,
    payload: JoinMeetingRequest,
    db: Session = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    rate_limit(request, limit=60)
    meeting = _load(db, public_id)
    if meeting.status == "ended":
        raise HTTPException(status_code=400, detail="This meeting has ended")
    if meeting.status == "cancelled":
        raise HTTPException(status_code=400, detail="This meeting was cancelled")

    name = payload.display_name
    password = payload.join_password
    if not name or not name.strip():
        raise HTTPException(status_code=400, detail="Display name is required")

    if meeting.join_password_hash:
        if not password or not verify_password(password, meeting.join_password_hash):
            raise HTTPException(status_code=403, detail="Invalid meeting password")

    existing = next(
        (p for p in meeting.participants if p.display_name.lower() == name.lower()),
        None,
    )
    if not existing:
        existing = MeetingParticipant(
            meeting_id=meeting.id,
            user_id=user.id if user else None,
            display_name=name.strip(),
            role="host" if user and meeting.host_id == user.id else "participant",
            joined_at=datetime.utcnow(),
        )
        db.add(existing)
    else:
        existing.joined_at = datetime.utcnow()
        existing.left_at = None
        if user:
            existing.user_id = user.id
    if meeting.status == "scheduled":
        meeting.status = "live"
        meeting.started_at = meeting.started_at or datetime.utcnow()
    db.commit()
    return {
        "meeting": meeting_to_dict(_load(db, public_id), _base(request)),
        "participant": {
            "id": existing.id,
            "display_name": existing.display_name,
            "role": existing.role,
        },
    }
