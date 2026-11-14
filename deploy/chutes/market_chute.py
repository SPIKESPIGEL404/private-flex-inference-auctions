"""Native Chat deployment for the existing private Qwen Chute.

This replaces the historical scheduler-only deployment of the SAME chute.
Apply explicitly with manage.py --definition market --apply after draining it.
"""
from chutes.chute import NodeSelector
from chutes.chute.template.vllm import build_vllm_chute

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
