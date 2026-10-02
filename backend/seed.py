"""Demo seed data."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from backend.config import ROOT
from backend.models import (
    ActionItem,
    Decision,
    Meeting,
    MeetingNote,
    Question,
    Transcript,
    TranscriptSegment,
    User,
)
from backend.services.auth_service import hash_password
from backend.services.meeting_service import create_meeting


DEMO_EMAIL = "demo@minuta.local"
DEMO_PASSWORD = "demo12345"


def ensure_demo_user(db: Session) -> User:
    user = db.query(User).filter(User.email == DEMO_EMAIL).first()
    if user:
        return user
    user = User(
        full_name="Demo Host",
        email=DEMO_EMAIL,
        password_hash=hash_password(DEMO_PASSWORD),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def ensure_demo_meeting(db: Session) -> Meeting:
    existing = db.query(Meeting).filter(Meeting.is_demo.is_(True)).first()
    if existing:
        return existing

    host = ensure_demo_user(db)
    sample_path = ROOT / "samples" / "sample_meeting.txt"
    transcript_text = sample_path.read_text(encoding="utf-8") if sample_path.exists() else (
        "Alex: We decided to ship the beta on September 5.\n"
        "Priya: I will prepare the UI prototype by Friday.\n"
        "Rahul: I will design the database by Monday."
    )

    meeting = create_meeting(
        db,
        title="M.Sc. Capstone Project Discussion",
        host_id=host.id,
        description="Demo meeting showcasing Minuta transcripts and AI notes.",
        agenda="1. Architecture\n2. Frontend plan\n3. Action items",
        scheduled_start=datetime.utcnow() - timedelta(days=1),
        duration_minutes=45,
        participants=["Shakshi", "Rahul", "Priya", "Alex"],
        tags=["demo", "capstone"],
        is_demo=True,
    )
    meeting.status = "ended"
    meeting.started_at = meeting.scheduled_start
    meeting.ended_at = meeting.scheduled_start + timedelta(minutes=45)

    if not meeting.transcript:
        meeting.transcript = Transcript(meeting_id=meeting.id)
        db.add(meeting.transcript)
        db.flush()

    meeting.transcript.full_text = transcript_text
    meeting.transcript.status = "final"

    # Clear old segments if any
    for seg in list(meeting.transcript.segments or []):
        db.delete(seg)

    t = 0.0
    for line in transcript_text.splitlines():
        line = line.strip()
        if not line:
            continue
        if ":" in line:
            speaker, text = line.split(":", 1)
        else:
            speaker, text = "Speaker", line
        db.add(
            TranscriptSegment(
                transcript_id=meeting.transcript.id,
                speaker_label=speaker.strip(),
                text=text.strip(),
                start_sec=t,
                end_sec=t + 8,
            )
        )
        t += 8

    note = MeetingNote(
        meeting_id=meeting.id,
        summary=(
            "The team aligned on using a browser-based Minuta stack with FastAPI and "
            "structured AI notes for the capstone demonstration."
        ),
        key_points=[
            "Use React discussion noted; platform ships with modular HTML/JS MVP",
            "Database design assigned to Rahul",
            "UI prototype assigned to Priya",
            "Beta target remains on the agreed timeline",
        ],
        topics=["architecture", "frontend", "database", "demo"],
        follow_up="Confirm prototype review in the next sync and validate action deadlines.",
        important_moments=[
            {"timestamp": "03:42", "text": "We should use React for the frontend."},
            {"timestamp": "03:48", "text": "I'll work on the database design."},
        ],
        raw_markdown="",
        sentiment={"label": "Positive", "compound": 0.8},
        updated_at=datetime.utcnow(),
    )
    db.add(note)
    db.flush()

    db.add(ActionItem(note_id=note.id, task="Prepare UI prototype", assignee="Priya", deadline="Friday"))
    db.add(ActionItem(note_id=note.id, task="Design database", assignee="Rahul", deadline="Monday"))
    db.add(Decision(note_id=note.id, text="Proceed with Minuta as the capstone meeting platform demo."))
    db.add(Question(note_id=note.id, text="Any blockers before the next review?"))

    note.raw_markdown = (
        f"# {meeting.title}\n\n**Date:** {(meeting.scheduled_start or datetime.utcnow()).date()}\n\n"
        f"## Summary\n{note.summary}\n\n## Key Points\n"
        + "\n".join(f"- {p}" for p in note.key_points)
        + "\n\n## Action Items\n| Task | Assigned To | Deadline |\n| --- | --- | --- |\n"
        + "| Prepare UI prototype | Priya | Friday |\n| Design database | Rahul | Monday |\n"
    )

    db.commit()
    db.refresh(meeting)
    return meeting
