"""FastAPI entrypoint backend/api/index.py for Vercel backend service deployment."""

import sys
from pathlib import Path

_file_dir = Path(__file__).resolve().parent.parent
_parent_dir = _file_dir.parent

for _d in (str(_file_dir), str(_parent_dir)):
    if _d not in sys.path:
        sys.path.insert(0, _d)

try:
    from app_factory import create_app
except ImportError:
    from backend.app_factory import create_app

app = create_app()
