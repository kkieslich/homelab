#!/usr/bin/env python3
"""Validate the declarative Komodo GitOps invariants in syncs/*.toml."""

from pathlib import Path
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[1]
AUTO_UPDATE_STACKS = {
    "actual",
    "beerbot",
    "home-assistant",
    "ledfx",
    "monitoring",
    "mqtt",
    "music-assistant",
    "proxy",
}
BEERBOT_STATEFUL_SERVICES = {
    "beerbot-db",
    "beerbot-db-init",
    "beerbot-minio",
    "beerbot-minio-init",
}
BEERBOT_ONE_SHOTS = {
    "beerbot-db-init",
    "beerbot-keycloak-config",
    "beerbot-minio-init",
    "beerbot-provision",
}


def load(name: str) -> dict:
    with (ROOT / "syncs" / name).open("rb") as file:
        return tomllib.load(file)


def main() -> int:
    stacks = load("stacks.toml")["stack"]
    procedures = load("procedures.toml")["procedure"]
    by_name = {stack["name"]: stack for stack in stacks}
    errors: list[str] = []

    for stack in stacks:
        if stack.get("deploy") is not True:
            errors.append(f"{stack['name']}: expected top-level deploy = true")

    for name in sorted(AUTO_UPDATE_STACKS):
        config = by_name[name]["config"]
        if config.get("poll_for_updates") is not True:
            errors.append(f"{name}: expected poll_for_updates = true")
        if config.get("auto_update") is not True:
            errors.append(f"{name}: expected auto_update = true")

    sendspin = by_name["sendspin"]["config"]
    if sendspin.get("poll_for_updates") or sendspin.get("auto_update"):
        errors.append("sendspin: locally built image must not use registry polling")

    beerbot = by_name["beerbot"]["config"]
    if not BEERBOT_STATEFUL_SERVICES <= set(
        beerbot.get("auto_update_skip_services", [])
    ):
        errors.append("beerbot: stateful services are not excluded from auto update")
    if set(beerbot.get("ignore_services", [])) != BEERBOT_ONE_SHOTS:
        errors.append("beerbot: ignore_services must contain exactly its one-shot jobs")

    reconcile = next(
        (p for p in procedures if p["name"] == "GitOps - Reconcile homelab"),
        None,
    )
    if reconcile is None:
        errors.append("missing GitOps - Reconcile homelab procedure")
    else:
        config = reconcile["config"]
        if config.get("schedule") != "every 5 minutes":
            errors.append("reconciliation schedule must be every 5 minutes")
        if config.get("schedule_enabled") is not True:
            errors.append("reconciliation schedule must be enabled")
        expected_execution = {"type": "RunSync", "params": {"sync": "homelab"}}
        execution = config["stage"][0]["executions"][0]["execution"]
        if execution != expected_execution:
            errors.append(f"unexpected reconciliation execution: {execution!r}")
        if len(config["stage"]) != 1:
            errors.append("reconciliation must not modify its own running procedure")

    proxy_refresh = next(
        (p for p in procedures if p["name"] == "GitOps - Refresh proxy"), None
    )
    expected_proxy_execution = {"type": "DeployStack", "params": {"stack": "proxy"}}
    if proxy_refresh is None:
        errors.append("missing GitOps - Refresh proxy procedure")
    else:
        config = proxy_refresh["config"]
        proxy_execution = config["stage"][0]["executions"][0]["execution"]
        if proxy_execution != expected_proxy_execution:
            errors.append(f"unexpected proxy refresh execution: {proxy_execution!r}")
        if config.get("schedule") != "every 5 minutes" or config.get("schedule_enabled") is not True:
            errors.append("proxy refresh schedule must be enabled every 5 minutes")

    caddyfile = (ROOT / "stacks" / "proxy" / "caddy" / "Caddyfile").read_text()
    proxy_compose = (ROOT / "stacks" / "proxy" / "docker-compose.yml").read_text()
    if "admin {$LEDFX_PASSWORD_HASH}" not in caddyfile:
        errors.append("proxy: LedFx password hash must use Caddy environment substitution")
    if "$2a$" in caddyfile or "$2b$" in caddyfile or "$2y$" in caddyfile:
        errors.append("proxy: Caddyfile contains an inline bcrypt hash")
    if "path: ./.env" not in proxy_compose:
        errors.append("proxy: Caddy service must consume its repo-decrypted .env")
    proxy_config = by_name["proxy"]["config"]
    if "sops -d" not in proxy_config.get("pre_deploy", {}).get("command", ""):
        errors.append("proxy: missing SOPS pre_deploy decryption")

    beerbot_config = by_name["beerbot"]["config"]
    beerbot_pre_deploy = beerbot_config.get("pre_deploy", {}).get("command", "")
    for required in ("registry.env.enc", "old-vps.key.enc", "docker login"):
        if required not in beerbot_pre_deploy:
            errors.append(f"beerbot: pre_deploy missing {required}")
    if beerbot_config.get("registry_provider") or beerbot_config.get("registry_account"):
        errors.append("beerbot: registry credential must not depend on host bootstrap")

    if errors:
        print("\n".join(f"FAIL: {error}" for error in errors), file=sys.stderr)
        return 1

    print(
        f"PASS: {len(stacks)} deployable stacks; reconciliation and image policies valid"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
