"""WebSocket hub for meeting signaling, chat, and presence."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from backend.database import SessionLocal
from backend.models import Meeting, MeetingMessage, Transcript, TranscriptSegment

router = APIRouter(tags=["realtime"])


class MeetingRoom:
    def __init__(self) -> None:
        self.peers: dict[str, WebSocket] = {}
        self.meta: dict[str, dict[str, Any]] = {}

    async def connect(self, peer_id: str, websocket: WebSocket, meta: dict[str, Any]) -> None:
        await websocket.accept()
        self.peers[peer_id] = websocket
        self.meta[peer_id] = meta

    def disconnect(self, peer_id: str) -> None:
        self.peers.pop(peer_id, None)
        self.meta.pop(peer_id, None)

    async def send(self, peer_id: str, payload: dict) -> None:
        ws = self.peers.get(peer_id)
        if ws:
            await ws.send_json(payload)

    async def broadcast(self, payload: dict, exclude: str | None = None) -> None:
        for pid, ws in list(self.peers.items()):
            if exclude and pid == exclude:
                continue
            try:
                await ws.send_json(payload)
            except Exception:
                pass

    def roster(self) -> list[dict]:
        return [{"peer_id": pid, **meta} for pid, meta in self.meta.items()]


class Hub:
    def __init__(self) -> None:
        self.rooms: dict[str, MeetingRoom] = {}

    def room(self, public_id: str) -> MeetingRoom:
        if public_id not in self.rooms:
            self.rooms[public_id] = MeetingRoom()
        return self.rooms[public_id]


hub = Hub()


def _save_chat(public_id: str, sender_name: str, body: str) -> dict | None:
    db: Session = SessionLocal()
    try:
        meeting = db.query(Meeting).filter(Meeting.public_id == public_id).first()
        if not meeting:
            return None
        msg = MeetingMessage(meeting_id=meeting.id, sender_name=sender_name, body=body)
        db.add(msg)
        db.commit()
        db.refresh(msg)
        return {
            "id": msg.id,
            "sender_name": msg.sender_name,
            "body": msg.body,
            "created_at": msg.created_at.isoformat(),
        }
    finally:
        db.close()


def _save_transcript_segment(public_id: str, speaker: str, text: str, start_sec: float = 0) -> dict | None:
    db: Session = SessionLocal()
    try:
        meeting = db.query(Meeting).filter(Meeting.public_id == public_id).first()
        if not meeting:
            return None
        if not meeting.transcript:
            meeting.transcript = Transcript(meeting_id=meeting.id, status="live", full_text="")
            db.add(meeting.transcript)
            db.flush()
        seg = TranscriptSegment(
            transcript_id=meeting.transcript.id,
            speaker_label=speaker,
            text=text,
            start_sec=start_sec,
        )
        db.add(seg)
        meeting.transcript.full_text = (
            meeting.transcript.full_text + "\n" + f"{speaker}: {text}"
        ).strip()
        meeting.transcript.status = "live"
        meeting.transcript.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(seg)
        return {
            "id": seg.id,
            "speaker_label": speaker,
            "text": text,
            "start_sec": start_sec,
        }
    finally:
        db.close()


@router.websocket("/ws/meetings/{public_id}")
async def meeting_ws(websocket: WebSocket, public_id: str):
    db = SessionLocal()
    meeting = db.query(Meeting).filter(Meeting.public_id == public_id).first()
    db.close()
    if not meeting:
        await websocket.close(code=4404)
        return

    peer_id = websocket.query_params.get("peer_id") or f"peer-{id(websocket)}"
    display_name = websocket.query_params.get("display_name") or "Guest"
    role = websocket.query_params.get("role") or "participant"

    room = hub.room(public_id)
    await room.connect(peer_id, websocket, {"display_name": display_name, "role": role})

    await websocket.send_json({"type": "welcome", "peer_id": peer_id, "roster": room.roster()})
    await room.broadcast(
        {
            "type": "peer_joined",
            "peer_id": peer_id,
            "display_name": display_name,
            "role": role,
            "roster": room.roster(),
        },
        exclude=peer_id,
    )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            if msg_type in {"offer", "answer", "ice_candidate"}:
                target = data.get("to")
                payload = {**data, "from": peer_id}
                if target:
                    await room.send(target, payload)
                else:
                    await room.broadcast(payload, exclude=peer_id)

            elif msg_type == "chat_message":
                body = (data.get("body") or "").strip()
                if not body:
                    continue
                saved = _save_chat(public_id, display_name, body)
                event = {
                    "type": "chat_message",
                    "from": peer_id,
                    "sender_name": display_name,
                    "body": body,
                    "created_at": (saved or {}).get("created_at"),
                    "id": (saved or {}).get("id"),
                }
                await room.broadcast(event)

            elif msg_type == "transcript_segment":
                text = (data.get("text") or "").strip()
                if not text:
                    continue
                speaker = data.get("speaker_label") or display_name
                saved = _save_transcript_segment(
                    public_id, speaker, text, float(data.get("start_sec") or 0)
                )
                await room.broadcast(
                    {
                        "type": "transcript_segment",
                        "segment": saved
                        or {"speaker_label": speaker, "text": text, "start_sec": data.get("start_sec", 0)},
                    }
                )

            elif msg_type == "media_state":
                room.meta[peer_id]["muted"] = bool(data.get("muted"))
                room.meta[peer_id]["camera_off"] = bool(data.get("camera_off"))
                await room.broadcast(
                    {
                        "type": "media_state",
                        "peer_id": peer_id,
                        "muted": room.meta[peer_id].get("muted"),
                        "camera_off": room.meta[peer_id].get("camera_off"),
                    },
                    exclude=peer_id,
                )

            elif msg_type == "recording_state":
                await room.broadcast(
                    {
                        "type": "recording_state",
                        "active": bool(data.get("active")),
                        "by": display_name,
                    }
                )

            elif msg_type == "meeting_ended":
                await room.broadcast({"type": "meeting_ended", "by": display_name})

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

    except WebSocketDisconnect:
        pass
    finally:
        room.disconnect(peer_id)
        await room.broadcast(
            {"type": "peer_left", "peer_id": peer_id, "roster": room.roster()}
        )
        if not room.peers:
            hub.rooms.pop(public_id, None)
