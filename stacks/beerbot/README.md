# beerbot

BeerBot (drink-tracking app) running the images built by
[github.com/BeerbotApp/BeerBot](https://github.com/BeerbotApp/BeerBot). Deployed
here as a Komodo stack; **live prod data is forward-synced from the old prod** by
the `beerbot-migrator` service (parallel run), so this is a real testing instance,
not an empty one.

## Services

`beerbot-api`, `beerbot-admin-api`, `beerbot-web`, `beerbot-admin-web`,
`beerbot-landing`, `beerbot-db` (Postgres: `beerbot` + `keycloak`), `beerbot-keycloak`,
`beerbot-minio` (+init), `beerbot-provision` (one-shot: schema→head + Keycloak
bootstrap on each deploy), `beerbot-migrator` (`sync --watch` from old prod).

## Routing (Caddy, over proxy_net — no host ports)

| Host | → service |
|---|---|
| `beerbot.home.kki.berlin` | `beerbot-web:80` |
| `api.beerbot.home.kki.berlin` | `beerbot-api:80` |
| `auth.beerbot.home.kki.berlin` | `beerbot-keycloak:8080` |
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
(creates the `beerbot` + `keycloak` DBs), Keycloak starts, `beerbot-provision`
migrates the schema + imports/ensures the BeerBot realm, then `beerbot-migrator` starts
forward-syncing live data from old prod every ~15 min.

Keycloak client ids are deterministic (`beerbot-web`, `beerbot-mobile`,
`beerbot-admin`), so there is no post-provision app-id copy step.

Grant yourself admin:

```bash
docker compose -f docker-compose.yml run --rm beerbot-provision grant-admin <email>
```
