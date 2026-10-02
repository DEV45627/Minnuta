# Minuta production deployment

**Meet. Talk. Capture. Understand.**

This guide prepares Minuta for **internet-accessible** meetings. LAN/`10.x`/`192.168.x` addresses are for local testing only — do not share those as production meeting links.

## Architecture

```text
Internet
  → Public HTTPS domain (e.g. https://minuta.example.com)
  → Reverse proxy (Nginx / Caddy / cloud LB) with TLS
  → FastAPI (Uvicorn) on internal port 8000
  → WebSocket /ws/meetings/{id}  (wss:// via proxy)
  → WebRTC mesh (browser peers)
  → STUN (+ TURN for hard NATs)
  → SQLite or PostgreSQL
```

### Why HTTPS is required

Browsers require a **secure context** for camera/microphone on most devices. Production must be served as `https://…`. Local `http://localhost` is allowed as an exception.

### Why TURN matters

| Helper | Role |
|--------|------|
| **STUN** | Helps peers discover public addresses for direct connections |
| **TURN** | Relays media when direct P2P fails (symmetric NAT, strict firewalls, many mobile networks) |

**STUN alone does not guarantee global connectivity.** Production internet meetings should configure TURN.

## Environment variables

Copy `.env.example` → `.env` on the server.

| Variable | Example | Notes |
|----------|---------|--------|
| `ENVIRONMENT` | `production` | Enables production mode flags |
| `SECRET_KEY` | long random string | JWT signing — never commit |
| `MINUTA_BASE_URL` | `https://minuta.example.com` | Used in **Copy Link** invites |
| `CORS_ORIGINS` | `https://minuta.example.com` | Do not use `*` in production with credentials |
| `DATABASE_URL` | `postgresql+psycopg://user:pass@host/minuta` | Or keep SQLite for small demos |
| `STUN_URLS` | `stun:stun.l.google.com:19302,...` | Comma-separated |
| `TURN_URL` | `turn:turn.example.com:3478` | Optional but recommended |
| `TURN_USERNAME` / `TURN_PASSWORD` | from TURN provider | Served only via `/api/webrtc/ice`, not in static JS |
| `OPENAI_API_KEY` | — | Optional future AI provider |
| `WHISPER_MODEL` | `tiny` / `base` | Speech-to-text |

Meeting links:

```text
${MINUTA_BASE_URL}/meeting/${meeting_id}
→ https://minuta.example.com/meeting/A8K29P
```

## Docker (recommended)

```bash
docker compose up -d --build
```

See `docker-compose.yml`, `deploy/nginx.conf`, and the full walkthrough:

**→ [docs/VPS_DEPLOY.md](docs/VPS_DEPLOY.md)** (Option B: VPS + Docker, ~1–2 hours first time)

Point your DNS A/AAAA record to the server, terminate TLS on Nginx/Caddy (or use certbot).

## Nginx sketch

- Proxy `/` and `/api` and `/ws` to `http://127.0.0.1:8000`
- Enable WebSocket upgrade headers for `/ws/`
- Force HTTPS redirects
- Set `client_max_body_size` for uploads/recordings

## Local development (still works)

```bat
MINUTA_BASE_URL=http://localhost:8000
python -m uvicorn server:app --reload --host 127.0.0.1 --port 8000
```

LAN testing (same Wi-Fi only):

```bat
MINUTA_BASE_URL=auto
python -m uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

## Test matrix

| Test | Setup | Expect |
|------|--------|--------|
| A | Two browsers on same PC | Join same `/meeting/{id}` |
| B | Two devices, same Wi-Fi | LAN or localhost tunnel |
| C | PC Wi-Fi + phone mobile data | Requires **public HTTPS** + preferably TURN |
| D | Completely different networks | Requires **public HTTPS** + **TURN** for reliability |

### Test D checklist

- [ ] Link opens on phone (mobile data)
- [ ] Lobby → name → Join
- [ ] Host sees participant video/audio
- [ ] Mute / camera toggles work
- [ ] Chat works
- [ ] Diagnostics: Signaling Connected, ICE Connected (relay if TURN used)
- [ ] Transcript / AI notes still work for host

## Security notes

- Meeting IDs are cryptographically random (not sequential)
- Optional join password (hashed at rest)
- Transcripts can be restricted with `allow_guest_transcript`
- Rate limiting on join/create
- Secrets stay in `.env` — never commit AI/DB/TURN passwords into frontend source
- TURN credentials are delivered at join time through `/api/webrtc/ice` (required by WebRTC browsers; prefer time-limited TURN REST credentials from your provider)

## Limitations

- Mesh WebRTC scales poorly beyond a handful of peers (future: SFU)
- Without TURN, some network pairs will fail ICE
- Hosting on a home PC behind CGNAT is unreliable — use a cloud VPS or PaaS
