#!/usr/bin/env python3
"""Two actual signed Markets + PG/Redis + controlled NEAR SDK / Chutes supply.

Zero external inference and no hardware/model-quality acceptance claims.
"""
import contextlib
import hashlib
import http.server
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

from market_b_support import Market, run, wait_for
from market_c import canonical, save
from controlled_dstack_rpc import Handler as RpcHandler

CLI='services/inference-comparison/test/controlled-cli.mjs'
MODELS={'A':'Qwen/Qwen3.8-27B','B':'qwen3.8-27b'}


def stream(model):
    def frame(choices, usage=None):
        return b'data: '+canonical(dict(id='controlled-native', object='chat.completion.chunk', model=model, choices=choices, **({'usage':usage} if usage else {})))+b'\n\n'
    return (frame([{'index':0,'delta':{'content':'42'},'finish_reason':None}])
        +frame([{'index':0,'delta':{},'finish_reason':'stop'}])
        +frame([],{'prompt_tokens':2,'completion_tokens':3,'total_tokens':5})+b'data: [DONE]\n\n')


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        now=time.time_ns()//1000000
        raw=canonical({'version':1,'provider':'chutes','model':'qwen3.8-27b','state':self.server.supply_state,'observedAtMs':now,'expiresAtMs':now+45000,'modelRevisionRef':'controlled-qwen-revision'})
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path=='/tokenize':
            assert body['model']==self.server.public_model
            raw=canonical({'tokenizer_ref':'controlled-tokenizer','token_ids':[42,43]}); media='application/json'
        else:
            assert self.path=='/v1/chat/completions' and body['model']=='Qwen/Qwen3.8-27B-FP8'
            assert self.headers['Authorization']=='Bearer '+self.server.secret
            assert not any(k.lower().startswith('x-buyer-') for k in self.headers)
            assert not any(k.startswith('bitrouter_') for k in body)
            self.server.calls.append(body); raw=stream(body['model']); media='text/event-stream'
        self.send_response(200); self.send_header('Content-Type',media);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)


