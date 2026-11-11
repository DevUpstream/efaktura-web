#!/usr/bin/env bash
# 04-backup.sh - dnevna rezervna kopija na bazata.
#   pg_dump (custom format) -> /opt/efaktura/backups (poslednite 14 dnevni + poslednite 12 mesecni)
#   + OCI Object Storage (PAR, samo pisuvanje): dnevni/... sekoj den, mesecni/... prviot bekap vo mesecot.
#   Cuvanje vo oblakot (docs/12): mesecni 30 godini (ZA POTVRDA od smetkovoditel), dnevni ~13 meseci -
#   se postavuva so pravilo (lifecycle policy) na bucket-ot, ne od ovaa skripta (PAR ne smee da brise).
# Go pusta systemd timer efaktura-backup.timer (02:30). Racno: sudo bash /opt/efaktura/bin/04-backup.sh
set -euo pipefail
DST=/opt/efaktura; B="$DST/backups"; KEEP=14; KEEP_MONTHLY=12
mkdir -p "$B"; chmod 700 "$B"
ts=$(date +%Y%m%d-%H%M); f="$B/efaktura-$ts.dump"
cd "$DST"

docker compose exec -T db pg_dump -U efaktura -d efaktura -Fc -Z 6 > "$f.tmp"
# proverka: arhivata mora da se procita i da gi ima podatocite od tabelite
n=$(docker compose exec -T db pg_restore --list < "$f.tmp" | grep -c "TABLE DATA" || true)
if [ "${n:-0}" -lt 10 ]; then echo "!! backup e neispraven (tabeli so podatoci: ${n:-0})"; rm -f "$f.tmp"; exit 1; fi
mv "$f.tmp" "$f"; chmod 600 "$f"
sha=$(sha256sum "$f" | cut -c1-64)
echo "lokalno: $f ($(du -h "$f" | cut -f1), $n tabeli, sha256 ${sha:0:16}...)"
ls -1t "$B"/efaktura-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f
# mesecna kopija: prviot uspesen bekap vo mesecot
mkdir -p "$B/mesecni"; chmod 700 "$B/mesecni"
mon="$B/mesecni/efaktura-$(date +%Y%m).dump"; first_of_month=0
if [ ! -e "$mon" ]; then cp -p "$f" "$mon"; first_of_month=1; echo "mesecna: $mon"; fi
ls -1t "$B"/mesecni/efaktura-*.dump | tail -n +$((KEEP_MONTHLY + 1)) | xargs -r rm -f

if [ -s "$DST/secrets/backup_par_url" ]; then
  url=$(tr -d '\r\n' < "$DST/secrets/backup_par_url")
  put() { curl -fsS --retry 3 --max-time 600 -X PUT -H "Content-Type: application/octet-stream" \
       -H "opc-meta-sha256: $sha" --data-binary @"$f" "${url%/}/$1" -o /dev/null; echo "oblak: $1 OK"; }
  put "dnevni/efaktura-$ts.dump"
  [ "$first_of_month" = 1 ] && put "mesecni/efaktura-$(date +%Y%m).dump"
else
  echo "!! nema secrets/backup_par_url - samo lokalna kopija"; logger -t efaktura-backup "SAMO LOKALNO $f"; exit 2
fi
logger -t efaktura-backup "OK $f $sha"
