"""HTML page routes."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend.config import ROOT

router = APIRouter(tags=["pages"])
WEB = ROOT / "web"
PAGES = WEB / "pages"


def _page(name: str) -> FileResponse:
    path = PAGES / name
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Page not found: {name}")
    return FileResponse(path)


@router.get("/")
def landing():
    return FileResponse(WEB / "index.html")


@router.get("/login")
def login_page():
    return _page("login.html")


@router.get("/register")
def register_page():
    return _page("register.html")


@router.get("/forgot-password")
def forgot_page():
    return _page("forgot-password.html")


@router.get("/reset-password")
def reset_page():
    return _page("reset-password.html")


@router.get("/dashboard")
def dashboard_page():
    return _page("dashboard.html")


@router.get("/meetings")
def meetings_page():
    return _page("meetings.html")


@router.get("/meetings/create")
def meetings_create_page():
    return _page("meeting-create.html")


@router.get("/meetings/{public_id}")
def meeting_details_page(public_id: str):
    return _page("meeting-details.html")


@router.get("/meeting/{public_id}")
def meeting_join_page(public_id: str):
    return _page("meeting-room.html")


@router.get("/join/{public_id}")
def join_alias(public_id: str):
    return _page("meeting-room.html")


@router.get("/calendar")
def calendar_page():
    return _page("calendar.html")


@router.get("/transcripts")
def transcripts_page():
    return _page("transcripts.html")


@router.get("/notes")
def notes_page():
    return _page("notes.html")


@router.get("/settings")
def settings_page():
    return _page("settings.html")


@router.get("/profile")
def profile_page():
    return _page("profile.html")


@router.get("/tools")
def tools_page():
    return _page("tools.html")


@router.get("/demo")
def demo_page():
    return _page("demo.html")
