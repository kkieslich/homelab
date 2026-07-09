"""
Diagnostic: connect to a configured FinTS bank, run SCA, and dump the account
list + a 30-day sample of transactions per account (camt.052 / HKCAZ).

Use this to verify a new bank profile works before relying on `fints-fetch`
for production import.

Usage:
    fints-spike --bank umwelt
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time

from fints.client import FinTS3PinTanClient, FinTSClientMode, NeedTANResponse

from fints_bridge.config import BankProfile, load_profile


def _is_decoupled(mech) -> bool:
    return (
        getattr(mech, "tech_id", "") == "DECOUPLED"
        or getattr(mech, "zka_id", "") == "Decoupled"
        or getattr(mech, "decoupled_max_poll_number", None) is not None
    )


def _pick_decoupled_mechanism(client: FinTS3PinTanClient) -> None:
    methods = client.get_tan_mechanisms()
    if not methods:
        return
    print("Available TAN methods:", file=sys.stderr)
    for sec_func, mech in methods.items():
        print(
            f"  {sec_func}: {getattr(mech, 'name', '?')}  "
            f"tech_id={getattr(mech, 'tech_id', '?')}  decoupled={_is_decoupled(mech)}",
            file=sys.stderr,
        )
    decoupled = [k for k, m in methods.items() if _is_decoupled(m)]
    chosen = decoupled[0] if decoupled else next(iter(methods))
    print(f"-> using {chosen} ({getattr(methods[chosen], 'name', '?')})", file=sys.stderr)
    client.set_tan_mechanism(chosen)


def _complete_sca(client: FinTS3PinTanClient, response: NeedTANResponse):
    print(f"\n[SCA] {response.challenge}", file=sys.stderr)
    is_decoupled = getattr(response, "decoupled", False) or "anderen Kanal" in (response.challenge or "")

    if is_decoupled:
        mech = client.get_tan_mechanisms().get(client.get_current_tan_mechanism())
        auto_ok = getattr(mech, "automated_polling_allowed", True) if mech else True
        if auto_ok:
            wait_first = int(getattr(mech, "wait_before_first_poll", 2) or 2) if mech else 2
            wait_next = int(getattr(mech, "wait_before_next_poll", 2) or 2) if mech else 2
            max_polls = int(getattr(mech, "decoupled_max_poll_number", 150) or 150) if mech else 150
            print(f"[SCA] auto-polling (every {wait_next}s, up to {max_polls} polls)...", file=sys.stderr)
            time.sleep(wait_first)
            last = client.send_tan(response, "")
            poll = 1
            while isinstance(last, NeedTANResponse) and poll < max_polls:
                end = "\r" if sys.stderr.isatty() else "\n"
                print(f"[SCA]   poll {poll}/{max_polls}", end=end, file=sys.stderr, flush=True)
                time.sleep(wait_next)
                last = client.send_tan(last, "")
                poll += 1
            if sys.stderr.isatty():
                print(file=sys.stderr)
            if isinstance(last, NeedTANResponse):
                sys.exit("[SCA] timed out waiting for app approval")
            print("[SCA] approved", file=sys.stderr)
            return last
        input("Approve in your TAN app, then press <Enter>... ")
        return client.send_tan(response, "")

    tan = input("Enter TAN: ").strip()
    return client.send_tan(response, tan)


def _drain_sca(client: FinTS3PinTanClient, response):
    while isinstance(response, NeedTANResponse):
        response = _complete_sca(client, response)
    return response


def _jsonable(x):
    if isinstance(x, dict):
        return {str(k): _jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple, set)):
        return [_jsonable(v) for v in x]
    if isinstance(x, (str, int, float, bool, type(None))):
        return x
    return str(x)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bank", required=True, help="bank profile key as defined in banks.toml")
    args = parser.parse_args()

    profile = load_profile(args.bank)
    print(f"[spike] {profile.short()}", file=sys.stderr)

    client = FinTS3PinTanClient(
        profile.blz,
        profile.login,
        profile.pin,
        profile.fints_url,
        product_id="9FA6681DEC0CF3046BFC2F8A6",
        mode=FinTSClientMode.INTERACTIVE,
    )
    _pick_decoupled_mechanism(client)

    with client:
        if client.init_tan_response:
            _drain_sca(client, client.init_tan_response)

        info = client.get_information()
        print("=== get_information() ===")
        print(json.dumps(_jsonable(info), indent=2, ensure_ascii=False))

        accounts = client.get_sepa_accounts()
        print(f"\n=== get_sepa_accounts() ({len(accounts)}) ===")
        for a in accounts:
            print(f"  iban={a.iban}  acct={a.accountnumber}  sub={a.subaccount}")

        end = dt.date.today()
        start = end - dt.timedelta(days=30)
        for a in accounts:
            print(f"\n--- transactions for {a.iban} (acct {a.accountnumber}) ---")
            try:
                resp = client.get_transactions_xml(a, start_date=start, end_date=end)
            except Exception as exc:  # noqa: BLE001
                print(f"  get_transactions_xml failed: {exc!r}")
                continue
            resp = _drain_sca(client, resp)
            if isinstance(resp, (list, tuple)) and len(resp) >= 2:
                booked = [b for b in (resp[0] or []) if b]
                pending = [b for b in (resp[1] or []) if b]
            else:
                booked, pending = [], []
            print(f"  booked camt.052 docs: {len(booked)}  pending: {len(pending)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
