#!/usr/bin/env python3
"""Bind controlled acceptance artifacts to exact local inputs, excluding secrets."""
import datetime, hashlib, json, pathlib, subprocess, sys
root=pathlib.Path(__file__).resolve().parent.parent
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
paths=[root/'scripts'/name for name in ['accept-agent-mpp-p1.sh','accept-agent-mpp-p1.py','agent-mpp-p1-evidence.py','materialize-market-p1.py','market_b_support.py']]
paths.extend(root/name for name in ['README.md','.gitignore','docs/agent-mpp-p1.md','docs/acceptance/2026-11-14-agent-mpp-p1.md'])
for base in ['crates/private-market-host','crates/private-market-p1','services/mpp-near-direct']:
 paths.extend(p for p in (root/base).rglob('*') if p.is_file() and not any(s in p.relative_to(root/base).parts for s in ['node_modules','target','__pycache__']))
for name in ['2026-11-14-agent-mpp-inference-integration.md','2026-11-14-agent-mpp-p0-contract.md','2026-11-14-agent-mpp-p0-owning-interfaces.md']:
 paths.append(root/'docs/specs'/name)
record=root/'docs/acceptance'
matrix=json.loads((record/'2026-11-14-agent-mpp-p1-matrix.json').read_text())
tests=(record/'2026-11-14-agent-mpp-p1-tests.tap').read_text()
assert len(matrix['checks'])==22 and all(c['passed'] for c in matrix['checks']) and '# fail 0' in tests and '# pass 57' in tests,'acceptance incomplete'
evidence={'phase':'P1','status':'controlled-tests-pass','generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
 'unitTests':57,'integrationCases':len(matrix['checks']),'realChainTransactions':0,'realProviderCalls':0,'liveSponsorQualification':'G1 CLOSED',
 'binarySha256':sha(pathlib.Path(sys.argv[1])),
 'materializedSource':json.loads((root/'.market-p1-upstream/.p1-source.json').read_text()),
 'inputs':{str(p.relative_to(root)):sha(p) for p in sorted(set(paths))},
 'artifacts':{name:sha(record/name) for name in ['2026-11-14-agent-mpp-p1-tests.tap','2026-11-14-agent-mpp-p1-matrix.json','2026-11-14-agent-mpp-p1-review.json']}}
(record/'2026-11-14-agent-mpp-p1-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps({k:v for k,v in evidence.items() if k not in ['inputs','materializedSource','artifacts']},indent=2))
