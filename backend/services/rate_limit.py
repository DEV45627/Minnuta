"""Simple in-memory rate limiting for public endpoints."""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from backend.config import get_settings


_hits: dict[str, deque[float]] = defaultdict(deque)


def rate_limit(request: Request, *, key: str | None = None, limit: int | None = None) -> None:
    settings = get_settings()
    max_hits = limit or settings.rate_limit_per_minute
    client = key or (request.client.host if request.client else "unknown")
    bucket = f"{client}:{request.url.path}"
    now = time.time()
    window = _hits[bucket]
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= max_hits:
        raise HTTPException(status_code=429, detail="Too many requests. Please try again shortly.")
    window.append(now)
