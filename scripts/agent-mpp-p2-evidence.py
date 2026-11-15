#!/usr/bin/env python3
"""Bind controlled P2 evidence to exact portable source and built binaries."""
import datetime,hashlib,json,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parent.parent
record=root/'docs/acceptance'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
matrix=json.loads((record/'2026-11-14-agent-mpp-p2-matrix.json').read_text())
regression=json.loads((record/'2026-11-14-agent-mpp-p2-p1-regression.json').read_text())
tests=(record/'2026-11-14-agent-mpp-p2-tests.tap').read_text()
assert len(matrix['checks'])==18 and all(c['passed'] for c in matrix['checks'])
assert len(regression['checks'])==22 and all(c['passed'] for c in regression['checks'])
assert '# fail 0' in tests and '# pass 62' in tests
browser=json.loads((record/'2026-11-14-agent-mpp-p2-browser.json').read_text())
assert len(browser['checks'])==8 and all(c['passed'] for c in browser['checks'])
for path,digest in {**browser['inputs'],**browser['build']}.items():
 assert sha(root/path)==digest,'browser evidence is stale: '+path
paths=[]
for base in ['crates/private-market-host','crates/private-market-p1','crates/private-market-p2','services/mpp-near-direct','clients/market-playground']:
 paths.extend(p for p in (root/base).rglob('*') if p.is_file() and not any(x in p.relative_to(root/base).parts for x in ['node_modules','target','dist','__pycache__']) and not p.name.endswith('.tsbuildinfo'))
for pattern in ['*agent-mpp-p1*','*agent-mpp-p2*','materialize-market-p[12].py','test-market-p2-source.py','market_b_support.py']:
 paths.extend((root/'scripts').glob(pattern))
paths.extend(root/p for p in ['.gitignore','README.md','docs/agent-mpp-p2.md','docs/specs/2026-11-14-agent-mpp-inference-integration.md','docs/acceptance/2026-11-14-agent-mpp-p2.md'])
artifacts=['2026-11-14-agent-mpp-p2-tests.tap','2026-11-14-agent-mpp-p2-matrix.json','2026-11-14-agent-mpp-p2-p1-regression.json']
artifacts.append('2026-11-14-agent-mpp-p2-diagnostics.json')
artifacts.extend(p.name for p in record.glob('2026-11-14-agent-mpp-p2-browser*') if p.is_file())
review=record/'2026-11-14-agent-mpp-p2-review.json'
if review.exists():artifacts.append(review.name)
extras=record/'2026-11-14-agent-mpp-p2-review-extras.json'
if extras.exists():artifacts.append(extras.name)
binary=pathlib.Path(sys.argv[1])
evidence={'phase':'P2','status':'controlled-tests-pass','generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
 'unitTests':62,'p2IntegrationCases':18,'p1RegressionCases':22,'realChainTransactions':0,'realProviderCalls':0,'liveSponsorQualification':'G1 CLOSED','fundingAndRealTaskAcceptance':'P3 CLOSED',
 'binarySha256':sha(binary),'p1BinarySha256':sha(binary.with_name('private-market-host-p1')),
 'materializedSource':json.loads((root/'.market-p2-upstream/.p2-source.json').read_text()),
 'inputs':{str(p.relative_to(root)):sha(p) for p in sorted(set(paths)) if p.is_file()},
 'browserBuild':{str(p.relative_to(root)):sha(p) for p in sorted((root/'clients/market-playground/dist').rglob('*')) if p.is_file()},
 'artifacts':{name:sha(record/name) for name in sorted(set(artifacts))}}
(record/'2026-11-14-agent-mpp-p2-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps({k:v for k,v in evidence.items() if k not in ['inputs','materializedSource','artifacts','browserBuild']},indent=2))
