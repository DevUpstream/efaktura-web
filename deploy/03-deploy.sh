#!/usr/bin/env bash
# 03-deploy.sh - azurira /opt/efaktura i gi prezema najnovite sliki od ghcr.io. Idempotentno.
# Preduslov (ednas): sudo docker login ghcr.io -u DevUpstream   (lozinka = PAT so read:packages)
# Se pusta so: sudo bash /tmp/efaktura-deploy/03-deploy.sh [API_TAG]
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DST=/opt/efaktura
TAG="${1:-latest}"

echo "== 1/4 Datoteki =="
old_caddy=$(sha256sum "$DST/Caddyfile" 2>/dev/null | cut -d' ' -f1 || true)
install -m 644 "$SRC/docker-compose.yml" "$SRC/Caddyfile" "$DST/"
# .env (od app.env): vrednostite od repoto (ne-tajni) + API_TAG
install -m 644 "$SRC/app.env" "$DST/.env"; echo "API_TAG=$TAG" >> "$DST/.env"
# app_key (kolacinja, TOTP): se generira EDNAS na serverot
[ -s "$DST/secrets/app_key" ] || { openssl rand -base64 32 > "$DST/secrets/app_key"; echo "   nov app_key generiran"; }
# entra tajnata ja vnesuva administratorot so set-secret.sh; prazna datoteka = najava so Microsoft isklucena
[ -e "$DST/secrets/entra_client_secret" ] || : > "$DST/secrets/entra_client_secret"
for f in "$DST"/secrets/*; do chown root:root "$f"; chmod 444 "$f"; done
# lozinkata ja citaat postgres (uid 70) i api (uid 1000); papkata secrets e 700 root, pa ne e vidliva za drugi korisnici
chmod 700 "$DST/secrets"

echo "== 2/4 Sliki =="
cd "$DST"
if ! docker compose pull -q; then
  echo "!! Ne mozam da ja prezemam slikata. Dali e napraveno: sudo docker login ghcr.io -u DevUpstream ?"; exit 1
fi

echo "== 3/4 Start =="
docker compose up -d --remove-orphans
# Caddyfile e bind-mount na edna datoteka: po zamena kontejnerot ja gleda starata -> restart samo ako e promeneta
if [ "$old_caddy" != "$(sha256sum Caddyfile | cut -d' ' -f1)" ]; then
  echo "Caddyfile e promenet -> restart na caddy"; docker compose restart caddy; sleep 3
fi
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
