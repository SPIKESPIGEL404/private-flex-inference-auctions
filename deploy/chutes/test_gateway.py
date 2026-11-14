"""Controlled rejection and crypto checks; no external calls or GPU inference."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock

import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

spec = importlib.util.spec_from_file_location("chutes_gateway", Path(__file__).with_name("gateway.py"))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


class GatewayTests(unittest.TestCase):
    def test_real_mlkem_and_aead_roundtrip_rejects_modified_ciphertext(self):
        pk, sk = g.kem.keygen()
        body = {"model": g.NATIVE_MODEL, "stream": True}
        blob, response_sk = g.encrypt_request(base64.b64encode(pk).decode(), body)
        ct, nonce = blob[:1088], blob[1088:1100]
        secret = g.kem.decaps(sk, ct)
        key = g.derive(secret, ct, b"e2e-req-v1")
        raw = ChaCha20Poly1305(key).decrypt(nonce, blob[1100:], None)
        payload = json.loads(g.gzip.decompress(raw))
        self.assertEqual(payload["model"], body["model"])
        ct, secret = g.kem.encaps(base64.b64decode(payload["e2e_response_pk"]))
        key = g.derive(secret, ct, b"e2e-stream-v1")
        self.assertEqual(g.stream_key(response_sk, base64.b64encode(ct).decode()), key)
        encrypted = b"0" * 12 + ChaCha20Poly1305(key).encrypt(b"0" * 12, b"data: native frame", None)
        self.assertEqual(g.decrypt_chunk(key, base64.b64encode(encrypted).decode()), b"data: native frame")
        bad = encrypted[:-1] + bytes([encrypted[-1] ^ 1])
        with self.assertRaises(Exception): g.decrypt_chunk(key, base64.b64encode(bad).decode())

    def test_tdx_policy_rejects_wrong_key_nonce_debug_measurements_and_tcb(self):
        nonce, pk = "ab" * 32, "a-public-key"
        profile = {"name": "controlled", "mrtd": "01" * 48,
            "runtime_rtmrs": {f"RTMR{i}": f"0{i + 2}" * 48 for i in range(4)}}
        result = {"status": "UpToDate", "advisory_ids": [], "report": {"TD10": {
            "report_data": g.sha((nonce + pk).encode()) + "00" * 32, "td_attributes": "00" * 8,
            "mr_td": profile["mrtd"], **{f"rt_mr{i}": profile["runtime_rtmrs"][f"RTMR{i}"] for i in range(4)}}}}
        g.verify_tdx_result(result, nonce, pk, [profile])
        for n, p in [("00" * 32, pk), (nonce, "substituted-key")]:
            with self.assertRaises(g.VerificationError): g.verify_tdx_result(result, n, p, [profile])
        for key, value in [("td_attributes", "01" + "00" * 7), ("mr_td", "ff" * 48)]:
            bad = copy.deepcopy(result); bad["report"]["TD10"][key] = value
            with self.assertRaises(g.VerificationError): g.verify_tdx_result(bad, nonce, pk, [profile])
        for field, value in [("status", "OutOfDate"), ("advisory_ids", ["an-advisory"])]:
            bad = dict(result, **{field: value})
            with self.assertRaises(g.VerificationError): g.verify_tdx_result(bad, nonce, pk, [profile])

    def nras(self):
        key = ec.generate_private_key(ec.SECP384R1())
        jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
        jwk.update(kid="test-key", alg="ES384")
        now, nonce = int(time.time()), "ab" * 32
        base = {"iss": g.NRAS, "iat": now - 2, "nbf": now - 2, "exp": now + 300, "eat_nonce": nonce}
        def sign(value): return jwt.encode(value, key, algorithm="ES384", headers={"kid": "test-key"})
        device = sign(dict(base, ueid="controlled-device", secboot=True, dbgstat="disabled", measres="success",
            **{"x-nvidia-gpu-attestation-report-nonce-match": True}))
        overall = sign(dict(base, sub="NVIDIA-PLATFORM-ATTESTATION", submods={"gpu0": ["DIGEST", ["SHA-256", g.sha(device.encode())]]},
            **{"x-nvidia-overall-att-result": True}))
        return [["JWT", overall], {"gpu0": device}], {"keys": [jwk]}, nonce

    def test_nras_signature_nonce_and_detached_device_integrity(self):
        tokens, jwks, nonce = self.nras()
        self.assertEqual(g.verify_nras_tokens(tokens, jwks, nonce)["gpu_count"], 1)
        with self.assertRaises(Exception): g.verify_nras_tokens(tokens, jwks, "00" * 32)
        bad = copy.deepcopy(tokens); bad[1]["gpu0"] += "x"
        with self.assertRaises(Exception): g.verify_nras_tokens(bad, jwks, nonce)
        bad = copy.deepcopy(tokens)
        parts = bad[0][1].split(".")
        # Alter the signed claims without resigning them.
        parts[1] = base64.urlsafe_b64encode(b'{"x-nvidia-overall-att-result":true}').decode().rstrip("=")
        bad[0][1] = ".".join(parts)
        with self.assertRaises(Exception): g.verify_nras_tokens(bad, jwks, nonce)
        with self.assertRaises(Exception): g.verify_nras_tokens(tokens, {"keys": []}, nonce)
        with self.assertRaises(Exception): g.verify_nras_tokens(tokens, jwks, nonce, 2, 8)

    @staticmethod
    def frame(choices=None, usage=None, model=g.NATIVE_MODEL):
        return b"data: " + g.canonical({"model": model, "object": "chat.completion.chunk",
            "choices": choices or [], "usage": usage}) + b"\n\n"

    def test_only_authenticated_native_terminals_and_usage_complete_a_stream(self):
        terminal = self.frame([{"index": 0, "delta": {}, "finish_reason": "stop"}])
        usage = self.frame(usage={"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5})
        stream = g.NativeStream(64)
        stream.observe(terminal + usage); stream.complete()
        for raw in [terminal, usage, self.frame(usage={"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 6})]:
            with self.assertRaises(Exception):
                stream = g.NativeStream(64); stream.observe(raw); stream.complete()
        with self.assertRaises(Exception): g.NativeStream(64).observe(self.frame(model="a-different-model"))
        with self.assertRaises(Exception):
            stream = g.NativeStream(64); stream.observe(b"data: [DONE]\n\n" + terminal)

    def test_authenticated_continuous_usage_retains_final_counts_and_rejects_regression(self):
        def update(n):
            return self.frame([{"index": 0, "delta": {"content": "x"}, "finish_reason": None}],
                {"prompt_tokens": 2, "completion_tokens": n, "total_tokens": n + 2})
        stream = g.NativeStream(64)
        forwarded = stream.observe(update(0) + update(1) + update(3)
            + self.frame([{"index": 0, "delta": {}, "finish_reason": "stop"}],
                {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5})
            + self.frame(usage={"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}))
        stream.complete()
        self.assertEqual(stream.usage["completion_tokens"], 3)
        frames = [json.loads(line[5:]) for line in forwarded.splitlines() if line.startswith(b"data:")]
        self.assertTrue(all(f["usage"] is None for f in frames if f["choices"]))
        self.assertEqual(frames[-1]["usage"]["completion_tokens"], 3)
        with self.assertRaises(g.VerificationError):
            g.NativeStream(64).observe(update(3) + update(1))
        # Inline counters are suppressed for the Market; they cannot replace
        # the original provider's final empty-choice metering frame.
        with self.assertRaises(g.VerificationError):
            incomplete = g.NativeStream(64)
            incomplete.observe(self.frame([{"index": 0, "delta": {}, "finish_reason": "stop"}],
                {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}) + b"data: [DONE]\n\n")
            incomplete.complete()

    def test_policy_never_learns_measurements_from_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(json.dumps({"version": 1, "public_model": g.PUBLIC_MODEL,
                "native_model": g.NATIVE_MODEL, "chute_id": g.CHUTE_ID, "origin": g.ORIGIN,
                "approved_measurement_policy": False, "measurement_profiles": []}))
            with self.assertRaises(g.VerificationError): g.load_config(path)


class EncryptedUpstream:
    """An owned local provider fixture using real ML-KEM and AEAD."""
    def __init__(self):
        self.pk, self.sk = g.kem.keygen()
        self.calls = []

    def post(self, url, *, data, headers, allow_redirects):
        self.calls.append({"url": url, "ciphertext": data, "headers": headers})
        secret = g.kem.decaps(self.sk, data[:1088])
        key = g.derive(secret, data[:1088], b"e2e-req-v1")
        plain = ChaCha20Poly1305(key).decrypt(data[1088:1100], data[1100:], None)
        self.payload = json.loads(g.gzip.decompress(plain))
        ct, secret = g.kem.encaps(base64.b64decode(self.payload["e2e_response_pk"]))
        key = g.derive(secret, ct, b"e2e-stream-v1")
        frames = [GatewayTests.frame([{"index": 0, "delta": {"content": "controlled response"}, "finish_reason": None}]),
            GatewayTests.frame([{"index": 0, "delta": {}, "finish_reason": "stop"}]),
            GatewayTests.frame(usage={"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}), b"data: [DONE]\n\n"]
        events = [{"e2e_init": base64.b64encode(ct).decode()}]
        for index, frame in enumerate(frames):
            nonce = index.to_bytes(12, "big")
            blob = nonce + ChaCha20Poly1305(key).encrypt(nonce, frame.rstrip(b"\n"), None)
            events.append({"e2e": base64.b64encode(blob).decode()})
        lines = [b"data: " + g.canonical(e) + b"\n\n" for e in events]
        class Response:
            status = 200
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            @property
            def content(self):
                async def chunks():
                    for line in lines: yield line
                return chunks()
        return Response()


class GatewayHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.upstream = EncryptedUpstream()
        self.gateway = g.ChutesGateway({}, self.upstream, "test-provider-credential", "local-test-secret", self.directory.name)
        self.gateway.verify = AsyncMock(return_value=({"instance_id": "controlled-instance",
            "e2e_pubkey": base64.b64encode(self.upstream.pk).decode(), "nonces": ["one-use-token"]}, "a" * 64))
        app = web.Application(middlewares=[g.errors])
        app.router.add_post("/v1/chat/completions", self.gateway.chat)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.directory.cleanup()

    async def test_native_stream_uses_only_verified_instance_and_encrypted_invoke(self):
        body = {"model": g.NATIVE_MODEL, "messages": [{"role": "user", "content": "private fixture prompt"}],
            "stream": True, "stream_options": {"include_usage": True}, "max_completion_tokens": 64}
        response = await self.client.post("/v1/chat/completions", json=body, headers={"Authorization": "Bearer local-test-secret"})
        self.assertEqual(response.status, 200)
        raw = await response.read()
        self.assertIn(b"controlled response", raw)
        self.assertIn(b"data: [DONE]", raw)
        self.assertEqual(len(self.upstream.calls), 1)
        call = self.upstream.calls[0]
        self.assertNotIn(b"private fixture prompt", call["ciphertext"])
        self.assertEqual(call["headers"]["X-Instance-Id"], "controlled-instance")
        self.assertEqual(self.upstream.payload["messages"], body["messages"])
        self.assertEqual(response.headers["X-ACI-Upstream-Session"], "a" * 64)

    async def test_failed_attestation_never_invokes_the_provider(self):
        self.gateway.verify.side_effect = g.VerificationError("controlled proof failure")
        body = {"model": g.NATIVE_MODEL, "stream": True, "stream_options": {"include_usage": True}, "max_completion_tokens": 64}
        response = await self.client.post("/v1/chat/completions", json=body, headers={"Authorization": "Bearer local-test-secret"})
        self.assertEqual(response.status, 502)
        self.assertEqual(self.upstream.calls, [])
        response = await self.client.post("/v1/chat/completions", json=body)
        self.assertEqual(response.status, 401)
        self.assertEqual(self.upstream.calls, [])


if __name__ == "__main__": unittest.main()
