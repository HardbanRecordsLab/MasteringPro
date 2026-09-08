#!/usr/bin/env bash
# ============================================================================
#  MasteringPro — deploy / update on the HBRL VPS (hbrl-prod, 84.247.162.167).
#
#  Idempotent: safe to re-run for updates. Run as root on the VPS.
#    ssh -i ~/.ssh/vps_key root@84.247.162.167
#    cd /opt/masteringpro && ./deploy/vps-deploy.sh
#
#  First run needs (see DEPLOY.md):
#   - DNS A records for masteringpro. and api.masteringpro. → 84.247.162.167
#   - server/.env filled (AI_API_KEY, DATABASE_URL, ALLOWED_ORIGINS)
#   - the masteringpro database created in hbrl-postgres
# ============================================================================
set -euo pipefail

REPO_DIR=/opt/masteringpro
DOMAIN=masteringpro.hardbanrecordslab.online
API_DOMAIN=api.masteringpro.hardbanrecordslab.online

cd "$REPO_DIR"

echo "▶ pulling latest"
git pull --ff-only

# --- database (idempotent) --------------------------------------------------
PGPW="${HBRL_DB_PASSWORD:-HRL.ks.84}"
if ! docker exec -e PGPASSWORD="$PGPW" hbrl-postgres \
      psql -U hbrl_admin -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='masteringpro'" | grep -q 1; then
  echo "▶ creating database masteringpro"
  docker exec -e PGPASSWORD="$PGPW" hbrl-postgres \
    psql -U hbrl_admin -d postgres -c "CREATE DATABASE masteringpro OWNER hbrl_admin;"
fi

# --- API container --------------------------------------------------------
echo "▶ building + starting API container"
docker compose -f docker-compose.vps.yml up -d --build
sleep 3
curl -fsS http://127.0.0.1:8787/health | sed 's/^/   health: /'

# --- frontend build -----------------------------------------------------
echo "▶ building frontend"
if ! command -v node >/dev/null; then echo "node not found on host — install Node 20+"; exit 1; fi
npm ci --no-audit --no-fund
VITE_API_URL="https://${API_DOMAIN}" npm run build
echo "   dist/ built ($(du -sh dist | cut -f1))"

# --- nginx vhost (first run) -------------------------------------------
LINK=/etc/nginx/sites-enabled/masteringpro.conf
if [ ! -e "$LINK" ]; then
  echo "▶ linking nginx vhost"
  ln -sf "$REPO_DIR/deploy/nginx/masteringpro.conf" "$LINK"
fi

if [ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  echo "▶ issuing TLS certificate (needs DNS + port 80 reachable)"
  certbot certonly --webroot -w /var/www/certbot -n --agree-tos \
    -m hardbanrecordslab.pl@gmail.com \
    -d "$DOMAIN" -d "$API_DOMAIN"
fi

nginx -t && systemctl reload nginx

# --- backups -----------------------------------------------------------
BK=/root/vps-scripts/db-backup-all.sh
if [ -f "$BK" ] && ! grep -q masteringpro "$BK"; then
  echo "⚠ remember to add 'masteringpro' to the database list in $BK"
fi

echo
echo "✅ done"
echo "   frontend : https://${DOMAIN}"
echo "   api      : https://${API_DOMAIN}/health"
