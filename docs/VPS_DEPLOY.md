# Minuta — VPS + Docker deployment (Option B)

**Meet. Talk. Capture. Understand.**

Step-by-step guide for deploying Minuta on a cloud VPS with Docker. This avoids Vercel’s 500 MB limit and supports WebSockets, WebRTC, and the full ML stack.

---

## What you need

| Item | Example | Required? |
|------|---------|-----------|
| VPS | DigitalOcean, Hetzner, AWS Lightsail, Oracle Free Tier | Yes |
| Domain | `minuta.yourdomain.com` | Yes (for HTTPS + camera/mic) |
| TURN server | coturn self-hosted or Metered.ca / Twilio | Recommended for mobile/cross-network video |

**Rough cost:** VPS ~$5–12/month. Domain ~$10–15/year. TURN can be free (self-host coturn on same VPS).

---

## Time estimate

| Phase | First time | After that |
|-------|------------|------------|
| Create VPS + SSH | 10–20 min | — |
| Install Docker + upload project | 10–15 min | — |
| **First `docker compose build`** | **15–25 min** | 3–8 min |
| DNS + HTTPS (Caddy/certbot) | 15–30 min | — |
| Smoke test | 10 min | 5 min |
| **Total first deploy** | **~1–2 hours** | **~5–10 min** |

---

## Step 1 — Create a VPS

1. Create an **Ubuntu 22.04 or 24.04** server (1 GB RAM minimum; **2 GB+ recommended** for Whisper).
2. Note the **public IP address** (e.g. `203.0.113.50`).
3. Open firewall ports: **22** (SSH), **80** (HTTP), **443** (HTTPS).

---

## Step 2 — Connect by SSH

From your PC (PowerShell or terminal):

```bash
ssh root@YOUR_SERVER_IP
```

Replace `YOUR_SERVER_IP` with your VPS IP.

---

## Step 3 — Install Docker on the server

```bash
curl -fsSL https://get.docker.com | sh
```

Log out and back in, then verify:

```bash
docker --version
docker compose version
```

---

## Step 4 — Upload the project

**Option A — Git (recommended)**

On the server:

```bash
git clone YOUR_REPO_URL minuta
cd minuta
```

**Option B — Copy from your PC**

From your PC (in the project folder):

```powershell
scp -r "C:\Users\ADMIN\Desktop\capstone project 2" root@YOUR_SERVER_IP:/root/minuta
```

Then on the server: `cd /root/minuta`

---

## Step 5 — Configure environment

```bash
cp .env.production.example .env
nano .env
```

Set at minimum:

```env
ENVIRONMENT=production
SECRET_KEY=paste-a-long-random-string-here
MINUTA_BASE_URL=https://minuta.yourdomain.com
CORS_ORIGINS=https://minuta.yourdomain.com
```

Generate a secret key on the server:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Paste the output as `SECRET_KEY`.

---

## Step 6 — Build and start Minuta

```bash
docker compose up -d --build
```

**First build: 15–25 minutes** (installs torch, whisper, spacy, etc.).

Check logs:

```bash
docker compose logs -f minuta
```

Wait until you see `Minuta ready`. Then test locally on the server:

```bash
curl http://127.0.0.1:8000/api/health
```

You should get `{"status":"ok",...}`.

---

## Step 7 — Point your domain to the VPS

In your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.):

| Type | Name | Value |
|------|------|--------|
| A | `minuta` (or `@`) | `YOUR_SERVER_IP` |

Wait 5–30 minutes for DNS to propagate.

---

## Step 8 — Enable HTTPS

Browsers need **HTTPS** for camera and microphone. Pick one:

### Option 8A — Caddy (easiest)

Install Caddy on the server, create `/etc/caddy/Caddyfile`:

```caddy
minuta.yourdomain.com {
    reverse_proxy localhost:8000
}
```

```bash
sudo systemctl reload caddy
```

Caddy obtains certificates automatically.

### Option 8B — Nginx + Certbot

1. Install nginx and certbot.
2. Use `deploy/nginx.conf` as a template (replace `minuta.example.com`).
3. Run certbot for your domain.
4. Uncomment the nginx service in `docker-compose.yml` **or** run nginx on the host proxying to `127.0.0.1:8000`.

Important: WebSocket path `/ws/` must be proxied with **Upgrade** headers (already in `deploy/nginx.conf`).

---

## Step 9 — Verify production

1. Open **https://minuta.yourdomain.com**
2. **Register** with a normal email (not `@minuta.local`)
3. **Create meeting** → copy link
4. Open link on phone (**mobile data**) → join lobby → Join Meeting
5. Room → **Diagnostics**: Signaling Connected, ICE Connected

---

## Step 10 — TURN (recommended)

For reliable video across different networks, add to `.env`:

```env
TURN_URL=turn:YOUR_SERVER_OR_TURN_HOST:3478
TURN_USERNAME=your-turn-user
TURN_PASSWORD=your-turn-password
```

Restart:

```bash
docker compose up -d
```

Self-host **coturn** on the same VPS or use a TURN provider.

---

## Useful commands

```bash
# View logs
docker compose logs -f minuta

# Restart after .env change
docker compose up -d

# Stop
docker compose down

# Rebuild after code update
git pull
docker compose up -d --build
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Build runs out of memory | Use 2 GB+ RAM VPS; add swap: `sudo fallocate -l 2G /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |
| Site loads but no camera | Must use **https://** not http |
| Video fails on mobile data | Configure **TURN** in `.env` |
| Meeting link shows localhost | Set `MINUTA_BASE_URL` to your HTTPS domain and restart |
| WebSocket fails | Ensure reverse proxy forwards `/ws/` with Upgrade headers |

---

## What gets stored

| Data | Location |
|------|----------|
| SQLite database | Docker volume `minuta_db` → `/data/minuta.db` |
| Uploads / recordings | Docker volume `minuta_storage` → `/app/storage` |

Back up volumes before major upgrades.

---

## Why VPS instead of Vercel?

- No 500 MB function limit (full torch/whisper/spacy works)
- WebSockets and long-lived connections work
- Persistent SQLite/storage volumes
- Better fit for WebRTC meeting platform

See also: [DEPLOYMENT.md](../DEPLOYMENT.md)
