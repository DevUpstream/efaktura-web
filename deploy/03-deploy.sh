#!/usr/bin/env bash
# 03-deploy.sh - azurira /opt/efaktura i gi prezema najnovite sliki od ghcr.io. Idempotentno.
# Preduslov (ednas): sudo docker login ghcr.io -u DevUpstream   (lozinka = PAT so read:packages)
# Se pusta so: sudo bash /tmp/efaktura-deploy/03-deploy.sh [API_TAG]
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DST=/opt/efaktura
TAG="${1:-latest}"

echo "== 1/4 Datoteki =="
install -m 644 "$SRC/docker-compose.yml" "$SRC/Caddyfile" "$DST/"
grep -q '^DOMAIN=' "$DST/.env" || install -m 644 "$SRC/.env" "$DST/"
sed -i '/^API_TAG=/d' "$DST/.env"; echo "API_TAG=$TAG" >> "$DST/.env"
# lozinkata ja citaat postgres (uid 70) i api (uid 1000); papkata secrets e 700 root, pa ne e vidliva za drugi korisnici
chown root:root "$DST/secrets/db_password"; chmod 444 "$DST/secrets/db_password"; chmod 700 "$DST/secrets"

echo "== 2/4 Sliki =="
cd "$DST"
if ! docker compose pull -q; then
  echo "!! Ne mozam da ja prezemam slikata. Dali e napraveno: sudo docker login ghcr.io -u DevUpstream ?"; exit 1
fi

echo "== 3/4 Start =="
docker compose up -d --remove-orphans
for i in $(seq 1 30); do
  st=$(docker inspect -f '{{.State.Health.Status}}' efaktura-api-1 2>/dev/null || echo none)
  [ "$st" = healthy ] && break; sleep 3
done
echo "api: $st"

echo "== 4/4 Proverka =="
docker compose ps --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}'
D=$(grep ^DOMAIN= .env | cut -d= -f2)
curl -s "https://$D/api/health"; echo
docker compose logs api --tail 10
docker image prune -f >/dev/null
free -m | head -2
echo GOTOVO
