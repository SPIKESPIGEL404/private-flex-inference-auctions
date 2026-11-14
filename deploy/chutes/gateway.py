"""In-CVM native Chat transport: strict Chutes attestation followed by E2EE.

Listens only on IPv4 loopback; the Market is its only authenticated caller.
No plaintext forwarding, generated fallback, automatic invoke retry, or fake quote.
Raw prompts/responses are not logged. Measurements are LOCAL reviewed policy.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import gzip
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sys
import time
import uuid
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
import dcap_qvl
import jwt
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from pqcrypto.kem import ml_kem_768 as kem

PUBLIC_MODEL = "qwen3.8-27b"
NATIVE_MODEL = "Qwen/Qwen3.8-27B-FP8"
CHUTE_ID = "5f5b67f2-139e-5857-bdfb-94a30e03a526"
ORIGIN = "https://kelsen-qwen-qwen3-8-27b-fp8.chutes.ai"
API = "https://api.chutes.ai"
NRAS = "https://nras.attestation.nvidia.com"
MAX_BODY = 128 * 1024
MAX_EVIDENCE = 4 * 1024 * 1024
MAX_RESPONSE = 8 * 1024 * 1024
STREAM_STARTED = web.RequestKey("chutes_stream_started", bool)


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(value, limit=MAX_EVIDENCE):
    require(isinstance(value, str) and len(value) <= limit * 2, "invalid base64 field")
    raw = base64.b64decode(value, validate=True)
    require(len(raw) <= limit, "decoded field too large")
    return raw


def private_file(path):
    path = Path(path)
    require(path.is_file() and path.stat().st_mode & 0o077 == 0, "credential file must be private")
    value = path.read_text().strip()
    require(bool(value) and "\n" not in value and "\r" not in value, "invalid credential file")
    return value


def load_config(path):
    config = json.loads(Path(path).read_bytes())
    require(config.get("version") == 1 and config.get("public_model") == PUBLIC_MODEL
        and config.get("native_model") == NATIVE_MODEL and config.get("chute_id") == CHUTE_ID
        and config.get("origin") == ORIGIN, "configuration must pin this private Qwen deployment")
    require(config.get("approved_measurement_policy") is True, "measurement policy has not been reviewed")
    require(isinstance(config.get("measurement_profiles"), list) and config["measurement_profiles"],
        "an explicit local measurement allowlist is required")
    require(isinstance(config.get("chute_code_sha256"), str) and len(config["chute_code_sha256"]) == 64,
        "the reviewed Chute source digest is required")
    require(str(uuid.UUID(config["chute_version"])) == config["chute_version"], "invalid approved Chute version")
    require(config.get("chute_image") == "6e46a33c-329a-5b55-a1dd-c9a5c9866943"
        and config.get("model_revision") == "017b9c7af6b5689d5dd426a76e0bc077eb5ca20a",
        "unexpected deployment image or model revision")
    for profile in config["measurement_profiles"]:
        fields = [profile.get("mrtd")] + [profile.get("runtime_rtmrs", {}).get(f"RTMR{i}") for i in range(4)]
        require(all(isinstance(v, str) and len(v) == 96 and len(bytes.fromhex(v)) == 48 for v in fields),
            "invalid reviewed TDX measurement profile")
    require(1 <= config.get("min_gpu_count", 1) <= config.get("max_gpu_count", 8) <= 8,
        "invalid GPU evidence count policy")
    return config


def verify_tdx_result(result, nonce, public_key, profiles):
    require(result.get("status") == "UpToDate" and not result.get("advisory_ids"),
        "TDX TCB or advisory policy failed")
    td = result.get("report", {}).get("TD10")
    require(isinstance(td, dict), "only the reviewed TDX v4 report is accepted")
    attributes = bytes.fromhex(td["td_attributes"])
    require(len(attributes) == 8 and not int.from_bytes(attributes, "little") & 1, "TDX debug mode enabled")
    expected = sha((nonce + public_key).encode())
    require(bytes.fromhex(td["report_data"])[:32].hex() == expected, "nonce or E2EE key binding failed")
    matches = [p for p in profiles if p["mrtd"].lower() == td["mr_td"].lower()
        and all(p["runtime_rtmrs"][f"RTMR{i}"].lower() == td[f"rt_mr{i}"].lower() for i in range(4))]
    require(bool(matches), "unapproved Chutes runtime measurements")
    return expected, matches[0].get("name", "reviewed-profile")


def verify_nras_tokens(tokens, jwks, nonce, minimum=1, maximum=8):
    """Verify NVIDIA ES384 appraisal AND all detached GPU-token digests."""
    def claims(token):
        header = jwt.get_unverified_header(token)
        require(header.get("alg") == "ES384" and not header.get("crit"), "unexpected NVIDIA JWT algorithm")
        keys = [k for k in jwks["keys"] if k.get("kid") == header.get("kid")]
        require(len(keys) == 1 and keys[0].get("kty") == "EC" and keys[0].get("crv") == "P-384",
            "unknown NVIDIA signing key")
        value = jwt.decode(token, jwt.PyJWK.from_dict(keys[0]).key, algorithms=["ES384"], issuer=NRAS,
            options={"require": ["exp", "nbf", "iat", "iss"], "verify_aud": False}, leeway=0)
        require(value.get("eat_nonce") == nonce, "NVIDIA nonce mismatch")
        require(all(type(value[k]) is int for k in ("exp", "nbf", "iat"))
            and value["iat"] <= time.time() + 30 and value["exp"] > value["iat"], "invalid NVIDIA token time")
        return value
    require(isinstance(tokens, list) and len(tokens) == 2 and tokens[0][0] == "JWT"
        and isinstance(tokens[1], dict), "invalid NVIDIA appraisal")
    overall = claims(tokens[0][1])
    require(overall.get("sub") == "NVIDIA-PLATFORM-ATTESTATION"
        and overall.get("x-nvidia-overall-att-result") is True, "NVIDIA appraisal failed")
    devices = tokens[1]
    require(minimum <= len(devices) <= maximum and set(overall.get("submods", {})) == set(devices),
        "GPU device set does not match the signed appraisal")
    identities = set()
    for name, token in devices.items():
        require(overall["submods"][name] == ["DIGEST", ["SHA-256", sha(token.encode())]],
            "GPU detached-token digest mismatch")
        device = claims(token)
        require(device.get("secboot") is True and device.get("dbgstat") == "disabled"
            and device.get("measres") == "success"
            and device.get("x-nvidia-gpu-attestation-report-nonce-match") is True
            and device.get("x-nvidia-attestation-warning") is None, "GPU security policy failed")
        require(all(v is True for k, v in device.items() if k.startswith("x-nvidia-gpu-") and type(v) is bool),
            "GPU measurement check failed")
        identity = device.get("ueid")
        require(isinstance(identity, str) and identity and identity not in identities, "invalid or duplicate GPU identity")
        identities.add(identity)
    return {"gpu_count": len(devices), "expires_at": overall["exp"], "nras_jwt_verified": True}


def derive(secret, ciphertext, info):
    require(len(ciphertext) == kem.CIPHERTEXT_SIZE, "invalid ML-KEM ciphertext size")
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=ciphertext[:16], info=info).derive(secret)


def encrypt_request(public_key, body):
    pk = decode(public_key, 2048)
    require(len(pk) == kem.PUBLIC_KEY_SIZE, "invalid ML-KEM public key")
    response_pk, response_sk = kem.keygen()
    payload = dict(body, e2e_response_pk=base64.b64encode(response_pk).decode())
    ciphertext, secret = kem.encaps(pk)
    nonce = secrets.token_bytes(12)
    encrypted = ChaCha20Poly1305(derive(secret, ciphertext, b"e2e-req-v1")).encrypt(
        nonce, gzip.compress(canonical(payload)), None)
    return ciphertext + nonce + encrypted, response_sk


def stream_key(response_sk, encoded):
    ct = decode(encoded, 2048)
    return derive(kem.decaps(response_sk, ct), ct, b"e2e-stream-v1")


def decrypt_chunk(key, encoded):
    raw = decode(encoded, MAX_RESPONSE)
    require(len(raw) > 28, "encrypted stream chunk is too short")
    return ChaCha20Poly1305(key).decrypt(raw[:12], raw[12:], None)


class NativeStream:
    """Only encrypted native frames can establish usage and a terminal state."""
    def __init__(self, output_limit):
        self.output_limit, self.buffer, self.total = output_limit, b"", 0
        self.finish, self.usage, self.done = None, None, False
        self.final_usage = False

    def observe(self, raw):
        forwarded = bytearray()
        self.total += len(raw)
        require(self.total <= MAX_RESPONSE, "decrypted response exceeds limit")
        self.buffer += raw
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            if not line.startswith(b"data:"):
                continue
            value = line[5:].strip()
            require(not self.done, "native data after terminal marker")
            if value == b"[DONE]":
                self.done = True
                continue
            frame = json.loads(value)
            require(frame.get("model") == NATIVE_MODEL and frame.get("object") == "chat.completion.chunk"
                and "error" not in frame, "unexpected encrypted native model or protocol")
            for choice in frame.get("choices", []):
                require(choice.get("index") == 0, "multiple output choices are unsupported")
                if choice.get("finish_reason") is not None:
                    require(self.finish is None, "duplicate native terminal")
                    self.finish = choice["finish_reason"]
            if frame.get("usage") is not None:
                usage = frame["usage"]
                require(all(type(usage.get(k)) is int and usage[k] >= 0
                    for k in ("prompt_tokens", "completion_tokens", "total_tokens"))
                    and usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]
                    and usage["completion_tokens"] <= self.output_limit, "invalid native usage update")
                # Chutes/vLLM sends authenticated continuous usage, including
                # zero-output role frames. Retain its final cumulative count.
                if self.usage is not None:
                    require(usage["prompt_tokens"] == self.usage["prompt_tokens"]
                        and usage["completion_tokens"] >= self.usage["completion_tokens"],
                        "native cumulative usage regressed")
                self.usage = usage
                if not frame.get("choices"):
                    require(not self.final_usage, "duplicate final native usage")
                    self.final_usage = True
            # The Market's qualified OpenAI contract expects usage only in
            # the final empty-choice frame. Keep the authenticated final frame
            # unchanged; suppress only continuous counters on choice frames.
            if frame.get("choices") and frame.get("usage") is not None:
                frame = dict(frame, usage=None)
            forwarded.extend(b"data: " + canonical(frame) + b"\n\n")
        return bytes(forwarded)

    def complete(self):
        require(not self.buffer.strip() and self.finish in ("stop", "length") and self.final_usage and isinstance(self.usage, dict),
            "encrypted native terminal or usage is missing")
        usage = self.usage
        require(all(type(usage.get(k)) is int and usage[k] >= 0
            for k in ("prompt_tokens", "completion_tokens", "total_tokens")), "invalid native usage")
        require(usage["total_tokens"] == usage["prompt_tokens"] + usage["completion_tokens"]
            and usage["completion_tokens"] <= self.output_limit, "native usage contradicts output cap")
        require(self.finish != "length" or usage["completion_tokens"] == self.output_limit,
            "early output-cap termination")


class ChutesGateway:
    def __init__(self, config, client, key, local_secret, evidence_dir):
        self.config, self.client, self.key, self.local_secret = config, client, key, local_secret
        self.evidence_dir = Path(evidence_dir)
        self.evidence_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

    async def bounded_bytes(self, url, *, method="GET", body=None, authenticated=False):
        headers = {"Authorization": "Bearer " + self.key} if authenticated else {}
        async with self.client.request(method, url, json=body, headers=headers, allow_redirects=False) as response:
            require(response.status == 200, f"attestation HTTP {response.status} at {urlsplit(url).path}")
            raw = bytearray()
            async for chunk in response.content.iter_chunked(65536):
                raw.extend(chunk)
                require(len(raw) <= MAX_EVIDENCE, "attestation response exceeds limit")
            return bytes(raw)

    async def bounded_json(self, url, *, method="GET", body=None, authenticated=False):
        return json.loads(await self.bounded_bytes(url, method=method, body=body, authenticated=authenticated))

    async def verify(self):
        metadata = await self.bounded_json(f"{API}/chutes/{CHUTE_ID}", authenticated=True)
        require(metadata.get("chute_id") == CHUTE_ID and metadata.get("tee") is True
            and metadata.get("public") is False and metadata.get("disabled") is False
            and metadata.get("revision") == self.config["model_revision"],
            "private Chute identity or model revision changed")
        selector = metadata.get("node_selector", {})
        require(metadata.get("max_instances") == 1 and selector.get("gpu_count") == 1
            and set(selector.get("include") or []) <= {"pro_6000", "h200"}
            and selector.get("include"),
            "private Chute resource policy changed")
        image = metadata.get("image")
        require((image.get("image_id") if isinstance(image, dict) else image) == self.config["chute_image"],
            "Chute image changed")
        # The private control plane exposes version, not source, in this API.
        # The deployment preparer records the reviewed source and resulting version.
        require(metadata.get("version") == self.config["chute_version"], "Chute deployment version changed")
        source = await self.bounded_bytes(f"{API}/chutes/code/{CHUTE_ID}", authenticated=True)
        require(sha(source) == self.config["chute_code_sha256"], "Chute source changed")
        paths = {c.get("public_api_path") for c in metadata.get("cords", [])}
        require("/v1/chat/completions" in paths, "private Chute does not expose native Chat")
        discovery = await self.bounded_json(f"{API}/e2e/instances/{CHUTE_ID}", authenticated=True)
        started = time.monotonic()
        nonce = secrets.token_hex(32)
        evidence = await self.bounded_json(f"{API}/chutes/{CHUTE_ID}/evidence?nonce={nonce}", authenticated=True)
        instances = discovery.get("instances", [])
        require(bool(instances) and not evidence.get("failed_instance_ids"), "instance evidence is unavailable")
        reports = {e["instance_id"]: e for e in evidence.get("evidence", [])}
        require(len(reports) == len(evidence.get("evidence", [])), "duplicate instance evidence")
        verified = []
        for instance in instances:
            instance_id = instance["instance_id"]
            require(instance_id in reports and instance.get("nonces"), "discovered instance has no evidence or nonce")
            raw = reports[instance_id]
            quote = decode(raw["quote"])
            require(len(quote) >= 632 and quote[:2] == b"\x04\x00" and quote[4:8] == b"\x81\x00\x00\x00",
                "unsupported TDX quote layout")
            checked = await asyncio.wait_for(dcap_qvl.get_collateral_and_verify(quote), timeout=45)
            result = json.loads(checked.to_json())
            # Some bindings serialize advisories separately from the report.
            result["advisory_ids"] = list(checked.advisory_ids)
            expected, profile = verify_tdx_result(result, nonce, instance["e2e_pubkey"], self.config["measurement_profiles"])
            gpu_evidence = raw.get("gpu_evidence")
            require(isinstance(gpu_evidence, list) and gpu_evidence, "GPU evidence is required")
            appraisal = await self.bounded_json(NRAS + "/v3/attest/gpu", method="POST", body={
                "evidence_list": gpu_evidence, "nonce": expected, "arch": gpu_evidence[0]["arch"]})
            jwks = await self.bounded_json(NRAS + "/.well-known/jwks.json")
            gpu = verify_nras_tokens(appraisal, jwks, expected,
                self.config.get("min_gpu_count", 1), self.config.get("max_gpu_count", 8))
            require(gpu["gpu_count"] == len(gpu_evidence), "GPU evidence count mismatch")
            event = {"version": 1, "provider": "chutes", "public_model": PUBLIC_MODEL,
                "native_model": NATIVE_MODEL, "chute_id": CHUTE_ID, "instance_id": instance_id,
                "chute_version": metadata["version"], "chute_code_sha256": sha(source),
                "model_revision": self.config["model_revision"], "chute_image": self.config["chute_image"],
                "verified_at": int(time.time()), "nonce": nonce, "measurement_profile": profile,
                "e2ee_public_key_sha256": sha(decode(instance["e2e_pubkey"], 2048)),
                "tcb_status": "UpToDate", "gpu": gpu,
                "model_identity_source": "authenticated Chutes control-plane source/version/revision/image pins",
                "model_weights_hardware_proven": False, "cpu_gpu_session_topology_proven": False,
                "evidence": raw, "e2ee_public_key": instance["e2e_pubkey"], "nras_appraisal": appraisal}
            session_id = sha(canonical(event))
            path = self.evidence_dir / (session_id + ".json")
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as output:
                output.write(canonical(event)); output.flush(); os.fsync(output.fileno())
            verified.append((instance, session_id))
        require(verified, "no verified Chutes instance")
        require(0 < discovery.get("nonce_expires_in", 0) <= 75
            and time.monotonic() - started < min(discovery["nonce_expires_in"], 45) - 5,
            "invocation nonce expired during verification")
        return verified[0]

    async def chat(self, request):
        if not hmac.compare_digest(request.headers.get("Authorization", ""), "Bearer " + self.local_secret):
            raise web.HTTPUnauthorized()
        body = await request.json()
        require(body.get("model") == NATIVE_MODEL and body.get("stream") is True
            and body.get("n", 1) == 1 and body.get("stream_options", {}).get("include_usage") is True,
            "only the pinned streaming native Chat contract is supported")
        output_limit = body.get("max_completion_tokens")
        require(type(output_limit) is int and 1 <= output_limit <= 512, "invalid output token cap")
        instance, session_id = await self.verify()
        encrypted, response_sk = encrypt_request(instance["e2e_pubkey"], body)
        headers = {"Authorization": "Bearer " + self.key, "Content-Type": "application/octet-stream",
            "X-Chute-Id": CHUTE_ID, "X-Instance-Id": instance["instance_id"],
            "X-E2E-Nonce": instance["nonces"][0], "X-E2E-Stream": "true", "X-E2E-Path": "/v1/chat/completions"}
        # Exactly one invoke. A timeout/disconnect is not evidence of non-execution.
        async with self.client.post(API + "/e2e/invoke", data=encrypted, headers=headers, allow_redirects=False) as upstream:
            require(upstream.status == 200, f"encrypted invocation HTTP {upstream.status}")
            response = web.StreamResponse(headers={"Content-Type": "text/event-stream",
                "Cache-Control": "no-store", "X-ACI-Upstream-Session": session_id})
            await response.prepare(request)
            request[STREAM_STARTED] = True
            key, native, outer_done, total = None, NativeStream(output_limit), False, 0
            async for line in upstream.content:
                total += len(line)
                require(total <= MAX_RESPONSE * 2 and len(line) <= MAX_EVIDENCE, "encrypted response exceeds limit")
                if not line.startswith(b"data:"):
                    continue
                raw = line[5:].strip()
                require(not outer_done, "data after encrypted stream terminator")
                if raw == b"[DONE]":
                    outer_done = True
                    continue
                event = json.loads(raw)
                if "e2e_init" in event:
                    require(key is None, "duplicate encrypted stream initialization")
                    key = stream_key(response_sk, event["e2e_init"])
                elif "e2e" in event:
                    require(key is not None, "encrypted stream chunk before initialization")
                    plaintext = decrypt_chunk(key, event["e2e"]) + b"\n\n"
                    forwarded = native.observe(plaintext)
                    if forwarded:
                        await response.write(forwarded)
                elif "usage" in event and set(event) <= {"usage"}:
                    # Chutes' plaintext billing summary cannot establish native metering.
                    continue
                else:
                    raise VerificationError("unexpected unauthenticated stream event")
            # The live provider encrypts the native [DONE] marker and closes
            # HTTP without a second plaintext relay terminator.
            require(key is not None and (native.done or outer_done), "incomplete encrypted stream")
            native.complete()
            await response.write(b"data: [DONE]\n\n")
            await response.write_eof()
            return response

    async def session(self, request):
        session_id = request.match_info["session_id"]
        require(len(session_id) == 64 and all(c in "0123456789abcdef" for c in session_id), "invalid session id")
        path = self.evidence_dir / (session_id + ".json")
        if not path.exists():
            raise web.HTTPNotFound()
        return web.Response(body=path.read_bytes(), content_type="application/json", headers={"Cache-Control": "no-store"})


@web.middleware
async def errors(request, handler):
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception as error:
        # Only our fixed verification messages are logged, never provider
        # response bodies, plaintext prompts, request headers, or key material.
        print(json.dumps({"transport_failed": type(error).__name__,
            "reason": str(error) if isinstance(error, VerificationError) else "transport or decode failure"}), file=sys.stderr, flush=True)
        # If streaming has started, closing the connection leaves an incomplete
        # native stream. Never fabricate a trusted terminal or release Unknown.
        if request.get(STREAM_STARTED) and request.transport is not None:
            request.transport.close()
        return web.json_response({"error": {"code": "upstream_verification_or_transport_failed"}}, status=502)


async def serve(args):
    require(sha(Path(args.config).read_bytes()) == args.config_sha256, "provider policy differs from the approved release")
    config = load_config(args.config)
    key = private_file(config["key_file"])
    secret = private_file(config["local_secret_file"])
    require(args.host == "127.0.0.1" and 1 <= args.port <= 65535, "bridge must listen on IPv4 loopback")
    timeout = aiohttp.ClientTimeout(total=120, connect=15, sock_read=90)
    async with aiohttp.ClientSession(timeout=timeout, trust_env=False, read_bufsize=MAX_EVIDENCE) as client:
        gateway = ChutesGateway(config, client, key, secret, config["evidence_directory"])
        if args.verify_only:
            instance, session_id = await gateway.verify()
            print(json.dumps({"provider_preflight_verified": True, "provider": "chutes", "model": PUBLIC_MODEL,
                "instance_id": instance["instance_id"], "session_id": session_id, "inference_calls": 0,
                "model_weights_hardware_proven": False, "cpu_gpu_session_topology_proven": False}))
            return
        app = web.Application(client_max_size=MAX_BODY, middlewares=[errors])
        app.router.add_post("/v1/chat/completions", gateway.chat)
        app.router.add_get("/v1/aci/sessions/{session_id}", gateway.session)
        async def health(request):
            return web.json_response({"ready": True, "model": PUBLIC_MODEL, "verification_required": True})
        app.router.add_get("/healthz", health)
        async def warm_private_chute():
            while True:
                try:
                    await gateway.bounded_json(f"{API}/chutes/warmup/{CHUTE_ID}?quick=true", authenticated=True)
                except Exception:
                    print('{"private_chute_warmup":"temporarily_unavailable"}', file=sys.stderr, flush=True)
                await asyncio.sleep(60)
        warmer = asyncio.create_task(warm_private_chute())
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, args.host, args.port).start()
        try:
            await asyncio.Event().wait()
        finally:
            warmer.cancel()
            await asyncio.gather(warmer, return_exceptions=True)
            await runner.cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8091)
    args = parser.parse_args()
    os.umask(0o077)
    asyncio.run(serve(args))


if __name__ == "__main__":
    main()
