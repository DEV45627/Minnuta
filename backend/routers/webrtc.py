"""WebRTC ICE configuration (STUN/TURN) served to clients at join time."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.database import get_db
from backend.models import Meeting

router = APIRouter(prefix="/api/webrtc", tags=["webrtc"])


@router.get("/ice")
def get_ice_servers(
    meeting_id: str | None = Query(None, description="Optional meeting public_id"),
    db: Session = Depends(get_db),
):
    """
    Return ICE servers for the browser RTCPeerConnection.

    STUN alone is often enough on open networks. Across restrictive NATs/firewalls,
    TURN (relay) is required. TURN credentials are read from server env and returned
    only via this API — they are not hard-coded in frontend source.

    Note: WebRTC clients must receive ICE config in the browser to connect; this
    endpoint is the controlled delivery path. Prefer short-lived TURN credentials
    from your TURN provider in production.
    """
    if meeting_id:
        meeting = db.query(Meeting).filter(Meeting.public_id == meeting_id).first()
        if not meeting:
            raise HTTPException(status_code=404, detail="Meeting not found")
        if meeting.status == "ended":
            raise HTTPException(status_code=400, detail="This meeting has ended")
        if meeting.status == "cancelled":
            raise HTTPException(status_code=400, detail="This meeting was cancelled")

    settings = get_settings()
    servers = settings.ice_servers()
    has_turn = any(
        "turn:" in str(s.get("urls", "")).lower() or "turns:" in str(s.get("urls", "")).lower()
        for s in servers
    )
    return {
        "iceServers": servers,
        "has_stun": True,
        "has_turn": has_turn,
        "note": (
            "STUN helps discover public addresses. TURN relays media when direct "
            "peer-to-peer fails. Production internet meetings should configure TURN."
        ),
        "environment": settings.environment,
    }
