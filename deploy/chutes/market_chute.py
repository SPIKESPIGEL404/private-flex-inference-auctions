"""Native Chat deployment for the existing private Qwen Chute.

This replaces the historical scheduler-only deployment of the SAME chute.
Apply explicitly with manage.py --definition market --apply after draining it.
"""
import asyncio

import aiohttp
from chutes.chute import NodeSelector
from chutes.chute.template.vllm import build_vllm_chute
from fastapi import HTTPException, Response

MODEL = "Qwen/Qwen3.8-27B-FP8"
REVISION = "017b9c7af6b5689d5dd426a76e0bc077eb5ca20a"
IMAGE = "6e46a33c-329a-5b55-a1dd-c9a5c9866943"

chute = build_vllm_chute(
    username="kelsen", model_name=MODEL, revision=REVISION, image=IMAGE,
    node_selector=NodeSelector(gpu_count=1, min_vram_gb_per_gpu=96,
        include=["pro_6000"]),
    concurrency=8, max_instances=1, shutdown_after_seconds=3600, tee=True,
    engine_args=("--tensor-parallel-size 1 --max-model-len 32768 --max-num-seqs 8 "
        "--gpu-memory-utilization 0.90 --kv-cache-dtype fp8 --language-model-only "
        "--generation-config vllm --enable-prefix-caching "
        "--prefix-caching-hash-algo sha256"),
    tagline="Private Qwen3.8-27B native Chat for the attested Market",
    readme="Pinned FP8 model/revision and vLLM image. Native Chat; no scheduler protocol.",
)
chute.chute.lock_modules = True


@chute.chute.cord(public_api_path="/metrics", public_api_method="GET", output_content_type="text/plain")
async def metrics(self, payload: dict = None) -> Response:
    """Owner-authenticated, read-only scrape of this replica's native engine."""
    ssl_context = getattr(self, "passthrough_ssl_context", None)
    try:
        async with aiohttp.ClientSession(
            base_url=("https" if ssl_context else "http") + "://127.0.0.1:10101",
            connector=aiohttp.TCPConnector(ssl=ssl_context),
            headers={**self.passthrough_headers, "Accept-Encoding": "identity"},
            timeout=aiohttp.ClientTimeout(total=10, connect=3, sock_read=5),
            trust_env=False,
        ) as session:
            # No caller-supplied URL, query, headers or method reaches the engine.
            async with session.get("/metrics", allow_redirects=False) as response:
                content_type = response.headers.get("Content-Type", "")
                if response.status != 200 or content_type.split(";", 1)[0].strip().lower() not in (
                    "text/plain", "application/openmetrics-text",
                ):
                    raise HTTPException(502, "Native metrics unavailable")
                body = bytearray()
                async for chunk in response.content.iter_chunked(65536):
                    if len(body) + len(chunk) > 4 * 1024 * 1024:
                        raise HTTPException(502, "Native metrics unavailable")
                    body.extend(chunk)
                return Response(content=bytes(body), media_type=content_type, headers={
                    "Content-Type": content_type, "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                })
    except (aiohttp.ClientError, asyncio.TimeoutError):
        raise HTTPException(502, "Native metrics unavailable") from None
