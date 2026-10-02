"""AI notes generation and retrieval."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from backend.database import get_db
from backend.deps import get_current_user, get_optional_user
from backend.models import ActionItem, Decision, Meeting, MeetingNote, Question, User
from backend.services.ai_service import ai_service

router = APIRouter(prefix="/api/notes", tags=["notes"])


def _meeting(db: Session, public_id: str) -> Meeting:
    m = (
        db.query(Meeting)
        .options(
            joinedload(Meeting.transcript),
            joinedload(Meeting.note).joinedload(MeetingNote.action_items),
            joinedload(Meeting.note).joinedload(MeetingNote.decisions),
            joinedload(Meeting.note).joinedload(MeetingNote.questions),
            joinedload(Meeting.participants),
        )
        .filter(Meeting.public_id == public_id)
        .first()
    )
    if not m:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return m


def _note_dict(note: MeetingNote) -> dict:
    return {
        "id": note.id,
        "summary": note.summary,
        "key_points": note.key_points or [],
        "topics": note.topics or [],
        "follow_up": note.follow_up,
        "important_moments": note.important_moments or [],
        "raw_markdown": note.raw_markdown,
        "sentiment": note.sentiment,
        "updated_at": note.updated_at.isoformat() if note.updated_at else None,
        "action_items": [
            {
                "id": a.id,
                "task": a.task,
                "assignee": a.assignee,
                "deadline": a.deadline,
                "status": a.status,
            }
            for a in note.action_items
        ],
        "decisions": [{"id": d.id, "text": d.text} for d in note.decisions],
        "questions": [{"id": q.id, "text": q.text} for q in note.questions],
    }


@router.get("")
def list_notes(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    meetings = (
        db.query(Meeting)
        .options(joinedload(Meeting.note).joinedload(MeetingNote.action_items))
        .filter(Meeting.host_id == user.id, Meeting.note.has())
        .order_by(Meeting.created_at.desc())
        .all()
    )
    out = []
    for m in meetings:
        n = m.note
        out.append(
            {
                "meeting_public_id": m.public_id,
                "meeting_title": m.title,
                "date": (m.scheduled_start or m.created_at).isoformat() if (m.scheduled_start or m.created_at) else None,
                "summary_preview": (n.summary or "")[:180],
                "action_item_count": len(n.action_items or []),
                "updated_at": n.updated_at.isoformat() if n.updated_at else None,
            }
        )
    return out


@router.get("/{public_id}")
def get_notes(public_id: str, db: Session = Depends(get_db)):
    meeting = _meeting(db, public_id)
    if not meeting.note:
        return {"meeting_id": public_id, "note": None}
    return {"meeting_id": public_id, "note": _note_dict(meeting.note)}


@router.post("/{public_id}/generate")
def generate_notes(
    public_id: str,
    db: Session = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    meeting = _meeting(db, public_id)
    text = ""
    if meeting.transcript:
        text = meeting.transcript.full_text or ""
        if not text and meeting.transcript.segments:
            text = "\n".join(f"{s.speaker_label}: {s.text}" for s in meeting.transcript.segments)
    if len(text.strip()) < 20:
        raise HTTPException(status_code=400, detail="Transcript is too short to generate notes")

    participants = [p.display_name for p in meeting.participants]
    result = ai_service.generate_minutes(
        text,
        meeting_title=meeting.title,
        meeting_date=(meeting.scheduled_start or meeting.created_at or datetime.utcnow()).strftime("%Y-%m-%d"),
        participants=participants,
    )
    analysis = result["analysis"]

    if meeting.note:
        note = meeting.note
        for collection in (note.action_items, note.decisions, note.questions):
            for item in list(collection):
                db.delete(item)
    else:
        note = MeetingNote(meeting_id=meeting.id)
        db.add(note)
        db.flush()

    note.summary = analysis.get("summary") or ""
    note.key_points = analysis.get("key_points") or analysis.get("discussion_points") or []
    note.topics = analysis.get("topics") or []
    note.follow_up = analysis.get("follow_up")
    note.important_moments = analysis.get("important_moments") or []
    note.raw_markdown = result["minutes_markdown"]
    note.sentiment = analysis.get("sentiment")
    note.updated_at = datetime.utcnow()

    for item in analysis.get("action_items") or []:
        db.add(
            ActionItem(
                note_id=note.id,
                task=item.get("task", ""),
                assignee=item.get("assignee", "Unassigned"),
                deadline=item.get("deadline", "Not specified"),
            )
        )
    for d in analysis.get("decisions") or []:
        db.add(Decision(note_id=note.id, text=d if isinstance(d, str) else str(d)))
    for q in analysis.get("questions") or []:
        db.add(Question(note_id=note.id, text=q if isinstance(q, str) else str(q)))

    db.commit()
    meeting = _meeting(db, public_id)
    return {"meeting_id": public_id, "note": _note_dict(meeting.note), "provider": "demo"}


@router.patch("/{public_id}")
def update_notes(public_id: str, body: dict, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    meeting = _meeting(db, public_id)
    if meeting.host_id != user.id:
        raise HTTPException(status_code=403, detail="Only the host can edit notes")
    if not meeting.note:
        raise HTTPException(status_code=404, detail="Notes not found")
    note = meeting.note
    if "summary" in body:
        note.summary = body["summary"]
    if "raw_markdown" in body:
        note.raw_markdown = body["raw_markdown"]
    if "follow_up" in body:
        note.follow_up = body["follow_up"]
    note.updated_at = datetime.utcnow()
    db.commit()
    return {"note": _note_dict(note)}
