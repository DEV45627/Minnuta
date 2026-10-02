"""Export transcripts and notes."""

from __future__ import annotations

import io

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session, joinedload

from backend.database import get_db
from backend.models import Meeting, MeetingNote

router = APIRouter(prefix="/api/export", tags=["export"])


def _meeting(db: Session, public_id: str) -> Meeting:
    m = (
        db.query(Meeting)
        .options(
            joinedload(Meeting.transcript),
            joinedload(Meeting.note).joinedload(MeetingNote.action_items),
            joinedload(Meeting.note).joinedload(MeetingNote.decisions),
        )
        .filter(Meeting.public_id == public_id)
        .first()
    )
    if not m:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return m


@router.get("/{public_id}/transcript.txt")
def export_transcript_txt(public_id: str, db: Session = Depends(get_db)):
    meeting = _meeting(db, public_id)
    text = meeting.transcript.full_text if meeting.transcript else ""
    return Response(
        content=text or "No transcript available.",
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{public_id}-transcript.txt"'},
    )


@router.get("/{public_id}/transcript.md")
def export_transcript_md(public_id: str, db: Session = Depends(get_db)):
    meeting = _meeting(db, public_id)
    lines = [f"# Transcript — {meeting.title}", ""]
    if meeting.transcript and meeting.transcript.segments:
        for s in meeting.transcript.segments:
            mins = int(s.start_sec // 60)
            secs = int(s.start_sec % 60)
            lines.append(f"**{mins:02d}:{secs:02d} — {s.speaker_label}**")
            lines.append("")
            lines.append(s.text)
            lines.append("")
    else:
        lines.append(meeting.transcript.full_text if meeting.transcript else "_No transcript_")
    body = "\n".join(lines)
    return Response(
        content=body,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{public_id}-transcript.md"'},
    )


@router.get("/{public_id}/notes.md")
def export_notes_md(public_id: str, db: Session = Depends(get_db)):
    meeting = _meeting(db, public_id)
    if not meeting.note:
        raise HTTPException(status_code=404, detail="Notes not found")
    body = meeting.note.raw_markdown or meeting.note.summary
    return Response(
        content=body,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{public_id}-notes.md"'},
    )


@router.get("/{public_id}/notes.pdf")
def export_notes_pdf(public_id: str, db: Session = Depends(get_db)):
    meeting = _meeting(db, public_id)
    if not meeting.note:
        raise HTTPException(status_code=404, detail="Notes not found")

    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="PDF export requires reportlab. Install with: pip install reportlab",
        ) from exc

    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=letter)
    width, height = letter
    y = height - 50
    c.setFont("Helvetica-Bold", 14)
    c.drawString(40, y, meeting.title[:80])
    y -= 28
    c.setFont("Helvetica", 10)
    text = meeting.note.raw_markdown or meeting.note.summary or ""
    for raw_line in text.splitlines():
        line = raw_line[:110]
        if y < 50:
            c.showPage()
            c.setFont("Helvetica", 10)
            y = height - 50
        c.drawString(40, y, line)
        y -= 14
    c.save()
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{public_id}-notes.pdf"'},
    )
