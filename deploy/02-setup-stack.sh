#!/usr/bin/env bash
# 02-setup-stack.sh - Caddy (HTTPS) + PostgreSQL vo /opt/efaktura. Idempotentno.
# Se pusta so: sudo bash /tmp/efaktura-deploy/02-setup-stack.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DST=/opt/efaktura

echo "== 1/4 Test-serverot (porttest) se gasi =="
docker stop porttest 2>/dev/null || true

echo "== 2/4 Datoteki vo $DST =="
mkdir -p "$DST/secrets"
install -m 644 "$SRC/docker-compose.yml" "$SRC/Caddyfile" "$SRC/.env" "$DST/"
if [ ! -s "$DST/secrets/db_password" ]; then
  openssl rand -base64 33 | tr -d '/+=\n' > "$DST/secrets/db_password"
  echo "   nova lozinka za bazata e generirana (ostanuva samo na serverot)"
fi
chown root:root "$DST/secrets/db_password"   # citaat postgres (uid 70) i api (uid 1000)
chmod 444 "$DST/secrets/db_password"   # papkata secrets e 700 root
chmod 700 "$DST/secrets"

echo "== 3/4 docker compose up =="
cd "$DST"
docker compose pull -q
docker compose up -d
sleep 20

echo "== 4/4 Proverka =="
docker compose ps
docker compose exec -T db psql -U efaktura -d efaktura -c "select version();" | head -3
curl -s -o /dev/null -w "HTTPS kon %{url_effective}: %{http_code}\n" "https://$(grep ^DOMAIN= .env | cut -d= -f2)/" || echo "HTTPS se uste ne odgovara (sertifikatot moze da trae 1 min)"
docker compose logs caddy --tail 8
free -m
echo GOTOVO
