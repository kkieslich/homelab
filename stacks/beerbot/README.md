# beerbot

BeerBot (drink-tracking app) running the images built by
[github.com/BeerbotApp/BeerBot](https://github.com/BeerbotApp/BeerBot). Deployed
here as a Komodo stack; **live prod data is forward-synced from the old prod** by
the `beerbot-migrator` service (parallel run), so this is a real testing instance,
not an empty one.

## Services

`beerbot-api`, `beerbot-admin-api`, `beerbot-web`, `beerbot-admin-web`,
`beerbot-landing`, `beerbot-db` (Postgres: `beerbot` + `logto`), `beerbot-logto`,
`beerbot-minio` (+init), `beerbot-provision` (one-shot: schema→head + Logto
bootstrap on each deploy), `beerbot-migrator` (`sync --watch` from old prod).

## Routing (Caddy, over proxy_net — no host ports)

| Host | → service |
|---|---|
| `beerbot.home.kki.berlin` | `beerbot-web:80` |
| `api.beerbot.home.kki.berlin` | `beerbot-api:80` |
| `auth.beerbot.home.kki.berlin` | `beerbot-logto:3001` |
| `admin.beerbot.home.kki.berlin` | `beerbot-admin-web:80` (+ `/api` → `beerbot-admin-api:80`, prefix stripped) |
| `cdn.beerbot.home.kki.berlin` | `beerbot-minio:9000` |
| `www.beerbot.home.kki.berlin` | `beerbot-landing:80` |

## One-time setup (owner)

1. **GHCR pull credential** — the images are private. Add a registry account
   (GitHub PAT with `read:packages`) in Komodo, or make the packages public.
2. **Secret** — deliver `/run/secrets/beerbot.env` via sops-nix (home-infrastructure
   repo). Keys: see [`beerbot.env.example`](./beerbot.env.example). Set
   `POSTGRES_HOST=beerbot-db` (the in-stack service name) — all DB connections
   are built from the `POSTGRES_*` parts.
3. **Old-prod SSH key** — deliver the private key for the migration tunnel to
   `/run/secrets/beerbot-old-vps` (mounted read-only at `/keys/old-vps`), and set
   `MIGRATOR_TUNNEL_TARGET` in the secret.
4. **Data dirs** — `/persist/appdata/beerbot/{db,minio}` (created on first run).
5. **DNS** — point the six `*.beerbot.home.kki.berlin` names at the box.

## First deploy

Komodo brings the stack up: the fresh `beerbot-db` volume runs `init-databases.sh`
(creates the `beerbot` + `logto` DBs), Logto seeds itself, `beerbot-provision`
migrates the schema + bootstraps Logto, then `beerbot-migrator` starts
forward-syncing live data from old prod every ~15 min.

**After the first provision**, read the Logto app IDs it created (Logto admin
console via an SSH tunnel to `beerbot-logto:3002`, or the provision logs), put
`EXPO_PUBLIC_LOGTO_WEB_APP_ID` + `VITE_LOGTO_APP_ID` into the sops secret, and
restart `beerbot-web` + `beerbot-admin-web` (they read these at runtime — no
rebuild).

Grant yourself admin:

```bash
docker compose -f docker-compose.yml run --rm beerbot-provision grant-admin <email>
```
