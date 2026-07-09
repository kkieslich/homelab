"""
Production fetcher: pull booked + pending transactions from a configured FinTS
bank for one or all accounts in a date window, parse the camt.052 XML, and
emit clean JSON suitable for the Actual-Budget importer.

Output shape (stdout or --out):
    {
      "fetched_at": "2026-05-03T22:30:00Z",
      "bank": { "key": "umwelt", "display_name": "UmweltBank", "blz": "76035000" },
      "window": { "start": "2026-04-03", "end": "2026-05-03" },
      "accounts": [
        {
          "iban": "DE59...",
          "account_number": "8001107152",
          "transactions": [ { ... }, ... ]
        }
      ]
    }

Usage:
    fints-fetch --bank umwelt --days 60
    fints-fetch --bank fnz --days 30 --out /tmp/fnz.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import sys
import time
from pathlib import Path

from fints.client import FinTS3PinTanClient, FinTSClientMode, NeedTANResponse
from fints.models import SEPAAccount

from fints_bridge.camt052 import parse_balances_many, parse_many
from fints_bridge.config import BankProfile, list_profiles, load_profile


def _accounts_from_config(profile: BankProfile) -> list[SEPAAccount]:
    """Construct SEPAAccount tuples from banks.toml when enumerate_accounts=False.

    Required per-account: `accountnumber`. Optional: `iban`, `bic`, `subaccount`.
    Falls back to profile-level `bic` (and empty subaccount) when missing.
    """
    out: list[SEPAAccount] = []
    for a in profile.accounts:
        num = a.get("accountnumber")
        if not num:
            print(f"[config] [skip] account in profile '{profile.key}' has no accountnumber: {a}", file=sys.stderr)
            continue
        out.append(SEPAAccount(
            iban=a.get("iban") or "",
            bic=a.get("bic") or profile.bic or "",
            accountnumber=str(num),
            subaccount=a.get("subaccount") or "",
            blz=profile.blz,
        ))
    return out


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
    decoupled = [k for k, m in methods.items() if _is_decoupled(m)]
    chosen = decoupled[0] if decoupled else next(iter(methods))
    print(
        f"[fetch] using TAN method {chosen} ({getattr(methods[chosen], 'name', '?')})",
        file=sys.stderr,
    )
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
            print(
                f"[SCA] auto-polling for app approval "
                f"(every {wait_next}s, up to {max_polls} polls = {max_polls * wait_next // 60} min)...",
                file=sys.stderr,
            )
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
                print(file=sys.stderr)  # newline after the carriage-returned poll counter
            if isinstance(last, NeedTANResponse):
                sys.exit("[SCA] timed out waiting for app approval")
            print("[SCA] approved", file=sys.stderr)
            return last
        # Bank disallows automated polling — fall back to manual confirmation.
        input("Approve in your TAN app, then press <Enter>... ")
        return client.send_tan(response, "")

    tan = input("Enter TAN: ").strip()
    return client.send_tan(response, tan)


def _install_internals_probe() -> None:
    """Monkey-patch python-fints to log what _continue_fetch_with_touchdowns and
    _response_handler_get_transactions_xml actually collect — used to debug the
    'bank returned data but client reports 0' case."""
    from fints.client import FinTS3Client

    orig_handler = FinTS3Client._response_handler_get_transactions_xml

    def patched_handler(responses):
        print(f"[probe] response handler: {len(responses)} HICAZ segments collected", file=sys.stderr)
        for i, seg in enumerate(responses):
            sb = getattr(seg, "statement_booked", None)
            cs = getattr(sb, "camt_statements", None) if sb else None
            print(
                f"[probe]   seg[{i}] type={type(seg).__name__}  "
                f"statement_booked.camt_statements={len(cs) if cs else 0} item(s)",
                file=sys.stderr,
            )
            if cs:
                preview = cs[0][:120].decode("utf-8", errors="replace")
                print(f"[probe]     first 120 bytes: {preview!r}", file=sys.stderr)
        return orig_handler(responses)

    FinTS3Client._response_handler_get_transactions_xml = staticmethod(patched_handler)

    orig_continue = FinTS3Client._continue_fetch_with_touchdowns

    def patched_continue(self, command_seg, response):
        found = list(
            response.response_segments(command_seg, *self._touchdown_args, **self._touchdown_kwargs)
        )
        print(
            f"[probe] _continue_fetch: command={command_seg.header.type} "
            f"#{command_seg.header.number}; response_segments(ref-filtered) -> {len(found)}",
            file=sys.stderr,
        )
        if not found:
            all_segs = list(
                response.find_segments(*self._touchdown_args, **self._touchdown_kwargs)
            )
            print(
                f"[probe]   un-filtered find_segments({self._touchdown_args!r}) -> {len(all_segs)}",
                file=sys.stderr,
            )
            for s in all_segs:
                ref = getattr(s.header, "reference", "(none)")
                print(f"[probe]     header.type={s.header.type}  number={s.header.number}  reference={ref}", file=sys.stderr)
        return orig_continue(self, command_seg, response)

    FinTS3Client._continue_fetch_with_touchdowns = patched_continue


def _drain_sca(client: FinTS3PinTanClient, response):
    while isinstance(response, NeedTANResponse):
        response = _complete_sca(client, response)
    return response


def _dump_raw_xml(prefix: str, docs: list[bytes], iban: str, kind: str) -> None:
    """Persist raw camt.052 docs for debugging when parsing returned 0 entries."""
    import os
    os.makedirs(prefix, exist_ok=True)
    for i, blob in enumerate(docs):
        path = f"{prefix}/{iban}-{kind}-{i}.xml"
        with open(path, "wb") as f:
            f.write(blob)
        print(f"[debug] wrote {path} ({len(blob)} bytes)", file=sys.stderr)


CAMT_052_V8 = "urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"


def _mt940_to_dict(t) -> dict:
    """Normalize an mt-940 Transaction (from get_transactions/HKKAZ) into the same
    output schema as our camt.052 path, so the importer doesn't care which protocol
    the data came from."""
    d = t.data
    amount = d.get("amount")
    amount_cents = int(round(float(getattr(amount, "amount", 0)) * 100)) if amount else 0
    booking_date = d.get("date")
    value_date = d.get("entry_date") or d.get("guessed_entry_date")
    payee = d.get("applicant_name") or d.get("applicant_creditor_id")
    purpose = d.get("purpose") or d.get("additional_purpose")
    raw_id = d.get("transaction_reference") or d.get("bank_reference") or _synthetic(booking_date, amount_cents, payee, purpose)
    return {
        "imported_id": raw_id,
        "date": booking_date.isoformat() if booking_date else None,
        "value_date": value_date.isoformat() if value_date else None,
        "amount_cents": amount_cents,
        "currency": getattr(amount, "currency", "EUR") if amount else "EUR",
        "status": "BOOK",
        "payee_name": payee,
        "notes": purpose,
        "end_to_end_id": d.get("end_to_end_reference"),
        "account_servicer_ref": d.get("transaction_reference"),
    }


def _synthetic(date, amount_cents, payee, purpose) -> str:
    import hashlib
    h = hashlib.sha256()
    h.update(f"{date or ''}|{amount_cents}|{payee or ''}|{purpose or ''}".encode())
    return f"syn_{h.hexdigest()[:24]}"


def _holding_to_dict(h) -> dict:
    """Normalize a python-fints Holding namedtuple into JSON-friendly dict.

    market_value, total_value and acquisitionprice are plain floats (EUR);
    we convert to integer cents to match the rest of the bridge's output.
    """
    def cents(v):
        return int(round(float(v) * 100)) if v is not None else None
    val_date = getattr(h, "valuation_date", None)
    return {
        "isin": h.ISIN,
        "name": h.name,
        "pieces": float(h.pieces) if h.pieces is not None else 0.0,
        "market_value_cents": cents(h.market_value),
        "total_value_cents": cents(h.total_value),
        "currency": h.value_symbol or "EUR",
        "valuation_date": val_date.isoformat() if val_date else None,
        "acquisition_price_cents": cents(h.acquisitionprice),
    }


def _state_path_for(profile: BankProfile) -> "Path":
    """Per-bank persistent state file. Stores BPD/UPD + selected TAN mechanism
    so subsequent runs skip the handshake. Useful regardless of bank policy.
    Path is `<STATE_DIR>/.state-<bank>.bin` (defaults to PROJECT_ROOT)."""
    from fints_bridge.config import STATE_DIR
    return STATE_DIR / f".state-{profile.key}.bin"


def _dialog_path_for(profile: BankProfile) -> "Path":
    """Per-bank persistent ACTIVE-DIALOG state. Stores the in-flight FinTS
    dialog so the next run can resume it instead of opening a new one — which
    means no fresh login, no fresh SCA. Survives only as long as the bank's
    session timeout (e.g. UmweltBank ~5 min idle); on stale resume the bank
    closes the connection and we fall back to a fresh dialog with SCA."""
    from fints_bridge.config import STATE_DIR
    return STATE_DIR / f".dialog-{profile.key}.bin"


def _do_fetch(client, profile, *, accounts_filter_iban, start, end, use_mt940, dump_xml, out_accounts):
    """Per-account work loop. Assumes the standing dialog on `client` is open
    (either freshly initialised or resumed). Mutates `out_accounts` in place."""
    if profile.enumerate_accounts:
        accounts = client.get_sepa_accounts()
    else:
        accounts = _accounts_from_config(profile)
        print(f"[fetch] {profile.key}: enumerate_accounts=False, using {len(accounts)} configured accounts (HKSPA skipped)", file=sys.stderr)
    if accounts_filter_iban:
        accounts = [a for a in accounts if a.iban == accounts_filter_iban]
        if not accounts:
            sys.exit(f"[{profile.key}] no account with IBAN {accounts_filter_iban}")

    for a in accounts:
        account_type = profile.account_type(iban=a.iban, accountnumber=a.accountnumber)

        if account_type == "depot":
            print(f"[fetch] {profile.key}: {a.iban} ({a.accountnumber}) — DEPOT (HKWPD)", file=sys.stderr)
            try:
                holdings_resp = client.get_holdings(a)
            except Exception as exc:  # noqa: BLE001
                print(f"[fetch]   FAILED: {exc!r}", file=sys.stderr)
                continue
            holdings_resp = _drain_sca(client, holdings_resp)
            holdings = [_holding_to_dict(h) for h in (holdings_resp or [])]
            total = sum((h["total_value_cents"] or 0) for h in holdings)
            print(f"[fetch]   holdings={len(holdings)}  total_value=€{total/100:.2f}", file=sys.stderr)
            out_accounts.append({
                "iban": a.iban,
                "account_number": a.accountnumber,
                "type": "depot",
                "holdings": holdings,
            })
            continue

        mode = "HKKAZ/MT940" if use_mt940 else "HKCAZ/camt.052"
        print(f"[fetch] {profile.key}: {a.iban} ({a.accountnumber}) — {start}..{end}  via {mode}", file=sys.stderr)
        try:
            if use_mt940:
                resp = client.get_transactions(a, start_date=start, end_date=end)
            else:
                resp = client.get_transactions_xml(
                    a, start_date=start, end_date=end, supported_camt_messages=[CAMT_052_V8]
                )
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch]   FAILED: {exc!r}", file=sys.stderr)
            continue
        resp = _drain_sca(client, resp)
        if use_mt940:
            txs = [_mt940_to_dict(t) for t in (resp or [])]
            print(f"[fetch]   transactions={len(txs)} (HKKAZ)", file=sys.stderr)
            out_accounts.append(
                {"iban": a.iban, "account_number": a.accountnumber, "type": "cash", "transactions": txs}
            )
            continue
        if isinstance(resp, (list, tuple)) and len(resp) >= 2:
            booked_xml = [b for b in (resp[0] or []) if b]
            pending_xml = [b for b in (resp[1] or []) if b]
        else:
            booked_xml, pending_xml = [], []
        booked_bytes = sum(len(b) for b in booked_xml)
        pending_bytes = sum(len(b) for b in pending_xml)
        booked = [t.to_dict() for t in parse_many(booked_xml)]
        pending = [t.to_dict() for t in parse_many(pending_xml)]
        balances = [b.to_dict() for b in parse_balances_many(booked_xml)]
        print(
            f"[fetch]   booked={len(booked)}  pending={len(pending)}  balances={len(balances)}  "
            f"(received {len(booked_xml)} booked XML docs / {booked_bytes} B, "
            f"{len(pending_xml)} pending docs / {pending_bytes} B)",
            file=sys.stderr,
        )
        if dump_xml and (booked_xml or pending_xml):
            _dump_raw_xml(dump_xml, booked_xml, a.iban, "booked")
            _dump_raw_xml(dump_xml, pending_xml, a.iban, "pending")
        out_accounts.append(
            {
                "iban": a.iban,
                "account_number": a.accountnumber,
                "type": "cash",
                "balances": balances,
                "transactions": booked + pending,
            }
        )


def fetch_bank(
    profile: BankProfile,
    *,
    days: int,
    iban: str | None,
    dump_xml: str | None = None,
    use_mt940: bool = False,
) -> dict:
    # CLI flag wins; otherwise honor the bank's preference (e.g. Baader needs MT940).
    if not use_mt940 and profile.prefer_mt940:
        use_mt940 = True
        print(f"[fetch] {profile.key}: prefer_mt940=true, using HKKAZ/MT940 by default", file=sys.stderr)
    import os
    product_id = os.environ.get(profile.product_id_env or "FINTS_PRODUCT_ID") or "9FA6681DEC0CF3046BFC2F8A6"

    state_path = _state_path_for(profile)
    from_data = None
    if state_path.exists():
        try:
            from_data = state_path.read_bytes()
            print(f"[fetch] {profile.key}: restored client state from {state_path.name} ({len(from_data)} bytes)", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch] {profile.key}: ignoring stale state file ({exc!r})", file=sys.stderr)
            from_data = None

    client = FinTS3PinTanClient(
        profile.blz,
        profile.login,
        profile.pin,
        profile.fints_url,
        product_id=product_id,
        mode=FinTSClientMode.INTERACTIVE,
        from_data=from_data,
    )
    # Skip the TAN-mechanism picker if we already have one from restored state.
    if not client.selected_security_function or client.selected_security_function == '999':
        _pick_decoupled_mechanism(client)
    else:
        print(f"[fetch] {profile.key}: reusing TAN mechanism {client.selected_security_function} from saved state", file=sys.stderr)

    end = dt.date.today()
    start = end - dt.timedelta(days=days)
    out_accounts: list[dict] = []

    dialog_path = _dialog_path_for(profile)

    def _save_paused_dialog():
        try:
            blob = client.pause_dialog()
            dialog_path.write_bytes(blob)
            try:
                dialog_path.chmod(0o600)
            except OSError:
                pass
            print(f"[fetch] {profile.key}: paused & saved dialog ({len(blob)} bytes) -> {dialog_path.name}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch] {profile.key}: dialog pause failed (non-fatal): {exc!r}", file=sys.stderr)

    # Try to resume a previously-paused dialog so the bank's still-open session
    # is reused — no fresh login, no SCA prompt. If it fails (typically because
    # the bank timed it out), fall back to a fresh `with client:` which will
    # walk through the normal SCA flow.
    fetched_via_resume = False
    if dialog_path.exists():
        try:
            dialog_blob = dialog_path.read_bytes()
            with client.resume_dialog(dialog_blob):
                print(f"[fetch] {profile.key}: resumed saved dialog ({len(dialog_blob)} bytes) — should skip SCA", file=sys.stderr)
                _do_fetch(client, profile, accounts_filter_iban=iban, start=start, end=end, use_mt940=use_mt940, dump_xml=dump_xml, out_accounts=out_accounts)
                _save_paused_dialog()
            fetched_via_resume = True
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch] {profile.key}: resume failed ({exc!r}) — opening fresh dialog (will need SCA)", file=sys.stderr)
            try:
                dialog_path.unlink()
            except OSError:
                pass

    if not fetched_via_resume:
        # A failed resume leaves the previous client in an inconsistent state
        # (standing_dialog still attached). Build a fresh client for the
        # fallback so __enter__ can run cleanly.
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
        with client:
            if client.init_tan_response:
                _drain_sca(client, client.init_tan_response)
            _do_fetch(client, profile, accounts_filter_iban=iban, start=start, end=end, use_mt940=use_mt940, dump_xml=dump_xml, out_accounts=out_accounts)
            _save_paused_dialog()


    # Persist client state for next run. Saves system_id, BPD/UPD, and the
    # selected TAN mechanism. PIN is NOT included (per python-fints docs).
    # On banks honouring PSD2's 90-day exemption per (user, system_id, product_id),
    # this lets subsequent runs reuse the SCA without prompting again.
    try:
        blob = client.deconstruct(including_private=True)
        state_path.write_bytes(blob)
        try:
            state_path.chmod(0o600)
        except OSError:
            pass
        print(f"[fetch] {profile.key}: saved client state ({len(blob)} bytes) -> {state_path.name}", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[fetch] {profile.key}: state persist failed (non-fatal): {exc!r}", file=sys.stderr)

    return {
        "bank": {"key": profile.key, "display_name": profile.display_name, "blz": profile.blz},
        "window": {"start": start.isoformat(), "end": end.isoformat()},
        "accounts": out_accounts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--bank", help="single bank profile key as defined in banks.toml")
    group.add_argument("--all", action="store_true", help="fetch every bank profile defined in banks.toml (one SCA push per bank)")
    parser.add_argument("--days", type=int, default=30, help="lookback window in days (default: 30)")
    parser.add_argument("--iban", default=None, help="restrict to a single IBAN (single-bank mode only)")
    parser.add_argument("--out", default=None, help="write JSON to this path instead of stdout")
    parser.add_argument("--dump-xml", default=None, metavar="DIR", help="dump raw camt.052 XML docs into DIR for debugging")
    parser.add_argument("--mt940", action="store_true", help="use HKKAZ/MT940 instead of HKCAZ/camt.052 (only works for accounts where the bank allows HKKAZ — checking yes, credit card no)")
    parser.add_argument("--debug", action="store_true", help="enable python-fints DEBUG logging to stderr")
    parser.add_argument("--probe", action="store_true", help="monkey-patch python-fints internals to log what HKCAZ-touchdown collects")
    args = parser.parse_args()

    if args.debug:
        logging.basicConfig(level=logging.DEBUG, format="%(asctime)s %(name)s %(levelname)s %(message)s")
        logging.getLogger("fints").setLevel(logging.DEBUG)

    if args.probe:
        _install_internals_probe()

    if args.all and args.iban:
        sys.exit("--iban cannot be combined with --all (it would only ever match one bank's accounts)")

    bank_keys = [args.bank] if args.bank else list_profiles()
    if not bank_keys:
        sys.exit("No bank profiles found in banks.toml")

    bank_payloads: list[dict] = []
    for key in bank_keys:
        profile = load_profile(key)
        print(f"\n[fetch] === {profile.short()} ===", file=sys.stderr)
        bank_payloads.append(
            fetch_bank(
                profile, days=args.days, iban=args.iban, dump_xml=args.dump_xml, use_mt940=args.mt940
            )
        )

    payload = {
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "banks": bank_payloads,
    }

    out_str = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(out_str, encoding="utf-8")
        print(f"\n[fetch] wrote {args.out}", file=sys.stderr)
    else:
        print(out_str)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
