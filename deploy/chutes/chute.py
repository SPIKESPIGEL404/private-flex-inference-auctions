"""Private single-instance vLLM front door for scheduler acceptance.

No auction or settlement. Native inference Cords are removed so every generation
uses an epoch-bound, one-shot scheduler submission. vLLM itself is unmodified.
"""
import hashlib
import importlib.metadata
import json
import threading
import time
import uuid

import aiohttp
from fastapi import HTTPException
from fastapi.responses import Response
from chutes.chute import NodeSelector
from chutes.chute.template.vllm import build_vllm_chute

USERNAME = "kelsen"
MODEL = "Qwen/Qwen3.8-27B-FP8"
REVISION = "017b9c7af6b5689d5dd426a76e0bc077eb5ca20a"
IMAGE = "6e46a33c-329a-5b55-a1dd-c9a5c9866943"
ADAPTER_VERSION = "flex-vllm-frontdoor-v1"
RELEASE = "phase4-4"
ENGINE_ARGS = (
    "--tensor-parallel-size 1 --max-model-len 32768 --max-num-seqs 8 "
    "--gpu-memory-utilization 0.90 --kv-cache-dtype fp8 --language-model-only "
    "--generation-config vllm --enable-prefix-caching "
    "--prefix-caching-hash-algo sha256"
)
MAX_PROMPT = 8192
MAX_OUTPUT = 512
MAX_SEEN = 1024


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def digest(domain, value):
    return hashlib.sha256(domain.encode() + b"\0" + canonical(value)).hexdigest()


def envelope(payload):
    if isinstance(payload, dict) and set(payload) == {"json", "params"}:
        payload = payload["json"]
    if not isinstance(payload, dict):
        raise HTTPException(400, "JSON object required")
    payload = dict(payload)
    # The existing standard-template classification is immutable on update.
    # Its gateway injects model on every Cord, including control requests.
    if "model" in payload:
        if payload.pop("model") != MODEL:
            raise HTTPException(400, "Unexpected platform model envelope")
    return payload


def completion_body(request):
    sampling = request["sampling_config"]
    return {
        "model": MODEL, "prompt": request["prompt_token_ids"], "request_id": request["execution_id"],
        "max_tokens": request["max_output_tokens"], "n": 1, "stream": True,
        "stream_options": {"include_usage": True, "continuous_usage_stats": False},
        "return_token_ids": True, "echo": False, "add_special_tokens": False,
        "truncate_prompt_tokens": None, "cache_salt": request["cache_namespace"],
        "temperature": sampling["temperature_milli"] / 1000,
        "top_p": sampling["top_p_millionths"] / 1000000,
        "top_k": sampling["top_k"] or -1, "seed": sampling["seed"],
        "stop_token_ids": sampling["stop_token_ids"], "priority": 0,
    }


def validate_submission(payload, session):
    body = dict(envelope(payload))
    try:
        flex = body.pop("_flex")
        binding, request = flex["binding"], flex["request"]
        # These outer routing fields are not inference inputs. Never copy them
        # to native vLLM: derive every effective input from the frozen request.
        if body not in (
            {"request_id": request["execution_id"], "stream": True},
            {"request_id": request["execution_id"], "stream": True, "stream_options": {"include_usage": True, "continuous_usage_stats": True}},
        ):
            raise ValueError()
        if set(flex) != {"engine_epoch", "profile_digest", "binding", "request"}:
            raise ValueError()
        if flex["engine_epoch"] != session["engine_epoch"] or flex["profile_digest"] != session["profile_digest"]:
            raise HTTPException(409, "Engine epoch or profile changed")
        unsigned = {k: v for k, v in request.items() if k != "request_digest"}
        if digest("flex-scheduler/request/v1", unsigned) != request["request_digest"]:
            raise ValueError()
        if any(binding[k] != request[k] for k in ("request_digest", "execution_id", "grant_id")):
            raise ValueError()
        if binding["engine_epoch"] != session["engine_epoch"]:
            raise ValueError()
        prompt, output = request["prompt_token_ids"], request["max_output_tokens"]
        if not isinstance(prompt, list) or not 1 <= len(prompt) <= MAX_PROMPT:
            raise ValueError()
        if type(output) is not int or not 1 <= output <= MAX_OUTPUT:
            raise ValueError()
        if any(type(t) is not int or not 0 <= t < session["profile"]["vocab_size"] for t in prompt):
            raise ValueError()
        if request["context_reservation"] != len(prompt) + output:
            raise ValueError()
        native = completion_body(request)
        if len(canonical(native)) > 512000:
            raise ValueError()
        return native, binding
    except HTTPException:
        raise
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "Frozen request binding or supported parameters invalid") from None


