// Controlled tests only: buyer signing secrets stay outside the Market state.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {generateBuyerKeypair,readSigningKey,signPurchase,freshNonce} from '../clients/market-buyer/purchase-sign.mjs';
const [action,path]=process.argv.slice(2);
if(action==='generate'){
 await mkdir(path,{recursive:true,mode:0o700});const keys=[];
 for(let i=0;i<3;i++){const pair=generateBuyerKeypair();keys.push(pair.publicKey);await writeFile(path+`/buyer-${i}.key`,pair.secretKey,{mode:0o600,flag:'wx'});}
 await writeFile(path+'/public.json',JSON.stringify({public_keys:keys}),{mode:0o600,flag:'wx'});
}else if(action==='sign'){
 const c=JSON.parse(await readFile(path));const key=await readSigningKey(c.signing_key_file);
 console.log(JSON.stringify(signPurchase({seed:key.seed,publicKey:key.publicKey,body:Buffer.from(c.wire_b64,'base64'),idempotencyKey:c.idempotency_key,keyset:c.keyset_digest,nonce:freshNonce(),ts:Math.floor(Date.now()/1000)}).headers));
}else throw Error('expected generate or sign');
