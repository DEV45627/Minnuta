"""FastAPI application factory."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import ROOT, detect_lan_ip, get_settings
from backend.database import SessionLocal, init_db
from backend.realtime.signaling import router as ws_router
from backend.routers import (
    auth,
    chat,
    core,
    demo,
    export,
    meetings,
    notes,
    pages,
    recordings,
    search,
    transcripts,
    users,
    webrtc,
)
from backend.seed import ensure_demo_meeting, ensure_demo_user
from backend.services.storage_service import storage_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    storage_service.root.mkdir(parents=True, exist_ok=True)
    db = SessionLocal()
    try:
        ensure_demo_user(db)
        ensure_demo_meeting(db)
    finally:
        db.close()
    settings = get_settings()
    print("=" * 60, flush=True)
    print("Minuta ready", flush=True)
    print(f"  Local:     http://127.0.0.1:{settings.minuta_port}", flush=True)
    print(f"  LAN:       http://{detect_lan_ip()}:{settings.minuta_port}", flush=True)
    print(f"  Share URL: {settings.public_base_url}", flush=True)
    print("  Bind:      0.0.0.0 (accepts LAN clients)", flush=True)
    print("  Note: LAN testing is same Wi-Fi only. Production needs HTTPS domain.", flush=True)
    print("=" * 60, flush=True)
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        description="Meet. Talk. Capture. Understand.",
        lifespan=lifespan,
    )

    origins = settings.cors_origin_list
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=origins != ["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(pages.router)
    app.include_router(core.router)
    app.include_router(auth.router)
    app.include_router(users.router)
    app.include_router(meetings.router)
    app.include_router(transcripts.router)
    app.include_router(notes.router)
    app.include_router(recordings.router)
    app.include_router(chat.router)
    app.include_router(search.router)
    app.include_router(demo.router)
    app.include_router(export.router)
    app.include_router(webrtc.router)
    app.include_router(ws_router)

    web = ROOT / "web"
    app.mount("/static", StaticFiles(directory=web), name="static")
    return app
