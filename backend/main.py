"""FastAPI entrypoint for Vercel backend service deployment."""

from backend.app_factory import create_app

app = create_app()
