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

Running on the UM870: **beerbot, proxy (Caddy), Komodo**. Everything else is
**TEMP-DISABLED** in `syncs/stacks.toml` (`deploy`, `poll_for_updates`,
`auto_update` set to `false`) and was destroyed via Komodo `DestroyStack`
(data in `/persist` and named volumes is untouched): wg-easy, mqtt,
home-assistant, music-assistant, ledfx, monitoring, actual, sendspin,
doctolib-watch. To restore: flip those flags back to `true`, push, and let the
sync deploy them (or `DeployStack`). Monitoring's OpenWRT (`192.168.1.1/.2`)
and TC4400 (`192.168.100.1`) targets only exist at the old home.

## BeerBot hosting (in transition)

- **Old prod** (pre-Expo version, live users): the old Contabo VPS behind
  `beerbot.app`. Deployed by a self-hosted GitHub actions-runner running
  `docker compose` from its work dir; images are built locally there (no
  registry), Traefik in front. Hostnames `beerbot.app`, `api.`, `auth.` (DNS on
  Cloudflare). Outdated; being retired.
- **New version** (Expo app, testers only): `stacks/beerbot` here, on the UM870,
  hostnames `*.beerbot.home.kki.berlin`. `beerbot-migrator` forward-syncs old prod
  data over an SSH tunnel (`old-vps.key.enc`).
- **Plan (decided 2026-10-28):** a new **Contabo Cloud VPS 4** (4 vCPU / 8 GB,
  x86, 12-month term) hosts **both** the old instance (frozen, images copied over,
  DB dumped/restored, auth server's mounted key files copied) and the new stack,
  behind one Caddy. Cut old users over by switching the `beerbot.app` A records,
  keep the old VPS 1–2 weeks as rollback, then cancel it. Retire the old instance
  only after the new app is through App Store review. Komodo Core on the UM870
  cannot reach a remote VPS from behind DS-Lite without Tailscale or similar —
  decide how the VPS is managed when setting it up.
- The images are under the owner's control; ARM builds are possible but were not
  cheaper in 2026 pricing.

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
