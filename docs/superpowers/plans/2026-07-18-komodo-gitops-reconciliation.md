# Komodo GitOps Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make commits to `main` and approved Docker image changes reconcile onto the NixOS host without Komodo UI pull, sync, or redeploy actions.

**Architecture:** Keep Komodo as the deploy controller and this repository as the desired-state source. Add an internal scheduled `RunSync` trigger because GitHub cannot reliably call the LAN-only Komodo endpoint, mark stacks as deployable by Resource Sync, and make image updates an explicit per-stack policy. Fix the NixOS secret ordering so Periphery and Core are continuously available, then prove both Git and image paths with disposable canary changes.

**Tech Stack:** Komodo 2.2.0 Resource Sync/Procedures, Docker Compose, NixOS/systemd, sops-nix, GitHub/GHCR, TOML.

## Global Constraints

- Do not expose the Komodo UI or API publicly merely to receive GitHub webhooks.
- Keep secrets out of Git; continue using sops-nix and SOPS-encrypted repository files.
- Do not auto-update stateful databases across unreviewed major or minor versions.
- Every automated deployment must leave an auditable Komodo execution record.
- Preserve host data under `/persist/appdata` and existing Docker named volumes.

---

## Current-state findings (2026-07-18)

- Resource Sync `homelab` successfully reads `main` at `a8d2322`, but it is only run by `komodo-bootstrap.service` during NixOS activation. There is no recurring `RunSync` and no Git webhook.
- `managed = false` is not the blocker. In Komodo this flag controls committing UI edits back to a single sync file; it does not mean “automatically apply Git.”
- None of the `[[stack]]` declarations in `syncs/stacks.toml` contains `deploy = true`.
- Live stack drift is substantial: `beerbot` is at `a8d2322`, `sendspin` at `a522927`, most clones are at `144354a`, while Komodo reports older deployed hashes for `actual`, `home-assistant`, `ledfx`, `monitoring`, `mqtt`, and `proxy`.
- `Global Auto Update` is enabled and runs every 15 minutes. Only `beerbot` and `music-assistant` have both `poll_for_updates` and `auto_update`; therefore the other stacks are intentionally outside this path.
- Komodo Core's `resource_poll_interval` is one hour. This updates status; it does not execute a Resource Sync or deploy Git changes.
- Periphery could not start from July 13 until July 18 because `/run/secrets/komodo-periphery.env` did not exist. systemd attempted over 44,000 restarts. It started only after the secret reappeared at 10:01 on July 18.
- `komodo-bootstrap.service` requires Core but does not explicitly order itself after a healthy Periphery, despite `RunSync` potentially needing Periphery for stack actions.
- Komodo currently reports `actual` and `beerbot` unhealthy because expected one-shot containers are exited; health policy needs to ignore successful init/one-shot services so real failures remain visible.

### Task 1: Repair Komodo service readiness in the NixOS repository

**Files:**
- Modify: the `home-infrastructure` module that defines `sops.secrets."komodo-periphery.env"`, `komodo-periphery.service`, and `komodo-bootstrap.service` (locate with `rg -n 'komodo-periphery.env|komodo-bootstrap'`)
- Test: the same module's systemd unit assertions, or add a Nix evaluation check beside the module if the repository has a checks pattern

**Interfaces:**
- Consumes: sops-nix secret `/run/secrets/komodo-periphery.env` and `komodo-age-key.service`
- Produces: Periphery that starts only after its required secret exists, and bootstrap that starts after Core and Periphery are active

- [ ] **Step 1: Record the failing state before changing Nix**

Run on the host:

```bash
systemctl show komodo-periphery.service -p After -p Requires -p NRestarts
journalctl -u komodo-periphery.service --since '2026-07-13' --grep 'Failed to load environment files' --no-pager | tail
```

Expected: the secret-producing unit is absent from `Requires`; the journal contains repeated missing environment-file failures.

- [ ] **Step 2: Add explicit secret and agent ordering**

In the Nix module, extend the existing units rather than creating duplicate definitions:

