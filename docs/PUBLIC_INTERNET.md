# Minuta — Public Internet Access Analysis

**Meet. Talk. Capture. Understand.**

This document answers the inspection checklist before/alongside the incremental production changes. Implementation lives in code + [DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Current architecture

```text
Browser (web/)  ↔  FastAPI (server.py → create_app)
                      ├─ REST /api/*  (auth, meetings, transcripts, notes, …)
                      ├─ WebSocket /ws/meetings/{public_id}
                      ├─ Static /static + HTML pages
                      └─ SQLite (default) + storage/
```

Local/LAN still works via `0.0.0.0:8000`. Production target:

```text
Internet → HTTPS domain → reverse proxy → FastAPI → WS signaling → WebRTC (+ STUN/TURN)
```

## 2. Current WebRTC implementation

- **Mesh** peer connections in `web/js/webrtc.js` (`MeshRoom`)
- ICE servers loaded at join from **`GET /api/webrtc/ice`** (server builds list from env)
- Default STUN: Google public STUN via `STUN_URLS`
- Optional TURN via `TURN_URL` / `TURN_USERNAME` / `TURN_PASSWORD`
- Diagnostics track connection/ICE state and candidate types (`host`, `srflx`, `relay`)

## 3. Current signaling

- `backend/realtime/signaling.py` — rooms keyed by meeting `public_id`
- Routes offers, answers, ICE candidates, join/leave, chat, transcript segments, recording/end events
- WebSocket URL derived from **page origin** (`wss://` on HTTPS, `ws://` on local HTTP) — never hard-coded LAN IPs

## 4. Meeting-link implementation

- Cryptographically random `public_id` (not `/meeting/1`)
- Share URL: `${MINUTA_BASE_URL}/meeting/${public_id}`
- Create UI: success card with **Copy Link** / **Share**
- `MINUTA_BASE_URL=auto` remains for same-Wi-Fi LAN testing only

## 5. Transcription

- Live: browser Web Speech API → signaling → persist segments
- Optional Whisper path for uploads/tools
- AI notes via local NLP demo provider
- Guest transcript access gated by `allow_guest_transcript`

## 6. What must change for public internet access

| Area | Change |
|------|--------|
| Base URL | Production `MINUTA_BASE_URL=https://YOUR_DOMAIN` |
| TLS | HTTPS reverse proxy (camera/mic secure context) |
| WebSocket | Terminate TLS; proxy `/ws/` with Upgrade |
| ICE | STUN always; **TURN for Test C/D reliability** |
| Secrets | Stay in `.env`; ICE/TURN delivered only via API |
| Security | Random IDs, optional password, rate limits, transcript ACL |
| Hosting | Cloud VPS/PaaS — not home LAN IP exposure |

## 7. Recommended deployment architecture

See [DEPLOYMENT.md](DEPLOYMENT.md): Docker Compose + Nginx TLS sketch.

## 8. Required environment variables

See [.env.example](.env.example): `SECRET_KEY`, `ENVIRONMENT`, `MINUTA_BASE_URL`, `CORS_ORIGINS`, `STUN_URLS`, `TURN_*`, `DATABASE_URL`, etc.

## 9. STUN / TURN plan

- **STUN:** discover public addresses; often enough on open networks
- **TURN:** relay when P2P fails — **required for reliable cross-network / mobile-data meetings**
- Do not claim STUN alone works globally

## 10. Implementation phases (status)

1. ✅ Config `MINUTA_BASE_URL` + origin-based WebSockets  
2. ✅ Server ICE endpoint + env STUN/TURN  
3. ✅ Meeting passwords, rate limits, transcript privacy  
4. ✅ Diagnostics (signaling / WebRTC / ICE / media / candidate types)  
5. ✅ Deployment docs + Dockerfile / nginx sample  
6. ⬜ You: deploy to HTTPS domain + configure TURN → run Test C/D  

## Important limitation

**A public domain alone does not guarantee WebRTC media.** Restrictive NATs/firewalls need TURN (`relay` candidates in Diagnostics).
