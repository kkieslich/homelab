# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

Docker Compose stacks deployed by **Komodo** (GitOps). Komodo Core runs on the UM870
home server; its NixOS host config lives in the sibling repo `../home-infrastructure`
(see its `CLAUDE.md` for host access and deploy). `README.md` explains the GitOps
mechanics: `syncs/*.toml` on `main` is the source of truth, reconciled every 5 minutes;
Global Auto Update polls image digests every 15 minutes. **Pushing to `main` deploys.**

## Current situation (since 2026-10-28) — read this first

The UM870 is **temporarily at a friend's place** behind a FritzBox on Vodafone
**DS-Lite** (no inbound IPv4). Nothing on it is publicly reachable, and the
`*.home.kki.berlin` records in Cloudflare still point at the old home line.

Running on the UM870: **proxy (Caddy), Komodo** (beerbot moved to the VPS on
2026-10-28). Everything else is
**TEMP-DISABLED** in `syncs/stacks.toml` (`deploy`, `poll_for_updates`,
`auto_update` set to `false`) and was destroyed via Komodo `DestroyStack`
(data in `/persist` and named volumes is untouched): wg-easy, mqtt,
home-assistant, music-assistant, ledfx, monitoring, actual, sendspin,
doctolib-watch. To restore: flip those flags back to `true`, push, and let the
sync deploy them (or `DeployStack`). Monitoring's OpenWRT (`192.168.1.1/.2`)
and TC4400 (`192.168.100.1`) targets only exist at the old home.

## BeerBot hosting (both versions on the Contabo VPS since 2026-10-28)

The VPS (`root@167.86.127.81`) runs its own Komodo (`/opt/komodo`; UI on
localhost:9120 via `ssh -L`) that syncs only `syncs/vps/`:

- **vps-proxy** — Caddy for every public beerbot hostname.
- **beerbot** — the new (Expo) version on `*.beerbot.home.kki.berlin`. Pictures
  live in **Garage** (`beerbot-s3`), set up by the stack's post_deploy hook;
  MinIO was dropped because its images are no longer published.
  `beerbot-migrator` forward-syncs from the legacy DB directly over proxy_net.
- **beerbot-legacy** — the old (pre-Expo) version, frozen, on `beerbot.app`,
  `api.`, `auth.`, `open.` (open was dead for a long time: missing DNS record).
  Images are local-only `beerbot-legacy/*` tags on the VPS — never rebuilt or
  pulled. Postgres must stay named `db` (hardcoded in the images); the auth
  server's signing certs are SOPS files beside the stack. Retire it once the new
  app is through App Store review.

The old Contabo VPS (194.163.165.188, no DNS pointing at it anymore) keeps its
stopped app containers and DB as a rollback for 1–2 weeks, then gets cancelled.

## Cross-stack architecture (when everything runs at home)

- **proxy** (Caddy) terminates TLS for `*.home.kki.berlin` with HTTP-01 (needs
  public 80/443). It routes to host-network services via `host.docker.internal:<port>`
  (`extra_hosts: host-gateway`) and to `proxy_net` members (actual, wg-easy,
  beerbot) by service name, which avoids a hairpin-NAT timeout. The Caddyfile is
  bind-mounted as a directory and reloaded by `--watch`; the "GitOps - Refresh
  proxy" procedure redeploys proxy every 5 minutes so Caddyfile edits land.
- **Networking**: home-assistant, matter-server, ledfx, music-assistant use
  `network_mode: host` (mDNS/AirPlay/Matter). `proxy_net` is external, created
  by a NixOS oneshot.
- **monitoring**: Prometheus scrapes in-stack targets by container name and LAN
  devices by IP; `network_exporter` owns ICMP/MTR/TCP probes, blackbox only DNS.
  Grafana provisioning is read-only from `grafana/provisioning/`; the Prometheus
  datasource UID is `prometheus`. UI dashboard edits must be exported and committed.
- Stack secrets: SOPS ciphertext beside each stack (`enc.env`, `*.enc`), decrypted
  by Komodo `pre_deploy` with the host age key. Never commit plaintext.

## Conventions

- `name: "<stack>"` at the top of compose files.
- Restart policy `unless-stopped` (`always` for ledfx).
- Timezones: `Europe/Amsterdam` for Home Assistant, `Europe/Berlin` for speedtest; intentional.
