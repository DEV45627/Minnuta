"""Pydantic schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    confirm_password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    password: str = Field(min_length=8)
    confirm_password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict[str, Any]


class UserOut(BaseModel):
    id: str
    full_name: str
    email: str
    avatar_url: str | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class ProfileUpdate(BaseModel):
    full_name: str | None = None
    avatar_url: str | None = None


class MeetingCreate(BaseModel):
    title: str = Field(min_length=2, max_length=255)
    description: str | None = None
    agenda: str | None = None
    scheduled_start: datetime | None = None
    duration_minutes: int = Field(default=60, ge=5, le=480)
    participants: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    join_password: str | None = Field(default=None, max_length=128)


class MeetingUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    agenda: str | None = None
    scheduled_start: datetime | None = None
    duration_minutes: int | None = None
    status: str | None = None
    tags: list[str] | None = None
    allow_guest_transcript: bool | None = None


class MeetingOut(BaseModel):
    id: str
    public_id: str
    title: str
    description: str | None = None
    agenda: str | None = None
    scheduled_start: datetime | None = None
    duration_minutes: int
    status: str
    host_id: str | None = None
    allow_guest_transcript: bool = True
    tags: list | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    created_at: datetime | None = None
    is_demo: bool = False
    participant_count: int = 0
    has_transcript: bool = False
    has_notes: bool = False
    has_recording: bool = False
    link: str | None = None

    model_config = {"from_attributes": True}


class AnalyzeRequest(BaseModel):
    transcript: str = Field(..., min_length=20)
    meeting_title: str | None = "Weekly Project Sync"
    meeting_date: str | None = None
    participants: list[str] = Field(default_factory=list)


class TranscriptSegmentIn(BaseModel):
    speaker_label: str = "Speaker"
    text: str
    start_sec: float = 0
    end_sec: float | None = None
    confidence: float | None = None


class TranscriptSegmentUpdate(BaseModel):
    text: str | None = None
    speaker_label: str | None = None
    highlighted: bool | None = None


class ChatMessageIn(BaseModel):
    body: str = Field(min_length=1, max_length=2000)
    sender_name: str = Field(min_length=1, max_length=120)


class JoinMeetingRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)
    join_password: str | None = None