```nix
systemd.services.komodo-periphery = {
  after = [ "network-online.target" "docker.service" "sops-nix.service" ];
  requires = [ "sops-nix.service" ];
  unitConfig.ConditionPathExists = "/run/secrets/komodo-periphery.env";
};

systemd.services.komodo-bootstrap = {
  after = [ "docker-komodo-core.service" "komodo-periphery.service" ];
  requires = [ "docker-komodo-core.service" "komodo-periphery.service" ];
};
```

If this repository's sops-nix version exposes a per-secret unit, use that unit instead of the broad `sops-nix.service`. Verify the actual unit name with `systemctl list-units '*sops*'` before committing.

- [ ] **Step 3: Evaluate and deploy the NixOS configuration**

Run the repository's existing flake check and deployment command. At minimum:

```bash
nix flake check
```

Expected: evaluation succeeds with no missing systemd unit references.

- [ ] **Step 4: Reboot-test readiness**

After deploying, reboot once during a maintenance window and run:

```bash
systemctl is-active komodo-periphery.service docker-komodo-core.service komodo-bootstrap.service
systemctl show komodo-periphery.service -p NRestarts
journalctl -b -u komodo-periphery.service --no-pager
```

Expected: all three units are active/successful, `NRestarts=0`, and there are no missing-secret errors.

- [ ] **Step 5: Commit the NixOS repair**

```bash
git add <modified-nix-module> <optional-check-file>
git commit -m "fix(komodo): order periphery after sops secrets"
```

### Task 2: Add autonomous repository reconciliation

**Files:**
- Modify: `syncs/stacks.toml`
- Modify: `syncs/procedures.toml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `homelab` Resource Sync created by NixOS bootstrap
- Produces: a scheduled procedure that runs `RunSync` and stack declarations that permit sync-driven deploys

- [ ] **Step 1: Capture the current drift as the failing acceptance check**

Use the persisted Komodo API key on the host to list stacks and compare `info.deployed_hash` with `info.latest_hash`. Save only names and hashes, never credentials.

Expected: at least `actual`, `home-assistant`, `ledfx`, `monitoring`, `mqtt`, `music-assistant`, `proxy`, and `sendspin` differ from `a8d2322`.

- [ ] **Step 2: Mark each production stack deployable by Resource Sync**

Add this top-level key immediately after every stack name in `syncs/stacks.toml`:

```toml
[[stack]]
name = "proxy"
deploy = true
```

Repeat for `mqtt`, `home-assistant`, `music-assistant`, `ledfx`, `monitoring`, `actual`, `beerbot`, and `sendspin`. Do not place `deploy` under `[stack.config]`.

- [ ] **Step 3: Declare a recurring sync procedure**

Add to `syncs/procedures.toml`:

```toml
[[procedure]]
name = "GitOps - Reconcile homelab"
description = "Fetches main, applies declarative resources, and deploys stacks whose desired state changed."
tags = ["system", "gitops"]
config.schedule = "every 5 minutes"
config.schedule_enabled = true

