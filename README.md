# Minuta — AI-Powered Meeting & Collaboration Platform

**Meet. Talk. Capture. Understand.**

Minuta is a browser-based AI meeting platform: schedule meetings, join via link, meet with WebRTC audio/video, live-transcribe, chat, record with consent, and generate structured AI meeting notes.

## Features

- Auth (register / login / forgot & reset password)
- Dashboard, meetings, calendar, notes, transcripts
- Create meetings with secure random shareable IDs
- Guest lobby + in-browser meeting room (mesh WebRTC)
- Real-time chat & presence (WebSockets)
- Live transcription (Web Speech API + optional Whisper)
- AI notes (summary, decisions, action items, questions) via local NLP demo provider
- Recording metadata + optional upload
- Export transcript/notes (TXT, Markdown, PDF)
- Legacy **Tools** workspace (live listen / upload / paste → minutes)
- Demo meeting: **M.Sc. Capstone Project Discussion**

## Architecture

- **Frontend:** HTML / CSS / JS (multi-page), served by FastAPI
- **Backend:** FastAPI routers + services
- **Database:** SQLite (default) via SQLAlchemy — set `DATABASE_URL` for PostgreSQL
- **Realtime:** WebSockets for signaling / chat / transcript events
- **WebRTC:** Mesh P2P (best for ~2–6 participants; no SFU in MVP)
- **STT:** Whisper behind `transcription_service` (+ browser Web Speech for live mic)
- **AI:** `ai_service` with DemoAIProvider wrapping existing `src/nlp_pipeline.py`

## Folder structure

```
backend/          # FastAPI app, models, routers, services, websocket
src/              # Existing NLP / Whisper / minutes generators
web/              # Landing + pages + css/js
samples/          # Sample transcript fixture
storage/          # Local recordings/uploads
server.py         # Uvicorn entry (`app = create_app()`)
```

## Installation

```bat
setup.bat
```

Or:

```bat
python -m pip install -r requirements.txt
python -m spacy download en_core_web_sm
copy .env.example .env
```

Optional for file/tab Whisper transcription: install **ffmpeg** and ensure `torch` + `openai-whisper` install successfully.

## Shareable meeting links

Meeting invite URLs are built from **`MINUTA_BASE_URL`** (never hard-code `127.0.0.1` / LAN IPs into production links):

```text
{MINUTA_BASE_URL}/meeting/{secure_meeting_id}
→ https://minuta.example.com/meeting/A8K29P
```

| Setting | Result |
|---------|--------|
| `MINUTA_BASE_URL=http://localhost:8000` | Local development |
| `MINUTA_BASE_URL=auto` | `http://{detected-LAN-IP}:8000/...` (same Wi-Fi **testing only**) |
| `MINUTA_BASE_URL=https://minuta.example.com` | **Production** — any network / mobile data |

### Vercel (frontend only)

Vercel deploys the static **`web/`** folder (~0.2 MB). The Python API must run on **VPS/Docker** — see [docs/VERCEL.md](docs/VERCEL.md) and [docs/VPS_DEPLOY.md](docs/VPS_DEPLOY.md).

**HTTPS is required in production** for reliable camera/microphone access.

**STUN** helps P2P; **TURN** relays when NAT/firewalls block direct media. Public hosting alone does **not** guarantee WebRTC — configure TURN for Tests C/D (Wi‑Fi + mobile data / different networks).

ICE is served from `GET /api/webrtc/ice` (TURN credentials stay in server `.env`, not in static JS source).

### Local / LAN testing

1. `MINUTA_BASE_URL=http://localhost:8000` (or `auto` for LAN invites).
2. Run `run.bat` (binds `0.0.0.0:8000`).
3. Create meeting → **Copy Link** → open in a second browser/device.
4. Room → **Diagnostics**: Signaling / WebRTC / ICE / mic / cam / candidate types.

Windows Firewall (do not disable firewall):

```bat
netsh advfirewall firewall add rule name="Minuta Port 8000" dir=in action=allow protocol=TCP localport=8000
```

## Environment variables

See [.env.example](.env.example):

| Variable | Purpose |
|----------|---------|
| `SECRET_KEY` | JWT signing secret |
| `ENVIRONMENT` | `development` or `production` |
| `MINUTA_BASE_URL` | Localhost, `auto` (LAN), or public HTTPS for invites |
| `MINUTA_PORT` | Port used when `MINUTA_BASE_URL=auto` (default 8000) |
| `CORS_ORIGINS` | `*` for LAN/dev; production HTTPS origin(s) |
| `STUN_URLS` | Comma-separated STUN servers |
| `TURN_URL` / `TURN_USERNAME` / `TURN_PASSWORD` | Optional TURN relay (recommended for internet) |
| `DATABASE_URL` | Default `sqlite:///./minuta.db` |
| `STORAGE_PATH` | Local file storage |
| `WHISPER_MODEL` | `tiny` / `base` / `small` |
| `AI_PROVIDER` | `demo` (local NLP) |
| `OPENAI_API_KEY` | Reserved for future LLM provider (server-only) |
| `RATE_LIMIT_PER_MINUTE` | Basic API rate limiting |

## How to run

```bat
run.bat
```

Or:

```bat
python -m uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

- **This PC:** http://127.0.0.1:8000  
- **LAN / other device:** http://YOUR-LAN-IP:8000 (printed at startup)  
- **Demo:** /demo  
- **Tools:** /tools  
- **API docs:** /docs  

Frontend is served by the same process (no separate frontend server).

### Demo credentials

After opening `/demo` (or on first boot seed):

- Email: `demo@minuta.local`
- Password: `demo12345`

## How to test

1. Open `/demo` — view summary, decisions, action items  
2. Register a user → create a meeting → copy link → open `/meeting/{id}` in two browser profiles  
3. Use Tools → Sample → Generate minutes  
4. On a meeting details page, click **Generate AI Notes** after a transcript exists  

### Connectivity matrix

| Test | Setup | Needs |
|------|--------|--------|
| A | Two browsers, same PC | Localhost |
| B | Two devices, same Wi-Fi | LAN / `auto` |
| C | PC Wi-Fi + phone mobile data | Public **HTTPS** + preferably **TURN** |
| D | Completely different networks | Public **HTTPS** + **TURN** |

Optional Streamlit twin (legacy): `streamlit run app.py`

## Known limitations

- WebRTC is **mesh only** (not production SFU scale)
- **STUN alone does not guarantee** connectivity on every network — use TURN in production
- Speaker labels use display names / Web Speech — not advanced diarization
- AI notes use local heuristic NLP unless an LLM provider is added later
- Recording stores metadata; browser blob upload is host-driven MVP
- Password reset returns a token in API responses for **local demo only**

## Future enhancements

Calendar sync, email invites, SFU, org workspaces, cloud storage, multilingual STT, AI chat over meetings, recurring meetings.

## License

Capstone / educational project.
