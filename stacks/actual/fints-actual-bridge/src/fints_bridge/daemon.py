"""Long-running bridge daemon: holds a FinTS dialog open across many fetches
to avoid the per-fetch SCA on banks like UmweltBank that enforce a short
session-idle timeout (~5 min) AND require SCA on every login.

How it works:
    1. Start daemon for one bank profile (e.g. UmweltBank). User approves SCA
       on phone once.
    2. Inside `with client:`, the daemon holds the dialog in memory.
    3. Every `--heartbeat-interval` seconds (default 180 = 3 min, well under
       UmweltBank's 5-min limit) the daemon sends a cheap call
       (`get_sepa_accounts`) to reset the bank's idle timer.
    4. Every `--fetch-interval` seconds (default 3600 = 1 h) it runs the full
       fetch and writes JSON to `--out`.
    5. On any unrecoverable error the daemon logs and exits non-zero. Under
       systemd, restarting the unit prompts you for fresh SCA.

This trades cron-style simplicity for a single SCA approval per session-life.
For banks that don't need SCA on read, the regular `fints-fetch` CLI is still
the right tool — no daemon needed.

Usage:
    fints-daemon --bank umwelt --out /tmp/umwelt.json
    fints-daemon --bank umwelt --fetch-interval 1800 --heartbeat-interval 180 \\
                 --out /var/lib/fints/umwelt.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from fints.client import FinTS3PinTanClient, FinTSClientMode

from fints_bridge.config import load_profile
from fints_bridge.fetch import (
    _do_fetch,
    _drain_sca,
    _pick_decoupled_mechanism,
    _state_path_for,
)


logger = logging.getLogger("fints-daemon")


_RUNNING = True


def _handle_sigterm(_signum, _frame):
    global _RUNNING
    logger.info("received SIGTERM — will exit after current cycle")
    _RUNNING = False


def _build_client(profile, product_id: str, from_data: bytes | None) -> FinTS3PinTanClient:
    client = FinTS3PinTanClient(
        profile.blz,
        profile.login,
        profile.pin,
        profile.fints_url,
        product_id=product_id,
        mode=FinTSClientMode.INTERACTIVE,
        from_data=from_data,
    )
    if not client.selected_security_function or client.selected_security_function == '999':
        _pick_decoupled_mechanism(client)
    return client


def _save_state(client, profile) -> None:
    try:
        blob = client.deconstruct(including_private=True)
        path = _state_path_for(profile)
        path.write_bytes(blob)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("state persist failed: %r", exc)


def _run_importer(importer: str, bank_key: str, out_path: Path) -> None:
    """Shell out to bin/import.mjs (or whatever --importer is) after a fetch.
    Failures are logged but don't kill the daemon — the JSON is on disk so the
    user can rerun the import manually."""
    cmd = importer.split() + ["--bank", bank_key, "--in", str(out_path)]
    logger.info("running importer: %s", " ".join(cmd))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if proc.returncode != 0:
            logger.error("importer failed (rc=%d):\nSTDOUT:\n%s\nSTDERR:\n%s", proc.returncode, proc.stdout, proc.stderr)
        else:
            # Importer writes useful counts to stderr (added=N updated=N).
            tail = "\n".join(line for line in proc.stderr.splitlines() if "added=" in line or "DONE" in line or "[holdings]" in line)
            logger.info("importer ok\n%s", tail or proc.stderr[-500:])
    except subprocess.TimeoutExpired:
        logger.error("importer timed out after 300s")
    except Exception as exc:  # noqa: BLE001
        logger.error("importer raised: %r", exc)


def _do_full_fetch(client, profile, days: int, use_mt940: bool, out_path: Path) -> dict:
    end = dt.date.today()
    start = end - dt.timedelta(days=days)
    out_accounts: list[dict] = []
    failures = _do_fetch(
        client, profile,
        accounts_filter_iban=None,
        start=start, end=end,
        use_mt940=use_mt940,
        dump_xml=None,
        out_accounts=out_accounts,
    )
    if failures:
        raise RuntimeError(f"{failures} account fetch(es) failed")
    payload = {
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "banks": [{
            "bank": {"key": profile.key, "display_name": profile.display_name, "blz": profile.blz},
            "window": {"start": start.isoformat(), "end": end.isoformat()},
            "accounts": out_accounts,
        }],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        out_path.chmod(0o600)
    except OSError:
        pass
    accounts_count = len(out_accounts)
    txs_count = sum(len(a.get("transactions", [])) for a in out_accounts)
    holdings_count = sum(len(a.get("holdings", [])) for a in out_accounts)
    logger.info("fetch ok: %d accounts, %d txs, %d holdings -> %s", accounts_count, txs_count, holdings_count, out_path)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bank", required=True, help="bank profile key from banks.toml")
    parser.add_argument("--out", required=True, help="where to write the fetch JSON on each cycle")
    parser.add_argument("--fetch-interval", type=int, default=3600, help="seconds between full fetches (default: 3600)")
    parser.add_argument("--heartbeat-interval", type=int, default=180, help="seconds between session keep-alives (default: 180; UmweltBank dies after 300)")
    parser.add_argument("--days", type=int, default=30, help="lookback window in days for each fetch (default: 30)")
    parser.add_argument("--mt940", action="store_true", help="force HKKAZ/MT940 protocol (default honours profile.prefer_mt940)")
    parser.add_argument("--import-after", action="store_true", help="after each fetch, shell out to `node bin/import.mjs` to push into Actual")
    parser.add_argument("--importer", default="node bin/import.mjs", help="command to run for --import-after (will be invoked with --bank <key> --in <out>)")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    if args.heartbeat_interval >= 270:
        logger.warning("heartbeat-interval %ds is close to or above UmweltBank's 5-min cutoff — recommend ≤180", args.heartbeat_interval)

    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)

    profile = load_profile(args.bank)
    use_mt940 = args.mt940 or profile.prefer_mt940
    out_path = Path(args.out)

    product_id = os.environ.get(profile.product_id_env or "FINTS_PRODUCT_ID") or "9FA6681DEC0CF3046BFC2F8A6"
    state_path = _state_path_for(profile)
    from_data = state_path.read_bytes() if state_path.exists() else None

    client = _build_client(profile, product_id, from_data)
    logger.info("daemon starting for %s (heartbeat=%ds, fetch=%ds, mt940=%s)", profile.short(), args.heartbeat_interval, args.fetch_interval, use_mt940)

    with client:
        if client.init_tan_response:
            logger.info("draining initial SCA — approve on your phone")
            _drain_sca(client, client.init_tan_response)
        _save_state(client, profile)

        # Initial fetch — but only if we haven't fetched recently. The mtime
        # of the output file is our "last fetch" marker. This makes restart
        # loops cheap: a daemon that crashed 2 min after a successful fetch
        # restarts straight into the heartbeat loop instead of re-fetching.
        existing_age_sec = None
        if out_path.exists():
            try:
                existing_age_sec = time.time() - out_path.stat().st_mtime
            except OSError:
                existing_age_sec = None

        if existing_age_sec is not None and existing_age_sec < args.fetch_interval:
            # Translate wall-clock age into the monotonic clock space the loop uses.
            last_fetch = time.monotonic() - existing_age_sec
            logger.info("skipping initial fetch — %s is %.0fs old (< fetch-interval %ds)", out_path.name, existing_age_sec, args.fetch_interval)
        else:
            try:
                _do_full_fetch(client, profile, args.days, use_mt940, out_path)
                last_fetch = time.monotonic()
                if args.import_after:
                    _run_importer(args.importer, profile.key, out_path)
            except Exception as exc:  # noqa: BLE001
                logger.error("initial fetch failed: %r", exc)
                return 1

        # Steady state: heartbeat every N seconds; full fetch every M.
        while _RUNNING:
            time.sleep(args.heartbeat_interval)
            if not _RUNNING:
                break
            now = time.monotonic()
            try:
                if now - last_fetch >= args.fetch_interval:
                    _do_full_fetch(client, profile, args.days, use_mt940, out_path)
                    last_fetch = now
                    if args.import_after:
                        _run_importer(args.importer, profile.key, out_path)
                else:
                    # Heartbeat: cheap call that keeps the bank's idle timer alive.
                    # Most banks accept HKSPA repeatedly; the response is small.
                    if profile.enumerate_accounts:
                        client.get_sepa_accounts()
                    else:
                        # Bank rejects HKSPA — use HIPINS (configuration query) as the heartbeat.
                        # As a last resort, just touch the connection without sending anything.
                        client.get_information()
                    logger.debug("heartbeat ok")
            except Exception as exc:  # noqa: BLE001
                logger.error("session lost: %r — exiting (restart for fresh SCA)", exc)
                return 2

    logger.info("daemon exiting cleanly")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
