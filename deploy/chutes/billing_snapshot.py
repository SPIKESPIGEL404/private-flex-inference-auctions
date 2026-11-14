"""Read provider-reported usage for a closed UTC window, separately from Market money.

Invocation usage records do not establish the private owner GPU-time bill.
An invocation amount of zero never establishes zero GPU cost.
"""
import argparse
from datetime import datetime, timezone, timedelta
from decimal import Decimal, ROUND_CEILING
import hashlib
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request
from gateway import CHUTE_ID


def summarize(items, start, end):
    total=Decimal(0);normalized=[]
    for row in items:
        assert row['chute_id']==CHUTE_ID, 'billing chute differs'
        at=datetime.fromisoformat(row['bucket'].replace('Z','+00:00'))
        if at.tzinfo is None:at=at.replace(tzinfo=timezone.utc)
        assert start<=at<=end, 'billing bucket outside reviewed window'
        amount=Decimal(str(row['amount']));assert amount.is_finite() and amount>=0, 'invalid billed amount'
        total+=amount
        normalized.append({'bucket':at.isoformat(),'amountUsd':str(amount),'count':row['count'],
            'inputTokens':row['input_tokens'],'outputTokens':row['output_tokens']})
    return {'provider':'chutes','chuteId':CHUTE_ID,'start':start.isoformat(),'end':end.isoformat(),
        'source':'authenticated-provider-usage-api','scope':'whole-chute-window-not-per-request',
        'reportedUsageUsd':str(total),'reportedUsageMicroUsdCeil':str((total*1000000).to_integral_value(rounding=ROUND_CEILING)),
        'providerBillMicroPerRequest':None,'ownerGpuBillMicro':None,'isFinalInvoice':False,'buckets':normalized}


def main(args):
    start=datetime.fromisoformat(args.start.replace('Z','+00:00'));end=datetime.fromisoformat(args.end.replace('Z','+00:00'))
    assert start.utcoffset()==end.utcoffset()==timedelta(0) and start<=end and end-start<=timedelta(days=1)
    assert end<=datetime.now(timezone.utc)-timedelta(minutes=2), 'wait for closed usage buckets'
    key_path=Path(args.key_file);assert key_path.stat().st_mode&0o077==0
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*_,**__):return None
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    all_items=[];page_hashes=[]
    for page in range(20):
        query=urllib.parse.urlencode({'per_chute':'true','chute_id':CHUTE_ID,'start_date':start.replace(tzinfo=None).isoformat(),'end_date':end.replace(tzinfo=None).isoformat(),'limit':100,'page':page})
        req=urllib.request.Request('https://api.chutes.ai/users/me/usage?'+query,headers={'Authorization':'Bearer '+key_path.read_text().strip()})
        with opener.open(req,timeout=25) as response:raw=response.read(2*1024*1024+1)
        assert len(raw)<=2*1024*1024
        data=json.loads(raw,parse_float=Decimal);assert data['page']==page and data['limit']==100
        all_items.extend(data['items']);page_hashes.append(hashlib.sha256(raw).hexdigest())
        if len(all_items)>=data['total']:break
    else:raise RuntimeError('billing window exceeds bounded pagination')
    assert len(all_items)==data['total']
    result=summarize(all_items,start,end);result.update(pageSha256=page_hashes,observedAt=datetime.now(timezone.utc).isoformat())
    fd=os.open(args.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as out:json.dump(result,out,indent=2);out.write('\n')
    print(json.dumps({'saved':True,'scope':result['scope'],'reportedUsageUsd':result['reportedUsageUsd'],'inferenceCalls':0}))


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['key-file','start','end','output']:p.add_argument('--'+name,required=True)
    main(p.parse_args())
