#!/usr/bin/env python3
"""Official NEAR Intents server/client SDK, real PG/Redis, controlled 1Click.

No blockchain signing/broadcast, real funds, external HTTP or real inference.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import json
from pathlib import Path
import subprocess
import threading
import uuid

from market_b_support import CommitProxy, Market, Seller, run, wait_for
from urllib.parse import parse_qs, urlsplit

http = importlib.import_module('accept-market-mpp').request
ROOT=Path(__file__).resolve().parent.parent
CLIENT=ROOT/'services/mpp-nearintents/test/pay.mjs'
ORIGIN='eip155:42161/erc20:0x1111111111111111111111111111111111111111'
DESTINATION='near:mainnet/nep141:usdc.test.near'
REFUND='0x2222222222222222222222222222222222222222'


class OneClickFixture(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self):
        super().__init__(('127.0.0.1',0),OneClickHandler)
        self.quotes={}
        self.lock=threading.Lock()
        self.payments=0
        self.requests=[]
        self.thread=threading.Thread(target=self.serve_forever,daemon=True)
        self.thread.start()
    @property
    def url(self): return 'http://127.0.0.1:'+str(self.server_address[1])


class OneClickHandler(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def send(self,status,value):
        raw=json.dumps(value).encode(); self.send_response(status)
        self.send_header('content-type','application/json'); self.send_header('content-length',str(len(raw)))
        self.end_headers(); self.wfile.write(raw)
    def do_POST(self):
        value=json.loads(self.rfile.read(int(self.headers['content-length'])))
        s=self.server
        s.requests.append(('POST',self.path))
        if self.path=='/v0/quote':
            assert value['dry'] is False and value['swapType']=='EXACT_OUTPUT'
            assert value['originAsset']=='origin-usdc' and value['destinationAsset']=='destination-usdc'
            assert value['recipient']=='merchant.test.near' and value['refundTo']==REFUND
            with s.lock:
                address='0x'+format(len(s.quotes)+1,'040x')
                quote={'depositAddress':address,'amountIn':str(int(value['amount'])+100),'minAmountIn':str(int(value['amount'])+99),'deadline':value['deadline'],'timeEstimate':0}
                s.quotes[address]={'quote':quote,'request':value,'mode':'success','observed':None}
            self.send(200,{'quote':quote,'quoteRequest':value}); return
        if self.path=='/fixture/pay':
            with s.lock:
                s.quotes[value['address']]['observed']=value['hash']; s.payments+=1
            self.send(200,{}); return
        if self.path=='/v0/deposit/submit': self.send(200,{}); return
        self.send(404,{})
    def do_GET(self):
        s=self.server; url=urlsplit(self.path); s.requests.append(('GET',url.path))
        if url.path=='/v0/tokens':
            self.send(200,[{'assetId':'origin-usdc','blockchain':'arb','contractAddress':'0x1111111111111111111111111111111111111111','decimals':6,'symbol':'USDC'},
                           {'assetId':'destination-usdc','blockchain':'near','contractAddress':'usdc.test.near','decimals':6,'symbol':'USDC'}]); return
        if url.path=='/v0/status':
            address=parse_qs(url.query)['depositAddress'][0]; item=s.quotes[address]
            if item['mode']=='unavailable': self.send(503,{'message':'controlled unavailability'}); return
            observed=item['observed']
            if not observed or item['mode']=='pending': self.send(200,{'status':'PENDING_DEPOSIT'}); return
            if item['mode']=='wrong-hash': observed='0x'+'f'*64
            status='SUCCESS' if item['mode'] not in ('FAILED','REFUNDED','INCOMPLETE_DEPOSIT') else item['mode']
            self.send(200,{'status':status,'swapDetails':{'originChainTxHashes':[{'hash':observed}],
                'destinationChainTxHashes':[{'hash':'controlled-destination-'+address[-6:]}]}}); return
        self.send(404,{})


def setup(m,fixture,proxy=False,live=False):
    config={'mode':'controlled','originAsset':ORIGIN,'destinationAsset':DESTINATION,'destinationRecipient':'merchant.test.near','refundTo':REFUND,
            'realm':'private-market-acceptance','expiresWindow':300,'settlementTimeout':1,'pollInterval':10,'oneClickBaseUrl':fixture.url}
    if live:
        config['mode']='live'; config.pop('oneClickBaseUrl')
    path=m.root/'nearintents.json'; path.write_text(json.dumps(config))
    m.env.update(PRIVATE_MARKET_MPP_METHOD='nearintents',PRIVATE_MARKET_MPP_NEARINTENTS_CONFIG=str(path),MPP_SECRET_KEY=uuid.uuid4().hex+uuid.uuid4().hex)
    initialized=json.loads(run(m.binary,'init',str(m.state),env=m.env)); assert initialized['test_credit_micro_usd']==0
    m.data=json.loads((m.state/'state.json').read_text()); m.buyers=m.data['buyers']
    host,port=m.data['fixture_addr'].split(':')
    m.seller=Seller((host,int(port)),m.env['PRIVATE_MARKET_SELLER_KEY'])
    if proxy:
        parsed=urlsplit(m.direct)
        m.proxy=CommitProxy(('127.0.0.1',parsed.port),financial_marker=b'UPDATE mpp_nearintents_funding SET payment_key=')
        m.env['DATABASE_URL']=parsed._replace(netloc=parsed.netloc.rsplit(':',1)[0]+':'+str(m.proxy.server_address[1])).geturl()
        m.data['database']=m.env['DATABASE_URL']; (m.state/'state.json').write_text(json.dumps(m.data))
    m.start()


def create(m,key,amount='10000',buyer=0):
    response=http(m,'/market/v1/funding-intents',{'amount_micro_usd':amount},key,buyer=buyer)
    assert response[0] in (200,201),response
    return response[1]


def credential(intent,hash):
    return subprocess.check_output(['node',str(CLIENT)],input=json.dumps({'action':'credential','challenge':intent['challenge'],'hash':hash}).encode()).decode()


def make_payment(m,fixture,intent):
    input={'url':m.url+'/market/v1/funding-intents/'+intent['id']+'/pay','fixtureUrl':fixture.url,'token':m.buyers[0]['token'],
           'policy':{'allowedOriginNetworks':['eip155:42161'],'allowedCurrencies':[ORIGIN],'maxAmountIn':{ORIGIN:'10000000'},
                     'expectedDestination':{'network':'near:mainnet','asset':DESTINATION,'recipient':'merchant.test.near'},'expectedRefundTo':REFUND}}
    value=json.loads(subprocess.check_output(['node',str(CLIENT)],input=json.dumps(input).encode()))
    assert value['status']==200,value
    return value


def acceptance(binary):
    fixture=OneClickFixture()
    try:
        with Market(binary,initialize=False) as m:
            setup(m,fixture)
            intent=create(m,'sdk-funding')
            assert intent['method']=='nearintents' and intent['real_payment'] is False
            request=intent['challenge']['request']
            assert request['methodDetails']['amountOut']=='10000' and request['recipient']!=request['methodDetails']['destinationRecipient']
            assert request['methodDetails']['refundTo']==REFUND
            equal=create(m,'same-amount-other-buyer',buyer=1)
            assert equal['challenge']['request']['recipient']!=request['recipient'],'funding intents must not share a cached deposit address'
            assert equal['challenge']['request']['externalId']==equal['id']
            path='/market/v1/funding-intents/'+intent['id']
            assert http(m,path,buyer=1)[0]==404
            paid=make_payment(m,fixture,intent)
            assert paid['body']['status']=='credited'
            receipt=paid['body']['payment_receipt']
            assert receipt['method']=='nearintents' and receipt['externalId']==intent['id'] and receipt['reference'].startswith('controlled-destination-')
            proof=paid['credential']
            with ThreadPoolExecutor(max_workers=4) as pool:
                results=list(pool.map(lambda _:http(m,path+'/pay',{},payment=proof),range(4)))
            assert all(value[0]==200 for value in results),results
            assert m.balance()==10000 and m.sql('SELECT count(*) FROM mpp_nearintents_payments')=='1'
            assert http(m,path+'/pay',{})[0]==200 and fixture.payments==1
            assert create(m,'sdk-funding')['id']==intent['id']
            assert http(m,'/market/v1/funding-intents',{'amount_micro_usd':'10001'},'sdk-funding')[0]==409
            # Same observed payment cannot be credited to another authenticated intent.
            origin_hash=receipt['originTxHash']
            rebound=credential(equal,origin_hash.upper().replace('0X','0x'))
            assert http(m,'/market/v1/funding-intents/'+equal['id']+'/pay',{},buyer=1,payment=rebound)[0]==409
            assert m.balance(1)==0
            for index in range(2):
                key='nearintents-funded-'+str(index); assert m.post(key)[0]==200
                wait_for(lambda: (r if (r:=m.receipt(key)) and r.get('financial') else None))
            funds=http(m,'/market/v1/funds')[1]
            assert funds['conserved'] and funds['funded_micro_usd']=='10000' and funds['charged_micro_usd']=='74',funds
            assert len(m.seller.calls)==2 and fixture.payments==1
            m.stop(crash=True); m.start()
            assert http(m,path+'/pay',{},payment=proof)[1]['payment_receipt']==receipt
            assert http(m,'/market/v1/funds')[1]==funds
            return {'funding_entries':1,'controlled_native_calls':2,'remaining_micro_usd':m.balance(),'sdk_client_interop':True}
    finally:
        fixture.shutdown(); fixture.server_close()


def faults(binary):
    fixture=OneClickFixture()
    try:
        with Market(binary,initialize=False) as m:
            setup(m,fixture,proxy=True)
            def prepared(key,mode='success'):
                intent=create(m,key,'1000')
                address=intent['challenge']['request']['recipient']
                tx='0x'+uuid.uuid4().hex+uuid.uuid4().hex
                fixture.quotes[address].update(observed=tx,mode=mode)
                return intent,credential(intent,tx)
            def pay(intent,proof):return http(m,'/market/v1/funding-intents/'+intent['id']+'/pay',{},payment=proof)
            def reconcile(intent):return http(m,'/market/v1/funding-intents/'+intent['id']+'/reconcile',{})

            # Actual lost PG acknowledgment after SDK consumption and cash commit.
            intent,proof=prepared('lost-commit')
            m.proxy.armed.set()
            assert pay(intent,proof)[0]==503
            assert m.proxy.fired.wait(5) and m.balance()==1000
            assert pay(intent,proof)[0]==200 and m.balance()==1000
            assert m.sql('SELECT count(*) FROM mpp_nearintents_payments')=='1'

            # A local ledger failure must roll back SDK hash consumption too.
            intent,proof=prepared('credit-rollback')
            m.sql("CREATE FUNCTION reject_mpp_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled credit fault'; END $$; CREATE TRIGGER reject_mpp_credit BEFORE INSERT ON credit_ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_mpp_credit()")
            assert pay(intent,proof)[0]==503 and m.balance()==1000
            assert m.sql("SELECT count(*) FROM mpp_nearintents_attempts WHERE funding_id='"+intent['id']+"'")=='1'
            m.sql('DROP TRIGGER reject_mpp_credit ON credit_ledger_entries; DROP FUNCTION reject_mpp_credit()')
            assert reconcile(intent)[0]==200 and m.balance()==2000

            # Backend unavailability and settlement timeout do not consume funds.
            for mode in ['unavailable','pending','wrong-hash']:
                intent,proof=prepared(mode,mode)
                original=m.balance(); reply=pay(intent,proof)
                assert reply[0] in (409,503,504),reply
                assert 'WWW-Authenticate' not in reply[2], 'a failed paid attempt must not ask for a second payment'
                uncredentialed=pay(intent,None)
                assert uncredentialed[0]==202 and 'WWW-Authenticate' not in uncredentialed[2]
                assert m.balance()==original
                fixture.quotes[intent['challenge']['request']['recipient']]['mode']='success'
                assert reconcile(intent)[0]==200,(mode,reconcile(intent))
                assert m.balance()==original+1000

            # Confirmed unsuccessful outcomes remain recorded and never credited.
            for mode in ['FAILED','REFUNDED','INCOMPLETE_DEPOSIT']:
                intent,proof=prepared(mode,mode); original=m.balance()
                reply=pay(intent,proof)
                assert reply[0]==409 and 'WWW-Authenticate' not in reply[2],reply
                assert pay(intent,None)[0]==202
                assert m.balance()==original
                assert http(m,'/market/v1/funding-intents/'+intent['id'])[1]['status']=='reconciliation_required'

            # A hash never observed by the settlement system cannot pay for a quote.
            intent,proof=prepared('not-observed','pending')
            original=m.balance()
            assert pay(intent,proof)[0] in (503,504) and m.balance()==original
            known,known_proof=prepared('known-hash-client')
            known_hash=fixture.quotes[known['challenge']['request']['recipient']]['observed']
            known_request={'action':'present-known','url':m.url+'/market/v1/funding-intents/'+known['id']+'/pay',
                'token':m.buyers[0]['token'],'hash':known_hash,
                'policy':{'allowedOriginNetworks':['eip155:42161'],'allowedCurrencies':[ORIGIN],'maxAmountIn':{ORIGIN:'10000000'},'expectedRefundTo':REFUND}}
            known_response=json.loads(subprocess.check_output(['node',str(CLIENT)],input=json.dumps(known_request).encode()))
            assert known_response['status']==200 and known_response['body']['status']=='credited',known_response
            assert m.effects()==0 and not m.seller.calls
            assert http(m,'/market/v1/funds')[1]['conserved']
    finally:
        fixture.shutdown(); fixture.server_close()


def main():
    parser=argparse.ArgumentParser(); parser.add_argument('binary',type=Path); parser.add_argument('--evidence',type=Path)
    args=parser.parse_args(); binary=str(args.binary.resolve())
    observed=acceptance(binary)
    faults(binary)
    fixture=OneClickFixture()
    try:
        with Market(binary,initialize=False) as m:
            setup(m,fixture,live=True)
            assert http(m,'/market/v1/funds')[0]==200
            assert http(m,'/market/v1/funds',buyer=1)[0]==403
            assert http(m,'/market/v1/funding-intents',{'amount_micro_usd':'1000'},'other-live-buyer',buyer=1)[0]==403
            assert http(m,'/market/v1/funds')[1]['real_payment'] is False
            assert not fixture.requests and m.balance()==0 and m.effects()==0
    finally:
        fixture.shutdown(); fixture.server_close()
    evidence={'result':'pass','payment_method':'nearintents','sdk_version':'0.4.1','mppx_version':'0.17.0','settlement_backend':'controlled-1click',
        'real_payment':False,'real_provider':False,'external_spend':0,**observed,
        'checks':['official-sdk-client-server','exact-output-credit','funding-quote-isolation','buyer-isolation','concurrent-replay',
                  'canonical-origin-hash-dedup','one-funding-two-native-purchases','cash-conservation','restart-receipt-recovery',
                  'lost-commit-ack','sdk-ledger-atomic-rollback','durable-proof-journal','unavailable-retry','timeout-retry',
                  'wrong-hash-rejection','failed-uncredited','refunded-uncredited','underdeposit-uncredited','no-second-charge-challenge','known-hash-sdk-client','live-buyer-refund-fence']}
    if args.evidence:args.evidence.write_text(json.dumps(evidence,indent=2)+'\n')
    print(json.dumps(evidence,indent=2))


if __name__=='__main__':main()
