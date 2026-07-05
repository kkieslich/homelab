"""Bank profile loading.

Profiles live in `banks.toml` (gitignored) at the project root. Each profile
declares the BLZ, FinTS URL, and the env-var names that hold the login + PIN.
We never put credentials in the toml file itself — only references.
"""

from __future__ import annotations

import os
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
# Where per-bank persistent files (state, dialog, status, holdings) live.
# Defaults to PROJECT_ROOT for local dev; override with STATE_DIR env var so
# they can be written to a Docker volume shared with db-sync.
STATE_DIR = Path(os.environ.get("STATE_DIR") or PROJECT_ROOT)


@dataclass(frozen=True, slots=True)
class BankProfile:
    key: str
    display_name: str
    blz: str
    fints_url: str
    login: str
    pin: str
    # account type lookup. Each account dict in banks.toml may carry `iban`
    # and/or `accountnumber`. Brokerage depot accounts (e.g. Baader) commonly
    # have NO IBAN at all and must be matched on accountnumber. We index both.
    # Recognised types: "cash" (default — HKCAZ/camt.052) and "depot" (HKWPD
    # securities holdings via python-fints get_holdings()).
    types_by_iban: dict = None
    types_by_accountnumber: dict = None
    # Optional FinTS Product-ID. Some banks (notably Baader) reject the
    # default. Set FINTS_PRODUCT_ID in .env to override.
    product_id_env: str | None = None
    # If False, skip the HKSPA enumeration call (`get_sepa_accounts`) and
    # construct SEPAAccount objects directly from the configured `[[accounts]]`.
    # Use this for banks that reject HKSPA (Baader returns 9210 "Auftrag
    # abgelehnt"). Requires every configured account to have an `accountnumber`.
    enumerate_accounts: bool = True
    # If True, default to HKKAZ/MT940 instead of HKCAZ/camt.052 for this bank's
    # cash transactions. Baader rejects HKCAZ (9160) but supports HKKAZ. Can
    # still be overridden per-call via the --mt940 flag.
    prefer_mt940: bool = False
    # Default BIC used when constructing SEPAAccount manually (only consulted
    # when enumerate_accounts is False). Can be overridden per-account.
    bic: str | None = None
    # Raw account dicts from banks.toml — used when enumerate_accounts=False.
    accounts: tuple = ()

    def account_type(self, iban: str | None = None, accountnumber: str | None = None) -> str:
        if iban and (t := (self.types_by_iban or {}).get(iban)):
            return t
        if accountnumber and (t := (self.types_by_accountnumber or {}).get(str(accountnumber))):
            return t
        return "cash"

    def short(self) -> str:
        return f"{self.display_name} (BLZ {self.blz}, login {self.login})"


def _load_toml(path: Path) -> dict:
    if not path.exists():
        sys.exit(
            f"Missing config file: {path}\n"
            f"Copy banks.toml.example -> banks.toml and edit it."
        )
    with path.open("rb") as f:
        return tomllib.load(f)


def load_profile(bank_key: str, *, config_path: Path | None = None) -> BankProfile:
    load_dotenv(PROJECT_ROOT / ".env")
    cfg = _load_toml(config_path or PROJECT_ROOT / "banks.toml")
    banks = cfg.get("banks", {})
    if bank_key not in banks:
        available = ", ".join(sorted(banks)) or "(none)"
        sys.exit(f"Bank '{bank_key}' not in banks.toml. Available: {available}")
    b = banks[bank_key]

    missing_keys = [k for k in ("blz", "fints_url", "login_env", "pin_env") if k not in b]
    if missing_keys:
        sys.exit(f"banks.toml [{bank_key}] missing required keys: {', '.join(missing_keys)}")

    login = os.environ.get(b["login_env"])
    pin = os.environ.get(b["pin_env"])
    missing_env = [name for name, val in ((b["login_env"], login), (b["pin_env"], pin)) if not val]
    if missing_env:
        sys.exit(f"Missing env vars for [{bank_key}]: {', '.join(missing_env)}. Edit .env.")

    types_by_iban: dict = {}
    types_by_accountnumber: dict = {}
    for acc in b.get("accounts", []):
        t = acc.get("type", "cash")
        if iban := acc.get("iban"):
            types_by_iban[iban] = t
        if num := acc.get("accountnumber"):
            types_by_accountnumber[str(num)] = t

    return BankProfile(
        key=bank_key,
        display_name=b.get("display_name", bank_key),
        blz=b["blz"],
        fints_url=b["fints_url"],
        login=login,
        pin=pin,
        types_by_iban=types_by_iban,
        types_by_accountnumber=types_by_accountnumber,
        product_id_env=b.get("product_id_env"),
        enumerate_accounts=b.get("enumerate_accounts", True),
        prefer_mt940=b.get("prefer_mt940", False),
        bic=b.get("bic"),
        accounts=tuple(b.get("accounts", [])),
    )


def list_profiles(config_path: Path | None = None) -> list[str]:
    cfg = _load_toml(config_path or PROJECT_ROOT / "banks.toml")
    return sorted(cfg.get("banks", {}).keys())
