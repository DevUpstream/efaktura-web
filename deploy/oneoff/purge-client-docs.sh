#!/usr/bin/env bash
# Brisenje na site dokumenti na edna firma (docs/19). Partnerite i artiklite ostanuvaat.
#   Proba (nisto ne se brise, samo broevi):  sudo bash ~/efaktura-deploy/oneoff/purge-client-docs.sh 4015023508550
#   Vistinsko (prvo rezervna kopija):       sudo bash ~/efaktura-deploy/oneoff/purge-client-docs.sh 4015023508550 --commit
set -euo pipefail
EDB=${1:?"EDB na firmata (13 cifri)"}; MODE=${2:-}
[[ "$EDB" =~ ^[0-9]{13}$ ]] || { echo "EDB mora da e 13 cifri"; exit 1; }
SQL="$(dirname "$0")/purge-client-docs.sql"
cd /opt/efaktura
if [ "$MODE" = "--commit" ]; then
  echo "== Rezervna kopija =="
  bash /opt/efaktura/bin/04-backup.sh || { rc=$?; [ $rc -eq 2 ] || exit $rc; }   # 2 = samo lokalna kopija
  last=$(ls -1t backups/efaktura-*.dump | head -1)
  keep="backups/rezerva-pred-brisenje-$EDB-$(date +%Y%m%d-%H%M).dump"   # ne se brise so rotacijata (14 dena)
  cp -p "$last" "$keep"; chmod 600 "$keep"
  echo "zacuvana: /opt/efaktura/$keep"
  END=COMMIT
else
  echo "== PROBA (ROLLBACK): nisto ne se brise =="
  END=ROLLBACK
fi
{ cat "$SQL"; echo "$END;"; } | docker compose exec -T db psql -U efaktura -d efaktura -v ON_ERROR_STOP=1 -v edb="$EDB" -q
echo "== $END =="
