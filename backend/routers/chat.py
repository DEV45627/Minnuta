"""Chat history."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import Meeting, MeetingMessage
from backend.schemas import ChatMessageIn

router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.get("/{public_id}")
def list_messages(public_id: str, db: Session = Depends(get_db)):
    meeting = db.query(Meeting).filter(Meeting.public_id == public_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    messages = (
        db.query(MeetingMessage)
        .filter(MeetingMessage.meeting_id == meeting.id)
        .order_by(MeetingMessage.created_at.asc())
        .all()
    )
    return [
        {
            "id": m.id,
            "sender_name": m.sender_name,
            "body": m.body,
            "created_at": m.created_at.isoformat(),
        }
        for m in messages
    ]


@router.post("/{public_id}")
def post_message(public_id: str, payload: ChatMessageIn, db: Session = Depends(get_db)):
    meeting = db.query(Meeting).filter(Meeting.public_id == public_id).first()
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    msg = MeetingMessage(
        meeting_id=meeting.id,
        sender_name=payload.sender_name.strip(),
        body=payload.body.strip(),
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return {
        "id": msg.id,
        "sender_name": msg.sender_name,
        "body": msg.body,
        "created_at": msg.created_at.isoformat(),
    }
