"""A barren fetch must never overwrite a payload that still holds data.

A resumed-but-dead FinTS session answers with an empty result for every account
and no error. Writing that out destroys the last known-good payload and leaves
the importer to reject it after the good copy is already gone.
"""

from __future__ import annotations

import json

import pytest

from fints_bridge.daemon import _payload_is_barren, _do_full_fetch


def payload(*accounts):
    return {"fetched_at": "2026-07-29T19:23:01Z", "banks": [{"accounts": list(accounts)}]}


def test_all_accounts_empty_is_barren():
    assert _payload_is_barren(payload({"transactions": [], "holdings": [], "balances": []},
                                      {"transactions": [], "holdings": []})) is True


def test_missing_keys_are_barren():
    assert _payload_is_barren(payload({}, {})) is True
    assert _payload_is_barren({"banks": []}) is True


def test_one_quiet_account_is_not_barren():
    # A Verrechnungskonto can genuinely be silent for months; the depot's
    # holdings still prove the session was alive.
    assert _payload_is_barren(payload({"transactions": [], "balances": []},
                                      {"holdings": [{"isin": "X"}]})) is False


def test_balances_alone_prove_liveness():
    assert _payload_is_barren(payload({"transactions": [], "balances": [{"type": "CLBD"}]})) is False


class _Profile:
    key, display_name, blz, enumerate_accounts, prefer_mt940 = 'fnz', 'Bank', '700', False, True
    accounts: list = []


def _stub_fetch(monkeypatch, accounts):
    def fake(client, profile, *, accounts_filter_iban, start, end, use_mt940, dump_xml, out_accounts, **kw):
        out_accounts.extend(accounts)
        return 0
    monkeypatch.setattr('fints_bridge.daemon._do_fetch', fake)


def test_barren_fetch_refuses_to_clobber_good_payload(tmp_path, monkeypatch):
    out = tmp_path / 'fnz-fetch.json'
    good = payload({'transactions': [{'imported_id': 'a'}]}, {'holdings': [{'isin': 'X'}]})
    out.write_text(json.dumps(good), encoding='utf-8')
    _stub_fetch(monkeypatch, [{'transactions': [], 'holdings': [], 'balances': []}])

    with pytest.raises(RuntimeError, match='refusing to overwrite'):
        _do_full_fetch(object(), _Profile(), 90, True, out)

    assert json.loads(out.read_text(encoding='utf-8')) == good, 'good payload must survive'


def test_barren_fetch_is_allowed_when_nothing_to_lose(tmp_path, monkeypatch):
    # First ever run, or the previous payload was itself barren: writing is fine.
    out = tmp_path / 'fnz-fetch.json'
    _stub_fetch(monkeypatch, [{'transactions': [], 'holdings': []}])
    result = _do_full_fetch(object(), _Profile(), 90, True, out)
    assert out.exists() and _payload_is_barren(result)


def test_non_barren_fetch_overwrites_normally(tmp_path, monkeypatch):
    out = tmp_path / 'fnz-fetch.json'
    out.write_text(json.dumps(payload({'transactions': [{'imported_id': 'old'}]})), encoding='utf-8')
    _stub_fetch(monkeypatch, [{'transactions': [{'imported_id': 'new'}], 'holdings': []}])
    _do_full_fetch(object(), _Profile(), 90, True, out)
    written = json.loads(out.read_text(encoding='utf-8'))
    assert written['banks'][0]['accounts'][0]['transactions'][0]['imported_id'] == 'new'
