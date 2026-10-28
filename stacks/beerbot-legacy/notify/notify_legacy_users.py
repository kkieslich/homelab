"""Send one push notification to every device of the legacy (pre-Expo) BeerBot app.

The legacy app has no in-app update notice, but its devices are registered with the old
Firebase project (beerbot-v3): tokens live in the legacy DB (NotificationSubscriptions) and
the matching service account ships inside the legacy API image (/app/fcm-api.json).

Run ON THE VPS via run.sh (it mounts the service account and passes the tokens in).
Dry run by default: it only counts tokens. Add --send to actually send.
"""
import argparse
import json
import sys

import requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account

SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--service-account", required=True)
    p.add_argument("--tokens", required=True, help="file with one device token per line")
    p.add_argument("--title", required=True)
    p.add_argument("--body", required=True)
    p.add_argument("--send", action="store_true", help="actually send (default: dry run)")
    a = p.parse_args()

    tokens = sorted({t.strip() for t in open(a.tokens) if t.strip()})
    creds = service_account.Credentials.from_service_account_file(a.service_account, scopes=SCOPES)
    project = json.load(open(a.service_account))["project_id"]
    print(f"project={project} tokens={len(tokens)}")
    print(f"title={a.title!r}\nbody={a.body!r}")
    if not a.send:
        print("dry run — nothing sent (add --send)")
        return 0

    creds.refresh(Request())
    url = f"https://fcm.googleapis.com/v1/projects/{project}/messages:send"
    ok = stale = failed = 0
    for t in tokens:
        if not creds.valid:
            creds.refresh(Request())
        r = requests.post(
            url,
            headers={"Authorization": f"Bearer {creds.token}"},
            json={"message": {"token": t, "notification": {"title": a.title, "body": a.body}}},
            timeout=15,
        )
        if r.ok:
            ok += 1
        elif r.status_code in (400, 404) and ("UNREGISTERED" in r.text or "INVALID_ARGUMENT" in r.text):
            stale += 1  # uninstalled app / expired token
        else:
            failed += 1
            print(f"FAIL {r.status_code}: {r.text[:200]}", file=sys.stderr)
    print(f"sent={ok} stale={stale} failed={failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
