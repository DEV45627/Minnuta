#!/usr/bin/env bash
# First-time VPS setup helper for Minuta (Ubuntu 22.04/24.04).
# Run on the server as a normal user with sudo:
#   chmod +x deploy/setup-vps.sh && ./deploy/setup-vps.sh

set -euo pipefail

echo "=== Minuta VPS setup ==="

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
  echo "Docker installed. You may need to log out and back in for group changes."
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin not found. Install Docker Desktop/Engine with compose plugin."
  exit 1
fi

if [ ! -f .env ]; then
  if [ -f .env.production.example ]; then
    cp .env.production.example .env
    echo "Created .env from .env.production.example — EDIT IT before going live."
  else
    cp .env.example .env
    echo "Created .env from .env.example — EDIT IT before going live."
  fi
fi

echo ""
echo "Next steps:"
echo "  1. Edit .env (SECRET_KEY, MINUTA_BASE_URL, CORS_ORIGINS)"
echo "  2. docker compose up -d --build"
echo "  3. Point your domain A record to this server's IP"
echo "  4. Set up HTTPS with Caddy or Nginx + certbot (see docs/VPS_DEPLOY.md)"
echo ""
echo "First build takes ~15-25 minutes (downloads ML packages)."
