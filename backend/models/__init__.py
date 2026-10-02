"""SQLAlchemy models."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from backend.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    full_name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    reset_token: Mapped[str | None] = mapped_column(String(100), nullable=True)
    reset_token_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    hosted_meetings: Mapped[list[Meeting]] = relationship(back_populates="host")
    participations: Mapped[list[MeetingParticipant]] = relationship(back_populates="user")


class Meeting(Base):
    __tablename__ = "meetings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    public_id: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    agenda: Mapped[str | None] = mapped_column(Text, nullable=True)
    join_password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    scheduled_start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_minutes: Mapped[int] = mapped_column(Integer, default=60)
    status: Mapped[str] = mapped_column(String(32), default="scheduled")  # scheduled|live|ended|cancelled
    host_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    allow_guest_transcript: Mapped[bool] = mapped_column(Boolean, default=True)
    tags: Mapped[list | None] = mapped_column(JSON, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)

    host: Mapped[User | None] = relationship(back_populates="hosted_meetings")
    participants: Mapped[list[MeetingParticipant]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan"
    )
    transcript: Mapped[Transcript | None] = relationship(
        back_populates="meeting", uselist=False, cascade="all, delete-orphan"
    )
    messages: Mapped[list[MeetingMessage]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan"
    )
    recording: Mapped[Recording | None] = relationship(
        back_populates="meeting", uselist=False, cascade="all, delete-orphan"
    )
    note: Mapped[MeetingNote | None] = relationship(
        back_populates="meeting", uselist=False, cascade="all, delete-orphan"
    )


class MeetingParticipant(Base):
    __tablename__ = "meeting_participants"
    __table_args__ = (UniqueConstraint("meeting_id", "display_name", name="uq_meeting_display"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    meeting_id: Mapped[str] = mapped_column(String(36), ForeignKey("meetings.id"))
    user_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    display_name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(32), default="participant")  # host|participant
    joined_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    left_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    meeting: Mapped[Meeting] = relationship(back_populates="participants")
    user: Mapped[User | None] = relationship(back_populates="participations")


class Transcript(Base):
    __tablename__ = "transcripts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    meeting_id: Mapped[str] = mapped_column(String(36), ForeignKey("meetings.id"), unique=True)
    status: Mapped[str] = mapped_column(String(32), default="draft")  # draft|live|final
    full_text: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    meeting: Mapped[Meeting] = relationship(back_populates="transcript")
    segments: Mapped[list[TranscriptSegment]] = relationship(
        back_populates="transcript", cascade="all, delete-orphan", order_by="TranscriptSegment.start_sec"
    )


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    transcript_id: Mapped[str] = mapped_column(String(36), ForeignKey("transcripts.id"))
    speaker_label: Mapped[str] = mapped_column(String(120), default="Speaker")
    text: Mapped[str] = mapped_column(Text)
    start_sec: Mapped[float] = mapped_column(Float, default=0.0)
    end_sec: Mapped[float | None] = mapped_column(Float, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    highlighted: Mapped[bool] = mapped_column(Boolean, default=False)

    transcript: Mapped[Transcript] = relationship(back_populates="segments")


class MeetingMessage(Base):
    __tablename__ = "meeting_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    meeting_id: Mapped[str] = mapped_column(String(36), ForeignKey("meetings.id"))
    sender_name: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    meeting: Mapped[Meeting] = relationship(back_populates="messages")


class Recording(Base):
    __tablename__ = "recordings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    meeting_id: Mapped[str] = mapped_column(String(36), ForeignKey("meetings.id"), unique=True)
    file_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="idle")  # idle|recording|completed|failed
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)

    meeting: Mapped[Meeting] = relationship(back_populates="recording")


class MeetingNote(Base):
    __tablename__ = "meeting_notes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    meeting_id: Mapped[str] = mapped_column(String(36), ForeignKey("meetings.id"), unique=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    key_points: Mapped[list | None] = mapped_column(JSON, nullable=True)
    topics: Mapped[list | None] = mapped_column(JSON, nullable=True)
    follow_up: Mapped[str | None] = mapped_column(Text, nullable=True)
    important_moments: Mapped[list | None] = mapped_column(JSON, nullable=True)
    raw_markdown: Mapped[str] = mapped_column(Text, default="")
    sentiment: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    meeting: Mapped[Meeting] = relationship(back_populates="note")
    action_items: Mapped[list[ActionItem]] = relationship(
        back_populates="note", cascade="all, delete-orphan"
    )
    decisions: Mapped[list[Decision]] = relationship(
        back_populates="note", cascade="all, delete-orphan"
    )
    questions: Mapped[list[Question]] = relationship(
        back_populates="note", cascade="all, delete-orphan"
    )


class ActionItem(Base):
    __tablename__ = "action_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    note_id: Mapped[str] = mapped_column(String(36), ForeignKey("meeting_notes.id"))
    task: Mapped[str] = mapped_column(Text)
    assignee: Mapped[str] = mapped_column(String(120), default="Unassigned")
    deadline: Mapped[str] = mapped_column(String(120), default="Not specified")
    status: Mapped[str] = mapped_column(String(32), default="open")

    note: Mapped[MeetingNote] = relationship(back_populates="action_items")


class Decision(Base):
    __tablename__ = "decisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    note_id: Mapped[str] = mapped_column(String(36), ForeignKey("meeting_notes.id"))
    text: Mapped[str] = mapped_column(Text)

    note: Mapped[MeetingNote] = relationship(back_populates="decisions")


class Question(Base):
    __tablename__ = "questions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    note_id: Mapped[str] = mapped_column(String(36), ForeignKey("meeting_notes.id"))
    text: Mapped[str] = mapped_column(Text)

    note: Mapped[MeetingNote] = relationship(back_populates="questions")
