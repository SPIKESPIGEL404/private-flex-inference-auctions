"""Make a reviewed CVM seed from a prepared provider run and offline buyer keys.

Contains public configuration and credential digests only, never credentials.
"""
import argparse
import hashlib
import json
from pathlib import Path
from gateway import canonical, load_config


def prepare(source, buyers_public, bearer_tokens, output, attestation_config, nginx_config):
    source = Path(source)
    config = load_config(source / 'gateway.json')
    plan = json.loads((source / 'plan.json').read_bytes())
    config_fields = {"version", "public_model", "native_model", "chute_id", "origin", "chute_image", "model_revision",
        "chute_version", "chute_code_sha256", "approved_measurement_policy", "measurement_profiles", "measurement_policy_source",
        "measurement_reference_sha256", "key_file", "local_secret_file", "evidence_directory", "min_gpu_count", "max_gpu_count"}
    plan_fields = {"version", "market_id", "public_model", "native_model", "tokenizer_files", "tokenizer_files_sha256",
        "tokenizer_ref", "model_revision_ref", "max_output_tokens", "context_window_tokens", "rates", "price_scope", "gateway_config",
        "upstream_budget_micro_usd", "chutes_spend_cap_micro_usd", "upstream_cost_authorization", "maximum_upstream_calls", "finite_offers"}
    assert set(config) <= config_fields and set(plan) <= plan_fields, "unrecognized fields may contain credentials"
    buyers = json.loads(Path(buyers_public).read_bytes())
    assert set(buyers) == {'public_keys'}, 'only offline verifying keys belong in public configuration'
    keys = buyers['public_keys']
    assert len(keys) == len(set(keys)) == 3 and all(isinstance(k, str) and k.startswith('ed25519:') and 40 <= len(k) <= 52 for k in keys)
    tokens = Path(bearer_tokens)
    assert tokens.stat().st_mode & 0o077 == 0
    raw_tokens = tokens.read_bytes()
    parsed = json.loads(raw_tokens)
    assert len(parsed) == len(set(parsed)) == 3 and all(isinstance(k, str) and k.startswith('brk_') for k in parsed)
    config.update(key_file='/data/chutes-run/chutes.key', local_secret_file='/data/chutes-run/local-secret',
        evidence_directory='/data/chutes-run/provider-evidence')
    plan.update(gateway_config='/data/chutes-run/gateway.json',
        tokenizer_files={n: '/data/chutes-run/' + n for n in plan['tokenizer_files']})
    seed = {'version': 1, 'files': {'gateway.json': canonical(config).decode(),
        'plan.json': canonical(plan).decode(), 'buyers.public.json': canonical(buyers).decode()},
        'buyer_tokens_sha256': hashlib.sha256(raw_tokens).hexdigest(),
        'tokenizer_urls': {n: 'https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/' + n
            for n in plan['tokenizer_files']}}
    for name, path in [('attestation.json', attestation_config), ('nginx.conf', nginx_config)]:
        text = Path(path).read_text()
        assert len(text.encode()) <= 128 * 1024 and 'PRIVATE KEY-----' not in text, "seed configuration must be bounded public text"
        seed['files'][name] = text
    raw = canonical(seed)
    with Path(output).open('xb') as out: out.write(raw)
    return hashlib.sha256(raw).hexdigest()


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--prepared-run', required=True); p.add_argument('--buyers-public', required=True)
    p.add_argument('--bearer-tokens', required=True); p.add_argument('--output', required=True)
    p.add_argument('--attestation-config', required=True); p.add_argument('--nginx-config', required=True)
    a = p.parse_args()
    print(json.dumps({'seed_sha256': prepare(a.prepared_run, a.buyers_public, a.bearer_tokens, a.output, a.attestation_config, a.nginx_config)}))
