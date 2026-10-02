"""Demo endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session, joinedload

from backend.database import get_db
from backend.models import Meeting, MeetingNote
from backend.seed import DEMO_EMAIL, DEMO_PASSWORD, ensure_demo_meeting, ensure_demo_user
from backend.services.auth_service import create_access_token
from backend.services.meeting_service import meeting_to_dict

router = APIRouter(prefix="/api/demo", tags=["demo"])


@router.post("/bootstrap")
def bootstrap(db: Session = Depends(get_db)):
    user = ensure_demo_user(db)
    meeting = ensure_demo_meeting(db)
    meeting = (
        db.query(Meeting)
        .options(
            joinedload(Meeting.participants),
            joinedload(Meeting.transcript),
            joinedload(Meeting.note).joinedload(MeetingNote.action_items),
            joinedload(Meeting.note).joinedload(MeetingNote.decisions),
            joinedload(Meeting.note).joinedload(MeetingNote.questions),
            joinedload(Meeting.recording),
        )
        .filter(Meeting.id == meeting.id)
        .first()
    )
    token = create_access_token(user.id)
    data = meeting_to_dict(meeting)
    return {
        "user": {"id": user.id, "full_name": user.full_name, "email": user.email},
        "credentials": {"email": DEMO_EMAIL, "password": DEMO_PASSWORD},
        "access_token": token,
        "meeting": data,
        "demo_url": f"{data['link'].rsplit('/meeting/', 1)[0]}/demo",
        "meeting_url": f"/meetings/{meeting.public_id}",
    }


@router.get("/meeting")
def demo_meeting(db: Session = Depends(get_db)):
    meeting = ensure_demo_meeting(db)
    meeting = (
        db.query(Meeting)
        .options(
            joinedload(Meeting.participants),
            joinedload(Meeting.transcript),
            joinedload(Meeting.note).joinedload(MeetingNote.action_items),
            joinedload(Meeting.note).joinedload(MeetingNote.decisions),
            joinedload(Meeting.note).joinedload(MeetingNote.questions),
            joinedload(Meeting.recording),
        )
        .filter(Meeting.id == meeting.id)
        .first()
    )
    note = None
    if meeting.note:
        n = meeting.note
        note = {
            "summary": n.summary,
            "key_points": n.key_points,
            "topics": n.topics,
            "follow_up": n.follow_up,
            "important_moments": n.important_moments,
            "raw_markdown": n.raw_markdown,
            "action_items": [
                {"task": a.task, "assignee": a.assignee, "deadline": a.deadline, "status": a.status}
                for a in n.action_items
            ],
            "decisions": [d.text for d in n.decisions],
            "questions": [q.text for q in n.questions],
        }
    transcript = None
    if meeting.transcript:
        transcript = {
            "full_text": meeting.transcript.full_text,
            "segments": [
                {
                    "speaker_label": s.speaker_label,
                    "text": s.text,
                    "start_sec": s.start_sec,
                }
                for s in meeting.transcript.segments
            ],
        }
    return {
        "meeting": meeting_to_dict(meeting),
        "note": note,
        "transcript": transcript,
    }