def main(binary):
    with tempfile.TemporaryDirectory(prefix='inference-comparison-') as temp, contextlib.ExitStack() as stack:
        root=Path(temp); run('node',CLI,'plan',str(root/'plan.json')); plan=json.loads((root/'plan.json').read_bytes())
        config={'storePath':str(root/'comparison.sqlite'),'storageKey':'a'*64,'planFile':str(root/'plan.json'),'reportFile':str(root/'report.json'),'arms':{}}
        markets={}; servers={}
        for arm in ['A','B']:
            m=stack.enter_context(Market(binary,initialize=False));markets[arm]=m
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);servers[arm]=server
            server.public_model=MODELS[arm];server.secret=m.env['PRIVATE_MARKET_SELLER_KEY'];server.calls=[];server.supply_state="ready"
            threading.Thread(target=server.serve_forever,daemon=True).start()
            stack.callback(server.server_close);stack.callback(server.shutdown)
            base=f'http://127.0.0.1:{server.server_port}'
            bridge=base
            if arm=='A':
                bridge_config={'localSecret':server.secret*2,'storageKey':'b'*64,'storePath':str(root/'near.sqlite'),
                    'authorizedRequestHash':plan['requestHash'],'maxUpstreamCalls':4,'qualifiedInputTokens':2,
                    'upstreamBudgetMicro':'40000','tariff':plan['arms']['A']['tariff'],'callsFile':str(root/'near-calls.json')}
                m.env['PRIVATE_MARKET_SELLER_KEY']=bridge_config['localSecret']
                save(root/'bridge.json',bridge_config)
                child=subprocess.Popen(['node',CLI,'bridge',str(root/'bridge.json')],stdout=subprocess.PIPE,text=True)
                def stop_bridge():
                    if child.poll() is None: child.send_signal(signal.SIGINT);child.wait(timeout=10)
                stack.callback(stop_bridge)
                ready=json.loads(child.stdout.readline());assert ready['controlledSdk'];bridge=ready['url']
            profile={'version':1,'market_id':'comparison-'+arm,'seller_principal':'controlled-project',
                'project_authorizes_on_demand_terms':True,'project_pays_upstream_costs':True,
                'origin':'https://cloud-api.near.ai' if arm=='A' else 'https://kelsen-qwen-qwen3-8-27b-fp8.chutes.ai',
                'model':MODELS[arm],'verified_bridge_url':bridge,'model_revision_ref':'controlled-qwen-revision',
                'tokenizer_url':base+'/tokenize','tokenizer_ref':'controlled-tokenizer',
                'tokenizer_files_sha256':{'tokenizer.json':'a'*64,'tokenizer_config.json':'b'*64},'token_ids':[42,43],
                'max_output_tokens':64,'context_window_tokens':32768,'rates':{k:int(v) for k,v in plan['arms'][arm]['tariff']['rates'].items()},
                'request_sha256':plan['requestHash'],'offer_valid_until_ms':plan['deadlineMs'],'upstream_budget_micro_usd':40000,'maximum_upstream_calls':4}
            if arm=='B':profile['native_model']='Qwen/Qwen3.8-27B-FP8'
            save(m.root/'profile.json',profile);offline=m.root/'offline'
            run('node','scripts/chutes-buyer-fixture.mjs','generate',str(offline))
            for i in range(3):m.env[f'PRIVATE_MARKET_BUYER_TOKEN_{i}']='brk_'+str(uuid.uuid4())+'.'+uuid.uuid4().hex+uuid.uuid4().hex
            run(binary,'init-live-deploy',str(m.state),str(m.root/'profile.json'),str(offline/'public.json'),env=m.env)
            state=json.loads((m.state/'state.json').read_bytes());ended=time.time_ns()//1000000
            m.buyers=state['buyers']
            assert state['buyer_tokens_from_env'] and all(b['token']=='' for b in state['buyers'])
            raw=stream(MODELS[arm] if arm=='A' else profile['native_model']);save(m.root/'calibration.sse',raw)
            save(m.root/'measurement.json',{'registration_sha256':state['registration_sha256'],'request_sha256':profile['request_sha256'],
                'response_file':str(m.root/'calibration.sse'),'response_sha256':hashlib.sha256(raw).hexdigest(),
                'started_at_ms':ended-1,'ended_at_ms':ended,'response_model':MODELS[arm] if arm=='A' else profile['native_model'],
                'finish_reason':'stop','prompt_tokens':2,'completion_tokens':3,'total_tokens':5})
            run(binary,'qualify-live',str(m.state),str(m.root/'measurement.json'),env=m.env)
            m.env['PRIVATE_MARKET_SIGNED_PURCHASES']='1'
            if arm=='B':m.env.update(PRIVATE_MARKET_PUBLIC_MODEL=MODELS['B'],PRIVATE_MARKET_SUPPLY_STATUS_URL=base+'/v1/supply')
            rpc=http.server.ThreadingHTTPServer(('127.0.0.1',0),RpcHandler)
            threading.Thread(target=rpc.serve_forever,daemon=True).start();stack.callback(rpc.server_close);stack.callback(rpc.shutdown)
            run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(m.root/'tls.key'),'-out',str(m.root/'tls.pem'),'-days','1','-subj','/CN=controlled')
            save(m.root/'attestation.json',{'dstack_http':f'http://127.0.0.1:{rpc.server_port}/','tls_certificate':str(m.root/'tls.pem'),'public_domain':'127.0.0.1','keyset_lifetime_seconds':300})
            m.env['PRIVATE_MARKET_ATTESTATION_CONFIG']=str(m.root/'attestation.json')
            m.start()
            config['arms'][arm]={'baseURL':m.url+'/market/v1','token':m.env['PRIVATE_MARKET_BUYER_TOKEN_0'],
                'catalogFile':str(m.state/'catalog.json'),'signingKeyFile':str(offline/'buyer-0.key'),'attested':True}
        save(root/'runner.json',config)
        servers['B'].supply_state='warming';cash_before=markets['B'].balance()
        probe=json.loads(run('node',CLI,'probe-warming',str(root/'runner.json')))
        assert probe=={'status':503,'code':'supply_not_ready'},probe
        assert markets['B'].effects()==0 and markets['B'].balance()==cash_before and not servers['B'].calls
        servers['B'].supply_state='ready'
        first=json.loads(run('node',CLI,'run',str(root/'runner.json')))
        assert first['states']=={'A':'complete','B':'complete'},first
        assert len(json.loads((root/'near-calls.json').read_bytes()))==len(servers['B'].calls)==1
        for arm,m in markets.items():
            def settled():
                value=json.loads(m.sql("SELECT coalesce((SELECT receipt FROM market_inference_receipts WHERE receipt->'financial' IS NOT NULL ORDER BY revision DESC LIMIT 1),'null'::jsonb)"))
                return value if value and value.get('settlement')=='committed' else None
            assert wait_for(settled)['settlement']=='committed'
            assert m.effects()==1
            m.stop();m.start()
        config['reconcile']=True;(root/'runner.json').write_bytes(canonical(config))
        second=json.loads(run('node',CLI,'run',str(root/'runner.json')))
        assert second['states']==first['states']
        assert len(json.loads((root/'near-calls.json').read_bytes()))==len(servers['B'].calls)==1
        report=json.loads((root/'report.json').read_bytes())
        assert not report['realAgentPayments'] and report['taskSuccess'] is None
        assert all(r['serviceCostMicro'] is not None and r['settlement']['status']=='committed' and r['providerBillMicro'] is None for r in report['arms'].values())
        assert all(r['signedFinancialReceiptVerified'] for r in report['arms'].values())
        print(json.dumps({'controlled_comparison':'pass','signed_market_arms':2,'upstream_calls_per_arm':1,'settlement_and_restart_replay':'pass',
            'external_inference_calls':0,'hardware_attestation':'not_tested','real_agent_payments':False}))


if __name__=='__main__':main(str(Path(sys.argv[1]).resolve()))