[[procedure.config.stage]]
name = "Apply desired state"
enabled = true
executions = [
  { execution.type = "RunSync", execution.params.sync = "homelab", enabled = true },
]
```

- [ ] **Step 4: Validate TOML against the running Core schema**

Run:

```bash
curl -fsS http://192.168.1.20:9120/schema/resources.json -o /tmp/komodo-resources-schema.json
```

Validate `syncs/*.toml` with the repository's TOML/schema validator if present. If none exists, run Komodo's sync preview/API parser and confirm it reports no parse errors before applying.

- [ ] **Step 5: Apply once and observe blast radius**

Run `RunSync` once through the API or CLI, then inspect its execution record. Confirm whether Komodo 2.2 redeploys all repo-backed stacks because the monorepo commit hash changed, or only stacks whose compose/config content changed.

Expected: sync succeeds and no manual UI action is used. Record the redeployed stack names in the commit message or implementation notes. If every stack redeploys on an unrelated path change, continue with Task 3 before enabling the five-minute schedule.

- [ ] **Step 6: Document the trigger and recovery behavior**

Replace the README claim `Push to main → Komodo reconciles` with the exact five-minute scheduled flow, expected maximum latency, where to inspect failures, and the manual API/CLI recovery command. State explicitly that `managed` is unrelated to auto-apply.

- [ ] **Step 7: Commit autonomous reconciliation**

```bash
git add syncs/stacks.toml syncs/procedures.toml README.md
git commit -m "feat(gitops): reconcile Komodo stacks on schedule"
```

### Task 3: Prevent unnecessary monorepo-wide redeploys

**Files:**
- Modify: `syncs/procedures.toml`
- Create: `syncs/actions.toml` only if Komodo 2.2 proves that `RunSync` redeploys every stack for every repository commit
- Modify: the NixOS bootstrap Resource Sync `resource_path` to include `syncs/actions.toml` if created
- Modify: `README.md`

**Interfaces:**
- Consumes: Git diff between each deployed hash and `origin/main`, plus the mapping `stacks/<name>/...` to Komodo stack `<name>`
- Produces: deployments limited to stacks whose directory changed, while changes under `syncs/` still run Resource Sync

- [ ] **Step 1: Run a harmless path-isolation canary**

Change only a comment under one non-critical stack, push it, wait one schedule interval, and inspect Komodo updates.

Expected: only that stack redeploys. If this passes, delete this task's proposed Action and keep native `deploy = true` behavior.

- [ ] **Step 2: If isolation fails, separate config sync from stack deployment**

Remove `deploy = true` and replace the procedure with a Komodo Action that:

1. runs `RunSync` for changes under `syncs/`;
2. fetches `origin/main` once;
3. computes changed top-level `stacks/<name>/` directories since the corresponding live `deployed_hash`;
4. calls `DeployStackIfChanged` only for those names;
5. fails the execution if any requested deploy fails.

Use Komodo's built-in typed Action editor/client so no API key is embedded. Validate every execution type and parameter against Core's `/schema/resources.json` and Action type hints; do not guess API names.

- [ ] **Step 3: Add `syncs/actions.toml` to the bootstrap path**

Change the NixOS bootstrap JSON to:

```json
"resource_path": [
  "syncs/stacks.toml",
  "syncs/variables.toml",
  "syncs/procedures.toml",
  "syncs/actions.toml"
]
```

Expected: the next NixOS activation updates `homelab` without UI input.

- [ ] **Step 4: Repeat canaries for stack and sync paths**

Push one comment-only change under `stacks/mqtt/`, then one harmless description change under `syncs/`.

Expected: the first deploys only `mqtt`; the second updates Komodo resources and deploys only resources with relevant desired-state changes.

- [ ] **Step 5: Commit selective reconciliation**

```bash
git add syncs/procedures.toml syncs/actions.toml README.md <modified-nix-module>
git commit -m "feat(gitops): deploy only changed monorepo stacks"
```

### Task 4: Define a safe image-update policy for every stack

**Files:**
- Modify: `syncs/stacks.toml`
- Modify: compose files under `stacks/*/docker-compose.y*ml` where mutable tags must be pinned
- Create: `.github/renovate.json` if Renovate is selected for reviewed version bumps
- Modify: `README.md`

**Interfaces:**
- Consumes: `Global Auto Update` every 15 minutes and configured registry accounts
- Produces: explicit `automatic`, `PR-reviewed`, or `pinned/manual` policy for every service image

- [ ] **Step 1: Inventory mutable images**

Run:

```bash
rg -n '^\s*image:' stacks --glob 'docker-compose.y*ml'
```

Classify each image. Recommended starting policy:

- Automatic digest rollout: BeerBot application images and the owned Music Assistant fork.
- PR-reviewed version bump: Home Assistant, Matter Server, Grafana, Prometheus, Caddy, exporters, LedFx, Actual, MinIO, and Keycloak tooling.
- Strictly pinned/manual migration: PostgreSQL, MongoDB, and any image with on-disk schema compatibility constraints.
- Locally built images: redeploy on source changes, not registry polling.

- [ ] **Step 2: Make policy explicit in stack declarations**

For automatic stacks retain:

```toml
poll_for_updates = true
auto_update = true
```

For PR-reviewed stacks use immutable version tags or digests in Compose and leave `auto_update = false`. Let an updater open pull requests; merging the PR uses the Git reconciliation path.

- [ ] **Step 3: Configure reviewed updates**

If GitHub Renovate is used, create `.github/renovate.json` with Docker Compose managers enabled, grouped low-risk patch updates, and no automerge for stateful services. If a different bot already exists in `home-infrastructure`, reuse it rather than adding a second updater.

- [ ] **Step 4: Prove the private GHCR path**

Push a disposable BeerBot canary image tag/digest through its normal CI, then wait up to 20 minutes.

Expected: Komodo records `GlobalAutoUpdate`, pulls through registry account `ghcr.io/kkieslich`, recreates only changed BeerBot services, and the running container image ID matches the registry digest.

- [ ] **Step 5: Commit image policy**

```bash
git add syncs/stacks.toml stacks .github/renovate.json README.md
git commit -m "chore(gitops): define safe image update policy"
```

### Task 5: Make health and failure detection actionable

**Files:**
- Modify: `syncs/stacks.toml`
- Modify: `syncs/procedures.toml`
- Modify: `README.md`

**Interfaces:**
- Consumes: Compose service lifecycle and Komodo stack state
- Produces: healthy steady state and alerts for failed sync/deploy/image updates

- [ ] **Step 1: Identify expected one-shot services**

For `actual` and `beerbot`, list services whose successful steady state is `exited (0)` and distinguish them from crash-looped long-running services.

- [ ] **Step 2: Configure `ignore_services` narrowly**

Add only verified one-shot/init service names to each stack's `ignore_services`. Do not ignore `beerbot-api`, web frontends, databases, migrators intended to run continuously, or `actual_server`.

- [ ] **Step 3: Enable alerts on automation failures**

Keep `failure_alert = true` and `schedule_alert = true` on both reconciliation and auto-update procedures. Configure an existing Komodo Alerter to deliver failed `RunSync`, `DeployStack`, and `GlobalAutoUpdate` events; do not add a new external notification destination without user authorization.

- [ ] **Step 4: Add a read-only drift check**

Document a host command/API query that fails when any stack has `latest_hash != deployed_hash`, any resource is unhealthy unexpectedly, or the last scheduled reconciliation is older than ten minutes. Run it from monitoring if an existing exporter/alert path can consume it; otherwise keep it as an operator check for this iteration.

- [ ] **Step 5: Run the final end-to-end acceptance test**

Verify all of the following without touching the Komodo UI:

1. Push a comment/config canary to one stack on `main`.
2. The scheduled reconciliation detects it within five minutes.
3. Only the intended stack is pulled/redeployed.
4. Its `deployed_hash` advances to the pushed commit.
5. Push a new canary image for one automatic service.
6. Global Auto Update deploys its new digest within 20 minutes.
7. Reboot the host and repeat the read-only drift check.

Expected: every check passes, execution history identifies the system scheduler as operator, and no UI pull/redeploy/sync action is required.

- [ ] **Step 6: Commit observability and runbook updates**

```bash
git add syncs/stacks.toml syncs/procedures.toml README.md
git commit -m "chore(gitops): add health policy and reconciliation checks"
```

## Rollout order and rollback

1. Repair NixOS service ordering first; GitOps cannot work while Periphery is absent.
2. Apply Resource Sync scheduling with a five-minute interval, initially with alerting and one canary.
3. Observe whether native sync deploys have acceptable monorepo selectivity; add the selective Action only if evidence requires it.
4. Expand image automation one policy group at a time.
5. Roll back by disabling the reconciliation procedure schedule through the API/CLI, then revert the responsible Git commit. Do not delete stacks or volumes.

