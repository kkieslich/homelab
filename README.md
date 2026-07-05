# homelab

Docker Compose stacks for the home lab, deployed by **[Komodo](https://komo.do)**
across one or more hosts (the Minisforum UM870 now; a Raspberry Pi later).

Komodo Core runs on the UM870 (bootstrapped by NixOS via `oci-containers`); a
Periphery agent runs on each managed host. Komodo clones this repo onto the
target host and runs `docker compose` from each stack's directory.

## Layout

```
stacks/     one directory per stack (compose file + build contexts/config)
  proxy/            Caddy reverse proxy for *.home.kki.berlin
  mqtt/             Mosquitto
  home-assistant/   Home Assistant + Matter (host network)
  music-assistant/  Music Assistant (host network)
  ledfx/            LedFx (host network)
  monitoring/       Prometheus, Grafana, exporters, speedtest
  actual/           Actual Budget + FinTS bridge + SQLite sync
syncs/      Komodo GitOps resource definitions (TOML)
  servers.toml      managed hosts (Periphery)
  stacks.toml       one [[stack]] per stack, pinned to a server
  variables.toml    non-secret shared variables
```

## Conventions

- **Data** lives on the host at absolute `/persist/appdata/...` paths (bind
  mounts), so it is independent of Komodo's clone directory and survives
  container recreation.
- **Secrets** are NOT in this repo. Real secrets are delivered by **sops-nix**
  (in the separate `home-infrastructure` NixOS repo) to `/run/secrets/*.env`,
  which the compose files reference via `env_file:`. Komodo Variables are used
  only for non-secret pins.
- The external `proxy_net` network is created outside Komodo (a small NixOS
  oneshot on the UM870).

## GitOps

A Komodo **Resource Sync** points at this repo with
`resource_path = ["syncs/servers.toml", "syncs/stacks.toml", "syncs/variables.toml"]`.
Push to `main` → Komodo reconciles (diff shown in the UI; managed mode can
auto-apply).
