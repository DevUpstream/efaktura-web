#!/usr/bin/env bash
# 05-restore-test.sh - proverka deka posledniot backup moze da se vrati (vo privremena baza, ne ja dopira vistinskata).
# Se pusta so: sudo bash /opt/efaktura/bin/05-restore-test.sh [datoteka.dump]
set -euo pipefail
cd /opt/efaktura
f="${1:-$(ls -1t backups/efaktura-*.dump | head -1)}"
echo "Vrakjam: $f"
docker compose exec -T db psql -U efaktura -d postgres -qc "DROP DATABASE IF EXISTS restore_test" -c "CREATE DATABASE restore_test"
docker compose exec -T db pg_restore -U efaktura -d restore_test --no-owner --exit-on-error < "$f"
docker compose exec -T db psql -U efaktura -d restore_test -c \
  "select (select count(*) from clients) klienti, (select count(*) from invoices) fakturi, (select count(*) from invoice_lines) stavki, (select count(*) from users) korisnici"
docker compose exec -T db psql -U efaktura -d postgres -qc "DROP DATABASE restore_test"
echo "VRAKJANJETO RABOTI"