chute = build_vllm_chute(
    username=USERNAME, model_name=MODEL, revision=REVISION, image=IMAGE,
    node_selector=NodeSelector(gpu_count=1, min_vram_gb_per_gpu=96, include=["pro_6000"], max_hourly_price_per_gpu=2.25),
    concurrency=8, max_instances=1, shutdown_after_seconds=300, tee=True,
    engine_args=ENGINE_ARGS,
    tagline="Private scheduler acceptance: pinned Qwen vLLM, one GPU",
    readme="Scheduler-only token-ID completion endpoint, fixed model revision and image.",
)
# The vLLM startup hook is retained; public/native chat and completion routes are not.
chute.chute._cords.clear()
# Preserve the existing classification and module lock. An opaque frozen-request
# envelope keeps its gateway's routing rewrites outside the native input contract.
chute.chute.lock_modules = True


@chute.chute.on_startup(priority=60)
async def initialize_scheduler(self):
    from pathlib import Path
    from huggingface_hub import hf_hub_download
    from transformers import AutoTokenizer
    import torch

    tokenizer_path = Path(hf_hub_download(MODEL, "tokenizer.json", revision=REVISION, local_files_only=True))
    tokenizer_config_path = Path(hf_hub_download(MODEL, "tokenizer_config.json", revision=REVISION, local_files_only=True))
    model_config_path = Path(hf_hub_download(MODEL, "config.json", revision=REVISION, local_files_only=True))
    tokenizer_json = json.loads(tokenizer_path.read_text())
    tokenizer_config = json.loads(tokenizer_config_path.read_text())
    model_config = json.loads(model_config_path.read_text())
    text_config = model_config.get("text_config", model_config)
    if tokenizer_json["model"]["type"] != "BPE" or "ByteLevel" not in json.dumps(tokenizer_json["decoder"]):
        raise RuntimeError("Uncalibrated tokenizer encoding")
    pieces = list(tokenizer_json["model"]["vocab"])
    pieces += [token["content"] for token in tokenizer_json.get("added_tokens", [])]
    # UTF-8 replacement expands any byte at most threefold; add token-ID/record overhead.
    max_piece_bytes = max(len(piece.encode()) for piece in pieces)
    tokenizer_manifest = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (tokenizer_path, tokenizer_config_path)}
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_path.parent, local_files_only=True, trust_remote_code=False)
    chat_template = tokenizer.chat_template
    profile = {
        "profile_id": "chutes-qwen38-27b-flex-v1", "served_model": MODEL,
        "model_revision": REVISION, "vllm_version": importlib.metadata.version("vllm"), "image_ref": IMAGE,
        "engine_args_digest": digest("flex-scheduler/vllm-engine-args/v1", {"args": ENGINE_ARGS, "adapter": ADAPTER_VERSION}),
        "tokenizer_digest": digest("flex-scheduler/tokenizer-files/v1", tokenizer_manifest),
        "chat_template_digest": digest("flex-scheduler/chat-template/v1", chat_template),
        "gpu_name": torch.cuda.get_device_name(0), "vocab_size": text_config["vocab_size"],
        "max_prompt_tokens": MAX_PROMPT, "max_output_tokens": MAX_OUTPUT, "max_model_len": 32768,
        "result_bytes_per_output_token": 12 + 3 * max_piece_bytes, "result_overhead_bytes": 72,
        "max_live_requests": 8, "scheduler_only": True,
    }
    self.flex_lock = threading.Lock()
    self.flex_session = {"profile": profile, "profile_digest": digest("flex-scheduler/vllm-profile/v1", profile), "engine_epoch": "chutes-" + uuid.uuid4().hex, "accepting": True}
    self.flex_seen, self.flex_active, self.flex_traces = set(), set(), {}


def native_session(self):
    context = getattr(self, "passthrough_ssl_context", None)
    return aiohttp.ClientSession(
        connector=aiohttp.TCPConnector(ssl=context),
        headers={**self.passthrough_headers, "Accept-Encoding": "identity"},
        timeout=aiohttp.ClientTimeout(total=180, connect=5), trust_env=False,
        base_url=("https" if context else "http") + "://127.0.0.1:10101",
    )


@chute.chute.cord(public_api_path="/scheduler/profile", public_api_method="POST")
async def scheduler_profile(self, payload: dict) -> dict:
    envelope(payload)
    with self.flex_lock:
        return dict(self.flex_session)


