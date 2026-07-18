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

    if errors:
        print("\n".join(f"FAIL: {error}" for error in errors), file=sys.stderr)
        return 1

    print(
        f"PASS: {len(stacks)} deployable stacks; reconciliation and image policies valid"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
