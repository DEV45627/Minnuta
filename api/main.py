"""FastAPI entrypoint api/main.py for root Vercel deployments."""

import sys
from pathlib import Path

_file_dir = Path(__file__).resolve().parent.parent

if str(_file_dir) not in sys.path:
    sys.path.insert(0, str(_file_dir))

from backend.app_factory import create_app

app = create_app()
