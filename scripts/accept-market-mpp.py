#!/usr/bin/env python3
"""Controlled MPP core wire + actual PG/Redis + existing native Market.

The offline Ed25519 fixture signs test receipts. It moves no real money and
does not implement NEAR Agent API receipt verification or automatic admission.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit

from market_b_support import CommitProxy, Market, Seller, run, wait_for

HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))
DOMAIN = b"bitrouter:mpp-test-receipt:v1\n"


def request(m, path, body=None, key=None, buyer=0, payment=None, method=None, anonymous=False):
    headers = {}
    if not anonymous:
        headers["Authorization"] = "Bearer " + m.buyers[buyer]["token"]
    if body is not None:
        headers["Content-Type"] = "application/json"
    if key:
        headers["Idempotency-Key"] = key
    if payment:
        headers["Payment-Authorization"] = payment
    req = urllib.request.Request(m.url + path, headers=headers, method=method,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        response = HTTP.open(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read().decode()
        return response.status, json.loads(raw) if raw.startswith("{") else raw, response.headers


def keypair(root):
    raw = subprocess.check_output(["node", "-e", """
const c = require('node:crypto');
const {publicKey, privateKey} = c.generateKeyPairSync('ed25519');
process.stdout.write(JSON.stringify({
  public: publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex'),
  private: privateKey.export({type:'pkcs8',format:'pem'})
}));
"""])
    keys = json.loads(raw)
    private = root / "fixture-only-key.pem"
    private.touch(mode=0o600)
    private.write_text(keys["private"])
    return keys["public"], private


def credential(intent, private, payment_id=None, **changes):
    receipt = {"payment_id": payment_id or str(uuid.uuid4()), "funding_id": intent["id"],
               "reference": intent["id"], "recipient": "controlled-merchant", "currency": "test:USD6",
               "amount": intent["amount_micro_usd"], "settled_at_ms": int(time.time() * 1000)}
    receipt.update(changes)
    signature = subprocess.check_output(["node", "-e", """
