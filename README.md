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
  procedures.toml   scheduled Komodo procedures
  variables.toml    non-secret shared variables
```

## Conventions

- **Data** lives on the host at absolute `/persist/appdata/...` paths (bind
  mounts), so it is independent of Komodo's clone directory and survives
  container recreation.
- **Workload secrets** live beside their stack as SOPS ciphertext (`enc.env` or
  `*.enc`) and are decrypted on the target by Komodo `pre_deploy`. Plaintext
  outputs are gitignored. `home-infrastructure` contains only host and Komodo
  identity secrets; it has no Compose-workload credentials.
- The external `proxy_net` network is created outside Komodo (a small NixOS
  oneshot on the UM870).

## GitOps

A Komodo **Resource Sync** points at this repo with
`resource_path = ["syncs/stacks.toml", "syncs/variables.toml", "syncs/procedures.toml"]`.

The scheduled Komodo procedure **GitOps - Reconcile homelab** runs every five
minutes. It fetches `main`, applies the resource definitions, and deploys stacks
whose desired Git state changed (`deploy = true`). This deliberately uses
internal polling rather than exposing Komodo's `/listener` endpoint to GitHub.
No UI pull, sync, or redeploy action is required; expected worst-case Git rollout
latency is about five minutes plus deployment time.

The Proxy stack is also deployed idempotently on every reconciliation. Komodo
only compares Compose files when deciding whether a stack changed, while Caddy's
configuration is an auxiliary bind-mounted file. The deploy refreshes the Git
clone and Caddy's `--watch` process reloads the updated Caddyfile.

The separate **Global Auto Update** procedure runs every 15 minutes. Registry-
backed stacks opt into digest polling and automatic rollout in
`syncs/stacks.toml`. Stateful BeerBot PostgreSQL/MinIO services and locally built
images are excluded from unattended image changes.

`managed` mode is not required for this flow. In Komodo it controls writing UI
edits back to a single sync file, not whether remote Git changes are applied.

### Inspecting and recovering reconciliation

Check the latest **GitOps - Reconcile homelab** and **Global Auto Update** runs
in Komodo's execution history. A successful `RunSync` records the scheduler as
operator and advances each affected stack's `deployed_hash` to `latest_hash`.

If a scheduled run fails, fix the reported clone, compose, registry, or
pre-deploy error and execute the same procedure through the Komodo API/CLI. Do
not manually edit the checked-out repositories under
`/var/lib/komodo-periphery/stacks`; the next reconciliation treats `main` as the
source of truth.
