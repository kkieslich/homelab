"""Unit tests for the HKSAL balance normalization in fints_bridge.fetch.

Everything here is offline: we build mt940 model objects (and deliberately
malformed stand-ins) by hand, never touching a bank.
"""

from __future__ import annotations

import datetime as dt

import pytest
from mt940.models import Amount, Balance

from fints_bridge.camt052 import CamtBalance
from fints_bridge.fetch import _balance_to_dict, _do_fetch, _fetch_balance


class _FakeAmount:
    """Stand-in for mt940.models.Amount that does NOT pre-apply the C/D sign,
    so we can pin down behaviour under the opposite convention."""

    def __init__(self, amount, currency="EUR"):
        self.amount = amount
        self.currency = currency


class _FakeBalance:
    def __init__(self, status=None, amount=None, date=None):
        self.status = status
        self.amount = amount
        self.date = date


def test_credit_balance_is_positive():
    bal = Balance("C", "48.47", dt.date(2026, 7, 29))
    assert _balance_to_dict(bal) == {
        "type": "CLBD",
        "date": "2026-07-29",
        "amount_cents": 4847,
        "currency": "EUR",
    }


def test_debit_balance_is_negative():
    # mt940's Amount already negates on status 'D'; we must not negate again.
    bal = Balance("D", "1234.56", dt.date(2026, 7, 29))
    assert bal.amount.amount < 0, "mt940 pre-signs debit amounts"
    assert _balance_to_dict(bal)["amount_cents"] == -123456


def test_debit_balance_when_sign_not_pre_applied():
    # Defensive path: a positive figure carrying status 'D' gets signed by us.
    bal = _FakeBalance("D", _FakeAmount(1234.56), dt.date(2026, 7, 29))
    assert _balance_to_dict(bal)["amount_cents"] == -123456


def test_already_negative_debit_is_not_double_negated():
    bal = _FakeBalance("D", _FakeAmount(-1234.56), dt.date(2026, 7, 29))
    assert _balance_to_dict(bal)["amount_cents"] == -123456


def test_missing_date_yields_null_date():
    bal = Balance("C", "10.00", None)
    out = _balance_to_dict(bal)
    assert out["date"] is None
    assert out["amount_cents"] == 1000


def test_currency_falls_back_to_eur():
    bal = _FakeBalance("C", _FakeAmount(5.0, currency=None), dt.date(2026, 7, 29))
    assert _balance_to_dict(bal)["currency"] == "EUR"


def test_currency_is_preserved():
    bal = Balance("C", "5.00", dt.date(2026, 7, 29), currency="CHF")
    assert _balance_to_dict(bal)["currency"] == "CHF"


def test_rounding_matches_the_cent_idiom_used_elsewhere():
    # 0.1 + 0.2 style float noise must not shave a cent off.
    bal = _FakeBalance("C", _FakeAmount(0.615), dt.date(2026, 7, 29))
    assert _balance_to_dict(bal)["amount_cents"] in (61, 62)
    bal = _FakeBalance("C", _FakeAmount(19.99), dt.date(2026, 7, 29))
    assert _balance_to_dict(bal)["amount_cents"] == 1999


def test_zero_balance_is_emitted_not_dropped():
    bal = Balance("C", "0.00", dt.date(2026, 7, 29))
    assert _balance_to_dict(bal)["amount_cents"] == 0


@pytest.mark.parametrize(
    "bad",
    [
        None,
        _FakeBalance("C", None, dt.date(2026, 7, 29)),          # no amount
        _FakeBalance("C", _FakeAmount("not-a-number"), None),   # unparseable amount
        _FakeBalance("C", object(), None),                      # amount lacks .amount
        object(),                                               # not a Balance at all
    ],
)
def test_malformed_input_returns_none(bad):
    assert _balance_to_dict(bad) is None


def test_output_matches_the_camt_balance_contract_exactly():
    """The HKSAL dict must be key-for-key interchangeable with the camt one,
    since the importer reads both out of the same `balances` list."""
    hksal = _balance_to_dict(Balance("C", "48.47", dt.date(2026, 7, 29)))
    camt = CamtBalance(
        type="CLBD", date=dt.date(2026, 7, 29), amount_cents=4847, currency="EUR"
    ).to_dict()
    assert hksal == camt


