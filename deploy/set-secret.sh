#!/usr/bin/env bash
# set-secret.sh - vnesuvanje tajna na serverot bez da se prikaze i bez da ostane vo istorija.
# Se pusta so: ssh -t ... "sudo bash ~/efaktura-deploy/set-secret.sh entra_client_secret"
set -euo pipefail
NAME="${1:-}"
[[ "$NAME" =~ ^[a-z_]{3,40}$ ]] || { echo "Upotreba: set-secret.sh <ime> (mali bukvi i _)"; exit 1; }
DST="/opt/efaktura/secrets/$NAME"
read -rsp "Zalepi ja tajnata za $NAME i pritisni Enter: " S; echo
S="${S//[$'\r\n ']/}"          # trgni prazni mesta i CR od Windows clipboard
if [ "${#S}" -lt 16 ]; then echo "!! Prekratko (${#S} znaci) - nisto ne e zacuvano."; exit 1; fi
umask 077
printf '%s' "$S" > "$DST"
unset S
chmod 444 "$DST"; chown root:root "$DST"
echo "Zacuvano: $DST ($(wc -c < "$DST") znaci)"
