"""
Minimal camt.052 (Bank-to-Customer Account Report) parser.

UmweltBank returns transactions in `camt.052.001.08` for the credit-card
account via HKCAZ. We parse only the fields we need for Actual Budget import:
date, amount (signed), currency, counterparty name, free-text purpose, and a
stable unique reference for deduplication.

Spec: ISO 20022 camt.052.001.08 — relevant elements live under
  Document/BkToCstmrAcctRpt/Rpt/Ntry
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Iterable

from lxml import etree


# camt schemas use a versioned namespace. Match any 052.001.x to be safe.
_NS_PATTERN = "urn:iso:std:iso:20022:tech:xsd:camt.052.001."


@dataclass(frozen=True, slots=True)
class CamtBalance:
    """A single <Bal> entry. `type` is the balance type code:
    OPBD = opening booked, CLBD = closing booked, PRCD = previously closed,
    OPAV/CLAV = opening/closing available."""
    type: str
    date: dt.date | None
    amount_cents: int  # signed: DBIT (e.g. credit-card debt) = negative
    currency: str

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "date": self.date.isoformat() if self.date else None,
            "amount_cents": self.amount_cents,
            "currency": self.currency,
        }


@dataclass(frozen=True, slots=True)
class CamtTransaction:
    booking_date: dt.date | None
    value_date: dt.date | None
    amount_cents: int  # signed: negative = debit (money out), positive = credit
    currency: str
    status: str  # BOOK / PDNG / INFO
    counterparty: str | None
    purpose: str | None
    end_to_end_id: str | None
    account_servicer_ref: str | None
    raw_id: str  # stable id for dedup, falls back through {acct_svcr_ref, end_to_end_id, hash}
    reference_quality: str  # "bank" (acct_svcr_ref/end_to_end_id) or "synthetic" (hashed fallback)

    def to_dict(self) -> dict:
        return {
            "imported_id": self.raw_id,
            "reference_quality": self.reference_quality,
            "date": self.booking_date.isoformat() if self.booking_date else None,
            "value_date": self.value_date.isoformat() if self.value_date else None,
            "amount_cents": self.amount_cents,
            "currency": self.currency,
            "status": self.status,
            "payee_name": self.counterparty,
            "notes": self.purpose,
            "end_to_end_id": self.end_to_end_id,
            "account_servicer_ref": self.account_servicer_ref,
        }


def _detect_namespace(root: etree._Element) -> str:
    tag = root.tag
    if tag.startswith("{"):
        return tag[1 : tag.index("}")]
    return ""


def _findtext(elem, ns: str, path: str) -> str | None:
    """`path` uses simple slash notation, e.g. 'BookgDt/Dt'."""
    parts = path.split("/")
    qpath = "/".join(f"{{{ns}}}{p}" for p in parts)
    found = elem.find(qpath)
    return found.text if found is not None else None


def _parse_date(s: str | None) -> dt.date | None:
    if not s:
        return None
    try:
        return dt.date.fromisoformat(s[:10])
    except ValueError:
        return None


def parse_camt052(xml_bytes: bytes) -> list[CamtTransaction]:
    """Parse one camt.052.001.x document and return its transaction entries."""
    root = etree.fromstring(xml_bytes)
    ns = _detect_namespace(root)
    if not ns.startswith(_NS_PATTERN):
        # Unknown variant — try to keep going but warn.
        return []

    entries = root.iter(f"{{{ns}}}Ntry")
    return [_parse_entry(ntry, ns) for ntry in entries]


def _parse_entry(ntry: etree._Element, ns: str) -> CamtTransaction:
    amt_elem = ntry.find(f"{{{ns}}}Amt")
    amount_str = (amt_elem.text or "0").replace(",", ".") if amt_elem is not None else "0"
    currency = amt_elem.get("Ccy", "EUR") if amt_elem is not None else "EUR"
    amount_cents = round(float(amount_str) * 100)

    cd_dt = _findtext(ntry, ns, "CdtDbtInd")
    if cd_dt == "DBIT":
        amount_cents = -amount_cents

    status = _findtext(ntry, ns, "Sts/Cd") or _findtext(ntry, ns, "Sts") or "BOOK"

    booking_date = _parse_date(_findtext(ntry, ns, "BookgDt/Dt"))
    value_date = _parse_date(_findtext(ntry, ns, "ValDt/Dt"))

    acct_svcr_ref = _findtext(ntry, ns, "AcctSvcrRef")

    # NtryDtls/TxDtls — there can be multiple TxDtls per Ntry; we take the first
    # because Actual import deals one row at a time and the Ntry-level Amt is the
    # canonical money movement.
    tx = ntry.find(f"{{{ns}}}NtryDtls/{{{ns}}}TxDtls")
    end_to_end_id = None
    counterparty = None
    purpose = None
    if tx is not None:
        end_to_end_id = _findtext(tx, ns, "Refs/EndToEndId")
        if cd_dt == "DBIT":
            counterparty = _findtext(tx, ns, "RltdPties/Cdtr/Nm") or _findtext(tx, ns, "RltdPties/Cdtr/Pty/Nm")
        else:
            counterparty = _findtext(tx, ns, "RltdPties/Dbtr/Nm") or _findtext(tx, ns, "RltdPties/Dbtr/Pty/Nm")
        purpose = _findtext(tx, ns, "RmtInf/Ustrd")
        if purpose is None:
            # Multiple Ustrd children possible; concatenate all.
            ustrd = tx.findall(f"{{{ns}}}RmtInf/{{{ns}}}Ustrd")
            if ustrd:
                purpose = " ".join((u.text or "").strip() for u in ustrd if u.text)

    bank_ref = acct_svcr_ref or end_to_end_id
    raw_id = bank_ref or _synthetic_id(
        booking_date, amount_cents, counterparty, purpose
    )

    return CamtTransaction(
        booking_date=booking_date,
        value_date=value_date,
        amount_cents=amount_cents,
        currency=currency,
        status=status,
        counterparty=counterparty,
        purpose=purpose,
        end_to_end_id=end_to_end_id,
        account_servicer_ref=acct_svcr_ref,
        raw_id=raw_id,
        reference_quality="bank" if bank_ref else "synthetic",
    )


def _synthetic_id(date: dt.date | None, amount_cents: int, payee: str | None, purpose: str | None) -> str:
    import hashlib
    h = hashlib.sha256()
    h.update(f"{date or ''}|{amount_cents}|{payee or ''}|{purpose or ''}".encode())
    return f"syn_{h.hexdigest()[:24]}"


def parse_many(xml_blobs: Iterable[bytes]) -> list[CamtTransaction]:
    out: list[CamtTransaction] = []
    for blob in xml_blobs:
        out.extend(parse_camt052(blob))
    return out


def parse_balances(xml_bytes: bytes) -> list[CamtBalance]:
    """Parse one camt.052.001.x document and return its <Bal> entries."""
    root = etree.fromstring(xml_bytes)
    ns = _detect_namespace(root)
    if not ns.startswith(_NS_PATTERN):
        return []
    out: list[CamtBalance] = []
    for bal in root.iter(f"{{{ns}}}Bal"):
        bal_type = (
            _findtext(bal, ns, "Tp/CdOrPrtry/Cd")
            or _findtext(bal, ns, "Tp/CdOrPrtry/Prtry")
            or "?"
        )
        amt_elem = bal.find(f"{{{ns}}}Amt")
        amount_str = (amt_elem.text or "0").replace(",", ".") if amt_elem is not None else "0"
        currency = amt_elem.get("Ccy", "EUR") if amt_elem is not None else "EUR"
        amount_cents = round(float(amount_str) * 100)
        if _findtext(bal, ns, "CdtDbtInd") == "DBIT":
            amount_cents = -amount_cents
        date = _parse_date(_findtext(bal, ns, "Dt/Dt") or _findtext(bal, ns, "Dt/DtTm"))
        out.append(CamtBalance(type=bal_type, date=date, amount_cents=amount_cents, currency=currency))
    return out


def parse_balances_many(xml_blobs: Iterable[bytes]) -> list[CamtBalance]:
    out: list[CamtBalance] = []
    for blob in xml_blobs:
        out.extend(parse_balances(blob))
    return out