const c=require('node:crypto'),fs=require('node:fs');
process.stdout.write(c.sign(null,fs.readFileSync(0),fs.readFileSync(process.argv[1])).toString('hex'));
""", str(private)], input=DOMAIN + json.dumps(receipt, separators=(",", ":")).encode()).decode()
    value = {"challenge": intent["challenge"], "payload": {"receipt": receipt, "signature": signature}}
    return "Payment " + base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")


def decoded(payment):
    raw = payment.removeprefix("Payment ")
    return json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))


def encoded(value):
    return "Payment " + base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def controlled(binary):
    with Market(binary, initialize=False) as m:
        public, private = keypair(m.root)
        m.env.update(PRIVATE_MARKET_MPP_TEST_API="1", PRIVATE_MARKET_MPP_TEST_PUBLIC_KEY=public)
        initialized = json.loads(run(binary, "init", str(m.state), env=m.env))
        assert initialized["test_credit_micro_usd"] == 0
        m.data = json.loads((m.state / "state.json").read_text())
        m.buyers = m.data["buyers"]
        address = m.data["fixture_addr"].split(":")
        m.seller = Seller((address[0], int(address[1])), m.env["PRIVATE_MARKET_SELLER_KEY"])
        m.start()
        funding_path = "/market/v1/funding-intents"
        bids_path = "/market/v1/procurement-intents"

        assert request(m, funding_path, {"amount_micro_usd": "10000"}, "anonymous", anonymous=True)[0] == 401
        assert m.sql("SELECT count(*) FROM credit_ledger_entries") == "0"
        for amount in ("0", "01", "-1", "1.5", "10000001", 100):
            assert request(m, funding_path, {"amount_micro_usd": amount}, "invalid")[0] == 422
        status, intent, _ = request(m, funding_path, {"amount_micro_usd": "10000"}, "fund-once")
        assert status == 201 and intent["status"] == "unpaid" and intent["real_payment"] is False
        assert request(m, funding_path, {"amount_micro_usd": "10000"}, "fund-once")[1] == intent
        assert request(m, funding_path, {"amount_micro_usd": "10001"}, "fund-once")[0] == 409
        pay = funding_path + "/" + intent["id"] + "/pay"
        assert request(m, funding_path + "/" + intent["id"], buyer=1)[0] == 404
        assert request(m, pay, {}, buyer=1)[0] == 404
        status, _, headers = request(m, pay, {})
        assert status == 402 and 'method="bitrouter-test"' in headers["WWW-Authenticate"]
        assert 'header="Payment-Authorization"' in headers["WWW-Authenticate"]
        proof = credential(intent, private)
        forged = decoded(proof)
        forged["payload"]["signature"] = "00" * 64
        assert request(m, pay, {}, payment=encoded(forged))[0] == 401
        tampered = decoded(proof)
        tampered["challenge"]["request"] = "e30"
        assert request(m, pay, {}, payment=encoded(tampered))[0] == 409
        assert m.balance() == 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: request(m, pay, {}, payment=proof), range(8)))
        assert all(result[0] == 200 and result[1]["status"] == "credited" for result in results), results
        assert len({result[2]["Payment-Receipt"] for result in results}) == 1
        original_receipt = results[0][2]["Payment-Receipt"]
        assert request(m, pay, {})[0] == 200, "paid resource must not ask for another payment"
        assert m.balance() == 10000
        assert m.sql("SELECT count(*) FROM controlled_mpp_payments") == "1"
        assert m.sql("SELECT count(*) FROM credit_ledger_entries WHERE entry_type='purchase'") == "1"
        assert m.sql("SELECT count(*) FROM redis_balance_mutations WHERE state<>'applied'") == "0"

        other = request(m, funding_path, {"amount_micro_usd": "10000"}, "other", buyer=1)[1]
        same_money = credential(other, private, payment_id=decoded(proof)["payload"]["receipt"]["payment_id"])
        assert request(m, funding_path + "/" + other["id"] + "/pay", {}, buyer=1, payment=same_money)[0] == 409
        assert m.balance(1) == 0

        native = m.body()
        del native["bitrouter_purchase"]
        del native["bitrouter_delivery"]
        native.pop("background", None)
        spec = {"native_request": native, "initial_provider_cap_micro_usd": "50",
                "hard_provider_cap_micro_usd": "5000", "hard_total_cap_nano_usd": "5010000",
                "step_micro_usd": "100", "interval_ms": 100, "deadline_ms": int(time.time()*1000)+60000}
        status, bid, _ = request(m, bids_path, spec, "bid-once")
        assert status == 201 and bid["admission_enabled"] is False and bid["provider_dispatched"] is False, (status, bid)
        assert request(m, bids_path, spec, "bid-once")[1] == bid
        path = bids_path + "/" + bid["id"]
        assert request(m, path, buyer=1)[0] == 404
        with ThreadPoolExecutor(max_workers=2) as pool:
            revisions = list(pool.map(lambda n: request(m, path + "/bid", {"expected_revision": 0, "provider_cap_micro_usd": str(n)}, "revise-"+str(n), method="PATCH"), (400, 500)))
        assert sorted(result[0] for result in revisions) == [200, 409], revisions
        winner = next(result[1] for result in revisions if result[0] == 200)
        assert winner["revision"] == 1 and winner["manual_override"] is True
        winner_cap = winner["provider_cap_micro_usd"]
        assert request(m, path + "/bid", {"expected_revision": 0, "provider_cap_micro_usd": winner_cap}, "revise-"+winner_cap, method="PATCH")[1] == winner
        assert request(m, path + "/bid", {"expected_revision": 1, "provider_cap_micro_usd": "5001"}, "too-high", method="PATCH")[0] == 422
        unchanged = request(m, path + "/tick", {"expected_revision": 1}, "manual-tick")[1]
        assert unchanged["provider_cap_micro_usd"] == winner_cap and unchanged["revision"] == 1
        assert m.sql("SELECT count(*) FROM controlled_procurement_revisions") == "2"
        assert m.effects() == 0 and len(m.seller.calls) == 0, "bid metadata cannot dispatch"

        auto = request(m, bids_path, spec, "scheduled-bid")[1]
        auto_path = bids_path + "/" + auto["id"]
        time.sleep(0.12)
        advanced = request(m, auto_path + "/tick", {"expected_revision": 0}, "tick-1")[1]
        assert int(advanced["provider_cap_micro_usd"]) > 50 and advanced["revision"] == 1
        expired_spec = copy.deepcopy(spec)
        expired_spec["deadline_ms"] = int(time.time()*1000) + 500
        expired = request(m, bids_path, expired_spec, "expires")[1]
        time.sleep(0.6)
        assert request(m, bids_path + "/" + expired["id"] + "/tick", {"expected_revision": 0}, "expire-tick")[1]["status"] == "expired"
        assert request(m, bids_path, expired_spec, "expires")[0] == 200, "expired create replay remains idempotent"

        for index in range(2):
            key = "funded-native-" + str(index)
            assert m.post(key)[0] == 200
            final = wait_for(lambda: (value if (value := m.receipt(key)) and value.get("financial") else None))
            assert final["financial"]["provider_micro_usd"] == 35
            assert m.post(key)[0] == 200
        assert m.effects() == 2 and len(m.seller.calls) == 2
        funds = request(m, "/market/v1/funds")[1]
        assert funds["conserved"] and funds["cash_projection_ready"]
        assert int(funds["funded_micro_usd"]) == 10000 and int(funds["charged_micro_usd"]) > 0
        assert int(funds["cash_balance_micro_usd"]) == m.balance()

        m.stop(crash=True)
        alternate = m.root / "alternate"
        alternate.mkdir(mode=0o700)
        alternate_public, _ = keypair(alternate)
        m.env["PRIVATE_MARKET_MPP_TEST_PUBLIC_KEY"] = alternate_public
        changed = subprocess.run([binary, "serve", str(m.state)], env=m.env, capture_output=True, timeout=20)
        assert changed.returncode != 0, "restarting cannot replace the trusted payment authority"
        assert b"test payment authority changed" in changed.stderr
        m.env["PRIVATE_MARKET_MPP_TEST_PUBLIC_KEY"] = public
        m.start()
        assert request(m, pay, {}, payment=proof)[2]["Payment-Receipt"] == original_receipt
        assert request(m, path)[1]["provider_cap_micro_usd"] == winner_cap
        continued = request(m, auto_path + "/tick", {"expected_revision": 1}, "tick-2")[1]
        assert continued["started_at_ms"] == auto["started_at_ms"]
        assert int(continued["provider_cap_micro_usd"]) >= int(advanced["provider_cap_micro_usd"])
        assert request(m, path + "/cancel", {"expected_revision": 1}, "cancel")[1]["status"] == "cancelled"
        assert request(m, path + "/bid", {"expected_revision": 2, "provider_cap_micro_usd": "600"}, "after-cancel", method="PATCH")[0] == 409
        assert m.effects() == 2 and len(m.seller.calls) == 2
        assert request(m, "/market/v1/funds")[1] == funds
        return {"funding_entries": 1, "controlled_native_calls": 2, "balance_micro_usd": m.balance(), "cash_conserved": True}


def lost_funding_commit(binary):
    with Market(binary, initialize=False) as m:
        public, private = keypair(m.root)
        m.env.update(PRIVATE_MARKET_MPP_TEST_API="1", PRIVATE_MARKET_MPP_TEST_PUBLIC_KEY=public)
        run(binary, "init", str(m.state), env=m.env)
        m.data = json.loads((m.state / "state.json").read_text())
        m.buyers = m.data["buyers"]
        address = m.data["fixture_addr"].split(":")
        m.seller = Seller((address[0], int(address[1])), m.env["PRIVATE_MARKET_SELLER_KEY"])
        m.proxy = CommitProxy(("127.0.0.1", urlsplit(m.direct).port), financial_marker=b"UPDATE controlled_mpp_funding SET payment_id=")
        m.env["DATABASE_URL"] = m.direct.replace(str(urlsplit(m.direct).port), str(m.proxy.server_address[1]))
        m.data["database"] = m.env["DATABASE_URL"]
        (m.state / "state.json").write_text(json.dumps(m.data))
        m.start()
        intent = request(m, "/market/v1/funding-intents", {"amount_micro_usd": "1000"}, "commit-unknown")[1]
        proof = credential(intent, private)
        pay = "/market/v1/funding-intents/" + intent["id"] + "/pay"
        m.proxy.armed.set()
        assert request(m, pay, {}, payment=proof)[0] == 503
        assert m.proxy.fired.wait(5), "test must actually lose the PostgreSQL COMMIT acknowledgment"
        assert m.balance() == 1000
        assert request(m, pay, {}, payment=proof)[0] == 200
        assert m.sql("SELECT count(*) FROM credit_ledger_entries WHERE entry_type='purchase'") == "1"
        assert m.sql("SELECT count(*) FROM controlled_mpp_payments") == "1"
        assert request(m, "/market/v1/funds")[1]["conserved"]
        assert m.effects() == 0 and not m.seller.calls


def defaults_off(binary):
    with Market(binary) as m:
        m.start()
        assert request(m, "/market/v1/funds")[0] == 404
        assert request(m, "/market/v1/funding-intents", {"amount_micro_usd": "100"}, "disabled")[0] == 404


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    binary = str(args.binary.resolve())
    result = controlled(binary)
    lost_funding_commit(binary)
    defaults_off(binary)
    evidence = {"result": "pass", "mode": "controlled-test-only", "real_payment": False,
                "real_provider": False, "external_spend": 0, "automatic_admission": False,
                "mpp_core_version": "0.20.0", **result,
                "checks": ["zero-bootstrap", "default-disabled", "buyer-isolation", "402-payment-authorization",
                           "signed-test-proof", "challenge-binding", "concurrent-payment-replay", "underlying-payment-dedup",
                           "original-cash-ledger-and-outbox", "one-funding-multiple-native-purchases", "bid-cas",
                           "bid-operation-replay", "hard-cap", "manual-override", "absolute-schedule",
                           "deadline", "cancel", "restart-without-refill", "authority-pinned",
                           "lost-funding-commit-ack", "no-bid-dispatch"]}
    if args.evidence:
        args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
