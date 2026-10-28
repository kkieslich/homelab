# BeerBot production cutover (beerbot.app)

Moves the new BeerBot (stacks/beerbot on the VPS) from the test hostnames
`*.beerbot.home.kki.berlin` to production `beerbot.app`, while the legacy app keeps
working on the same `api.` / `auth.` hostnames until it is retired.

Prepared on branch `cutover/beerbot-app` (homelab) — Komodo only deploys `main`, so the
branch is inert until merged. The split routing (header on `api.`, path on `auth.`) was
tested against the live containers on 2026-10-28.

## Before (once)

1. PR BeerbotApp/BeerBot#2 is merged and deployed (CI builds images, the VPS Komodo rolls
   them out within ~15 min). Check: `curl -s -o /dev/null -w '%{http_code}' -H 'X-Client-Platform: ios' https://api.beerbot.home.kki.berlin/Client/Status` → `204`.
2. Social login redirect URIs for the new Keycloak hostname:
   - Google Cloud console → OAuth client → Authorized redirect URIs:
     `https://auth.beerbot.app/realms/beerbot/broker/google/endpoint`
   - Apple Developer → Services ID (Sign in with Apple) → Domains `auth.beerbot.app`,
     Return URL `https://auth.beerbot.app/realms/beerbot/broker/apple/endpoint`
   Keep the old `home.kki.berlin` entries until after the cutover.
3. DNS: `beerbot.app` and `*.beerbot.app` → VPS (done 2026-10-28).

## Cutover

```sh
cd homelab && git switch main && git pull && git merge --no-ff cutover/beerbot-app && git push
```

The 5-minute reconcile redeploys `beerbot` (hostnames changed) and the proxy refresh
reloads Caddy. Caddy fetches certificates for `app.`, `admin.`, `cdn.`, `www.` on first
request. Then check:

```sh
curl -s -o /dev/null -w 'landing %{http_code}\n'  https://beerbot.app/
curl -s -o /dev/null -w 'web     %{http_code}\n'  https://app.beerbot.app/
curl -s -o /dev/null -w 'admin   %{http_code}\n'  https://admin.beerbot.app/
curl -s -o /dev/null -w 'new api %{http_code}\n'  -H 'X-Client-Platform: ios' https://api.beerbot.app/Client/Status   # 204
curl -s https://auth.beerbot.app/realms/beerbot/.well-known/openid-configuration | head -c 80          # issuer auth.beerbot.app
curl -s https://auth.beerbot.app/.well-known/openid-configuration | head -c 80                         # legacy OpenIddict
curl -s -o /dev/null -w 'open    %{http_code}\n'  https://open.beerbot.app/
```

Then log in once on app.beerbot.app (password, Google, Apple) and in the legacy app.

Tester builds made before the cutover point at the old hostnames, which now redirect, and
their tokens carry the old issuer: testers install the next build (see below).

## Builds and release

Store builds use the `production` EAS profile (`beerbot.app`). After BeerbotApp/BeerBot#3
the `testing` profile points at production too (no staging for now).

```sh
# testers (TestFlight + Play internal), against production:
gh workflow run mobile-release.yml --repo BeerbotApp/BeerBot --ref main -f profile=testing -f platform=all -f submit=true -f bump=none
# store release candidate (App Store Connect + Play production as draft):
gh workflow run mobile-release.yml --repo BeerbotApp/BeerBot --ref main -f profile=production -f platform=all -f submit=true -f bump=none
```

## Legacy notice and retirement

When the new version is live in both stores:

```sh
# on the VPS (copy homelab/stacks/beerbot-legacy/notify/ there first)
./run.sh "BeerBot got a big update" "Update BeerBot from the App Store / Play Store. This version stops working on <date>."           # dry run
./run.sh "BeerBot got a big update" "Update BeerBot from the App Store / Play Store. This version stops working on <date>." --send
```

~4 weeks later (send a last reminder a few days before):

1. Remove the legacy handles in `stacks/vps-proxy/caddy/Caddyfile` (api./auth. become
   plain `reverse_proxy` to the new services; drop `open.beerbot.app`).
2. Set `deploy = false` for `beerbot-legacy` in `syncs/vps/stacks.toml` and destroy it.
3. Stop the migrator (`BeerBot.Migrator sunset`) and remove it from the beerbot stack.
4. Optionally set `MIN_CLIENT_VERSION` on `beerbot-api` once old new-app versions must go.

## Rollback

`git revert -m 1 <merge commit> && git push` on homelab main. The reconcile restores the
test hostnames within 5 minutes; nothing in the data changes.