# --- _fetch_balance: fail-soft wrapper -------------------------------------


class _FakeClient:
    def __init__(self, result=None, exc=None):
        self.result = result
        self.exc = exc
        self.calls = 0

    def get_balance(self, account):
        self.calls += 1
        if self.exc:
            raise self.exc
        return self.result


def test_fetch_balance_returns_single_element_list():
    client = _FakeClient(result=Balance("C", "48.47", dt.date(2026, 7, 29)))
    out = _fetch_balance(client, object(), enabled=True)
    assert out == [{"type": "CLBD", "date": "2026-07-29", "amount_cents": 4847, "currency": "EUR"}]


def test_fetch_balance_swallows_bank_errors():
    client = _FakeClient(exc=RuntimeError("HKSAL not supported"))
    assert _fetch_balance(client, object(), enabled=True) == []


def test_fetch_balance_swallows_unparseable_response():
    client = _FakeClient(result=object())
    assert _fetch_balance(client, object(), enabled=True) == []


def test_fetch_balance_disabled_skips_the_call_entirely():
    client = _FakeClient(result=Balance("C", "48.47", dt.date(2026, 7, 29)))
    assert _fetch_balance(client, object(), enabled=False) == []
    assert client.calls == 0, "--no-balance must not hit the bank"


def test_fetch_balance_logs_to_stderr_only(capsys):
    client = _FakeClient(result=Balance("C", "48.47", dt.date(2026, 7, 29)))
    _fetch_balance(client, object(), enabled=True)
    captured = capsys.readouterr()
    assert captured.out == "", "stdout carries the JSON payload and must stay clean"
    assert "balance: €48.47 as of 2026-07-29 (HKSAL)" in captured.err


def test_fetch_balance_failure_is_logged_to_stderr(capsys):
    client = _FakeClient(exc=RuntimeError("boom"))
    _fetch_balance(client, object(), enabled=True)
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "balance FAILED: RuntimeError('boom')" in captured.err


# --- _do_fetch: the MT940/HKKAZ branch must now carry balances --------------


class _FakeAccount:
    iban = "DE59TEST"
    accountnumber = "8001107152"


class _FakeProfile:
    key = "fnz"
    enumerate_accounts = True

    def account_type(self, *, iban, accountnumber):
        return "cash"


class _FakeMt940Client:
    """Minimal client covering just what the HKKAZ branch of _do_fetch touches."""

    def __init__(self, balance=None, balance_exc=None):
        self.balance = balance
        self.balance_exc = balance_exc

    def get_sepa_accounts(self):
        return [_FakeAccount()]

    def get_transactions(self, account, start_date, end_date):
        return []

    def get_balance(self, account):
        if self.balance_exc:
            raise self.balance_exc
        return self.balance


def _run_mt940_fetch(client, **kwargs):
    out: list[dict] = []
    failures = _do_fetch(
        client,
        _FakeProfile(),
        accounts_filter_iban=None,
        start=dt.date(2026, 6, 29),
        end=dt.date(2026, 7, 29),
        use_mt940=True,
        dump_xml=None,
        out_accounts=out,
        **kwargs,
    )
    return failures, out


def test_mt940_branch_emits_balances():
    client = _FakeMt940Client(balance=Balance("C", "48.47", dt.date(2026, 7, 29)))
    failures, out = _run_mt940_fetch(client)
    assert failures == 0
    assert out[0]["balances"] == [
        {"type": "CLBD", "date": "2026-07-29", "amount_cents": 4847, "currency": "EUR"}
    ]


def test_mt940_branch_emits_empty_balances_when_hksal_fails():
    """The whole point of the fail-soft contract: a refused HKSAL still yields a
    usable account, an empty balances list, and no account-level failure."""
    client = _FakeMt940Client(balance_exc=RuntimeError("HKSAL not supported"))
    failures, out = _run_mt940_fetch(client)
    assert failures == 0
    assert out[0]["balances"] == []
    assert "transactions" in out[0]


def test_mt940_branch_honours_with_balance_false():
    client = _FakeMt940Client(balance=Balance("C", "48.47", dt.date(2026, 7, 29)))
    _, out = _run_mt940_fetch(client, with_balance=False)
    assert out[0]["balances"] == []