@chute.chute.cord(public_api_path="/scheduler/tokenize", public_api_method="POST")
async def scheduler_tokenize(self, payload: dict) -> dict:
    payload = envelope(payload)
    if set(payload) != {"messages"} or len(canonical(payload)) > 128000:
        raise HTTPException(400, "Bounded chat messages required")
    messages = payload["messages"]
    if not isinstance(messages, list) or not 1 <= len(messages) <= 8 or any(set(m) != {"role", "content"} or m["role"] not in {"system", "user", "assistant"} or not isinstance(m["content"], str) for m in messages):
        raise HTTPException(400, "Text-only messages required")
    # Render in the native server process. The Cord worker has a locked module
    # environment and must not lazily import Jinja/tokenizer dependencies.
    async with native_session(self) as session:
        async with session.post("/tokenize", json={"model": MODEL, "messages": messages,
                                "add_generation_prompt": True, "add_special_tokens": False,
                                "chat_template_kwargs": {"enable_thinking": False}}) as response:
            if response.status != 200 or response.content_length and response.content_length > 262144:
                raise HTTPException(502, "Native tokenizer rejected bounded request")
            raw = bytearray()
            async for chunk in response.content.iter_chunked(16384):
                raw.extend(chunk)
                if len(raw) > 262144:
                    raise HTTPException(502, "Native tokenizer response limit")
            ids = json.loads(raw).get("tokens")
    if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_PROMPT or any(type(t) is not int or not 0 <= t < self.flex_session["profile"]["vocab_size"] for t in ids):
        raise HTTPException(400, "Prompt limit")
    return {"engine_epoch": self.flex_session["engine_epoch"], "profile_digest": self.flex_session["profile_digest"], "token_ids": ids}


@chute.chute.cord(public_api_path="/scheduler/completions", public_api_method="POST", stream=True, output_content_type="text/event-stream")
async def scheduler_completion(self, payload: dict):
    body, binding = validate_submission(payload, self.flex_session)
    execution = binding["execution_id"]
    trace = {"admitted_ns": time.monotonic_ns(), "first_token_ns": None, "terminal_ns": None, "finished_ns": None, "binding_digest": digest("flex-scheduler/result-binding/v1", binding)}
    with self.flex_lock:
        if not self.flex_session["accepting"] or execution in self.flex_seen or len(self.flex_seen) >= MAX_SEEN:
            raise HTTPException(409, "Admission sealed, duplicate execution, or epoch capacity")
        if len(self.flex_active) >= 8:
            raise HTTPException(429, "Native active limit")
        self.flex_seen.add(execution)
        self.flex_active.add(execution)
        self.flex_traces[execution] = trace
    try:
        async with native_session(self) as session:
            async with session.post("/v1/completions", json=body) as response:
                if response.status != 200 or response.headers.get("Content-Type", "").split(";")[0] != "text/event-stream":
                    raise HTTPException(502, "Native vLLM completion rejected")
                identity = {"engine_epoch": self.flex_session["engine_epoch"], "profile_digest": self.flex_session["profile_digest"], "binding_digest": trace["binding_digest"]}
                yield b"event: flex.identity\ndata: " + canonical(identity) + b"\n\n"
                async for line in response.content:
                    if len(line) > 262144:
                        raise RuntimeError("Native SSE line limit")
                    if line.startswith(b"data: {"):
                        chunk = json.loads(line[6:])
                        for choice in chunk.get("choices", []):
                            if choice.get("token_ids") and trace["first_token_ns"] is None:
                                trace["first_token_ns"] = time.monotonic_ns()
                            if choice.get("finish_reason") is not None:
                                trace["terminal_ns"] = time.monotonic_ns()
                    yield line
    finally:
        trace["finished_ns"] = time.monotonic_ns()
        with self.flex_lock:
            self.flex_active.discard(execution)


@chute.chute.cord(public_api_path="/scheduler/state", public_api_method="POST")
async def scheduler_state(self, payload: dict) -> dict:
    envelope(payload)
    with self.flex_lock:
        return {"engine_epoch": self.flex_session["engine_epoch"], "accepting": self.flex_session["accepting"], "active": sorted(self.flex_active), "traces": dict(self.flex_traces), "release": RELEASE}


@chute.chute.cord(public_api_path="/scheduler/seal", public_api_method="POST")
async def scheduler_seal(self, payload: dict) -> dict:
    payload = envelope(payload)
    if payload != {"engine_epoch": self.flex_session["engine_epoch"]}:
        raise HTTPException(409, "Wrong engine epoch")
    with self.flex_lock:
        self.flex_session["accepting"] = False
        return {"engine_epoch": self.flex_session["engine_epoch"], "accepting": False, "active": sorted(self.flex_active)}


@chute.chute.cord(public_api_path="/metrics", public_api_method="GET", output_content_type="text/plain")
async def scheduler_metrics(self, payload: dict = None) -> Response:
    async with native_session(self) as session:
        async with session.get("/metrics") as response:
            if response.status != 200:
                raise HTTPException(502, "Native metrics unavailable")
            return Response(content=await response.read(), status_code=200, media_type="text/plain", headers={"Cache-Control": "no-store"})
