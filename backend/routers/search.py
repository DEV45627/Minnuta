"""Global search."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session, joinedload

from backend.database import get_db
from backend.deps import get_current_user
from backend.models import ActionItem, Meeting, MeetingNote, Transcript, TranscriptSegment, User

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
def search(
    q: str = Query(..., min_length=2),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    like = f"%{q}%"
    results = []

    meetings = (
        db.query(Meeting)
        .filter(Meeting.host_id == user.id, Meeting.title.ilike(like))
        .limit(20)
        .all()
    )
    for m in meetings:
        results.append(
            {
                "type": "meeting",
                "title": m.title,
                "public_id": m.public_id,
                "snippet": m.description or m.agenda or "",
            }
        )

    segments = (
        db.query(TranscriptSegment)
        .join(Transcript)
        .join(Meeting)
        .filter(Meeting.host_id == user.id, TranscriptSegment.text.ilike(like))
        .limit(20)
        .all()
    )
    for s in segments:
        meeting = s.transcript.meeting
        results.append(
            {
                "type": "transcript",
                "title": meeting.title,
                "public_id": meeting.public_id,
                "snippet": f"{s.speaker_label}: {s.text[:160]}",
            }
        )

    notes = (
        db.query(MeetingNote)
        .join(Meeting)
        .filter(Meeting.host_id == user.id, MeetingNote.summary.ilike(like) | MeetingNote.raw_markdown.ilike(like))
        .limit(20)
        .all()
    )
    for n in notes:
        results.append(
            {
                "type": "notes",
                "title": n.meeting.title,
                "public_id": n.meeting.public_id,
                "snippet": (n.summary or "")[:160],
            }
        )

    actions = (
        db.query(ActionItem)
        .join(MeetingNote)
        .join(Meeting)
        .filter(Meeting.host_id == user.id, ActionItem.task.ilike(like) | ActionItem.assignee.ilike(like))
        .limit(20)
        .all()
    )
    for a in actions:
        results.append(
            {
                "type": "action_item",
                "title": a.note.meeting.title,
                "public_id": a.note.meeting.public_id,
                "snippet": f"{a.task} — {a.assignee}",
            }
        )

    return {"query": q, "results": results}
