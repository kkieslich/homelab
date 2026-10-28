#!/bin/sh
# Push one notice to all legacy-app devices. Run on the VPS from this directory:
#   ./run.sh "Title" "Body"           # dry run: counts tokens only
#   ./run.sh "Title" "Body" --send    # actually sends
set -eu
cd "$(dirname "$0")"
TITLE="$1"; BODY="$2"; shift 2
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
docker cp beerbot-legacy-api:/app/fcm-api.json "$work/sa.json"
docker exec beerbot-legacy-db psql -U beerbot -d beerbot -Atc \
  'select distinct "DeviceToken" from "NotificationSubscriptions" where "DeviceToken" is not null' > "$work/tokens.txt"
docker run --rm -v "$work:/w:ro" -v "$PWD/notify_legacy_users.py:/app/notify.py:ro" python:3.12-slim \
  sh -c 't="$1"; b="$2"; shift 2; pip install -q --disable-pip-version-check google-auth requests >/dev/null 2>&1 && python /app/notify.py --service-account /w/sa.json --tokens /w/tokens.txt --title "$t" --body "$b" "$@"' \
  sh "$TITLE" "$BODY" "$@"
