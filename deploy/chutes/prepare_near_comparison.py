"""Prepare local NEAR bridge registration from a reviewed A/B plan. Zero inference calls.

Tokenizer compatibility is subsequently checked by native calibration, never inferred
from a matching model name. No NEAR checkpoint revision is claimed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import time
from tokenizer import Tokenizer
from gateway import canonical


def prepare(args):
    comparison = json.loads(Path(args.comparison_plan).read_bytes())
    unsigned = {k: v for k, v in comparison.items() if k != 'planHash'}
    assert hashlib.sha256(canonical(unsigned)).hexdigest() == comparison['planHash'] == args.reviewed_plan_hash
    assert comparison['phase'] == 'fixed-supply-comparison' and not comparison['realAgentPayments']
    now = time.time_ns() // 1000000
    tariff = comparison['arms']['A']['tariff']
    assert comparison['createdAtMs'] <= now < comparison['deadlineMs'] <= tariff['expiresAtMs']
    assert tariff['model'] == 'Qwen/Qwen3.8-27B' and tariff['source'] == 'https://cloud-api.near.ai/v1/model/list'
    assert hashlib.sha256(canonical({k: v for k, v in tariff.items() if k != 'priceVersion'})).hexdigest() == tariff['priceVersion']
    assert 0 < args.bridge_port < 65536 and 0 < args.tokenizer_port < 65536 and args.bridge_port != args.tokenizer_port
    key_file = Path(args.api_key_file).expanduser().resolve()
    assert key_file.is_file() and key_file.stat().st_mode & 0o077 == 0
    assert key_file.read_text().strip()
    tokenizer_plan = json.loads(Path(args.tokenizer_plan).read_bytes())
    tokenizer_plan['public_model'] = 'Qwen/Qwen3.8-27B'
    qualifier = Tokenizer(tokenizer_plan)
    request = dict(comparison['request'], model=tariff['model'])
    ids = qualifier.tokenize(request)
    budget = int(comparison['budgetPerArmMicro'])
    assert 0 < budget <= 250000  # Four calibration/purchase intents together stay <= $1 estimate.
    rates = {k: int(v) for k, v in tariff['rates'].items()}
    estimate = (len(ids)*rates['input'] + request['max_completion_tokens']*rates['output'] + 999999)//1000000
    assert estimate*4 <= budget*4 <= 1000000
    root = Path(args.output).resolve()
    root.mkdir(mode=0o700)
    def save(name, value):
        raw = value if isinstance(value, bytes) else canonical(value)
        with os.fdopen(os.open(root/name, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600), 'wb') as out:
            out.write(raw); out.flush(); os.fsync(out.fileno())
    request_hash = hashlib.sha256(canonical(comparison['request'])).hexdigest()
    assert request_hash == comparison['requestHash']
    secret = secrets.token_hex(32)
    config = {'localSecret': secret, 'storageKey': secrets.token_hex(32), 'storePath': str(root/'near.sqlite'),
        'apiKeyFile': str(key_file), 'port': args.bridge_port, 'authorizedRequestHash': request_hash,
        'maxUpstreamCalls': 4, 'qualifiedInputTokens': len(ids), 'upstreamBudgetMicro': str(budget*4), 'tariff': tariff}
    registration = {'version': 1, 'market_id': 'near-comparison-'+comparison['planHash'][:24],
        'seller_principal': 'near-comparison-project', 'project_authorizes_on_demand_terms': True,
        'project_pays_upstream_costs': True, 'origin': 'https://cloud-api.near.ai', 'model': tariff['model'],
        'verified_bridge_url': f'http://127.0.0.1:{args.bridge_port}',
        'model_revision_ref': 'near-catalog/'+tariff['priceVersion']+'/revision-unverified',
        'tokenizer_ref': tokenizer_plan['tokenizer_ref'], 'tokenizer_url': f'http://127.0.0.1:{args.tokenizer_port}/tokenize',
        'tokenizer_files_sha256': tokenizer_plan['tokenizer_files_sha256'], 'token_ids': ids,
        'max_output_tokens': request['max_completion_tokens'], 'context_window_tokens': 32768,
        'rates': rates, 'request_sha256': request_hash, 'offer_valid_until_ms': comparison['deadlineMs'],
        'upstream_budget_micro_usd': budget*4, 'maximum_upstream_calls': 4}
    save('bridge.json', config); save('registration.json', registration); save('tokenizer-plan.json', tokenizer_plan)
    save('local-secret', secret.encode())
    native_request = dict(request, user='cmp-'+hashlib.sha256((comparison['planHash']+'/calibration').encode()).hexdigest(),
        stream=True, stream_options={'include_usage': True})
    save('calibration-request.json', native_request)
    save('prepared.json', {'version': 1, 'planHash': comparison['planHash'], 'requestHash': request_hash,
        'realAgentPayments': False, 'providerRevisionVerified': False, 'inferenceCalls': 0,
        'maximumUpstreamCalls': 4, 'maximumEstimatedUpstreamMicro': estimate*4,
        'upstreamBudgetIsEstimateNotProviderEnforced': True})
    return {'prepared': True, 'planHash': comparison['planHash'], 'inferenceCalls': 0,
        'qualifiedInputTokens': len(ids), 'nativeCalibrationStillRequired': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['comparison-plan', 'reviewed-plan-hash', 'tokenizer-plan', 'api-key-file', 'output']:
        parser.add_argument('--'+name, required=True)
    parser.add_argument('--bridge-port', type=int, required=True)
    parser.add_argument('--tokenizer-port', type=int, required=True)
    os.umask(0o077)
    print(json.dumps(prepare(parser.parse_args())))
