# Minuta on Vercel (frontend only)

Vercel cannot bundle the full Python backend (torch + whisper + spacy ≈ **6 GB**).
Deploy **only the static frontend** on Vercel and run the **API on VPS/Docker**.

## Architecture

```text
Vercel (static web/)  →  pages, CSS, JS  (~0.2 MB)
VPS/Docker (server.py) →  /api/*, /ws/*, Whisper, WebRTC signaling
```

## Vercel project settings

| Setting | Value |
|---------|--------|
| **Root Directory** | `.` (repository root) |
| **Framework Preset** | Other |
| **Build Command** | *(leave empty)* |
| **Output Directory** | `web` |
| **Install Command** | *(leave empty)* |

`vercel.json` in the repo sets `outputDirectory: "web"` automatically.

## What gets deployed

Included (~0.2 MB):

- `web/index.html`
- `web/pages/*.html`
- `web/css/`, `web/js/`

Excluded via `.vercelignore`:

- `backend/`, `src/`, `server.py`
- `requirements.txt` (torch, whisper, spacy, etc.)
- `Dockerfile`, `minuta.db`, `storage/`

## Backend (required for login, meetings, video)

Deploy the API separately:

→ [VPS_DEPLOY.md](VPS_DEPLOY.md)

After the VPS is live, add API proxy rewrites — see `vercel.api-proxy.example.json`.

## Local development (unchanged)

```bat
python -m uvicorn server:app --reload --host 127.0.0.1 --port 8000
```

Local dev still runs frontend + backend together on port 8000.
