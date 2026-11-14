import {randomBytes,verify} from 'node:crypto';
import {hash,canonical,requireThat,account} from '../contract.mjs';
import {nep413Digest} from '../near.mjs';
import {createPublicKey} from 'node:crypto';
import bs58 from 'bs58';
const keyObject=value=>{requireThat(/^ed25519:/.test(value),'invalid_owner_key');const b=Buffer.from(bs58.decode(value.slice(8)));requireThat(b.length===32,'invalid_owner_key');return createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),b])});};
export class Authorizations {
 constructor({pool,rpc,plan,runId=hash(plan),origin=plan.origin,now=Date.now}){Object.assign(this,{pool,rpc,plan,runId,origin,now});}
 async fullKey(accountId,publicKey){requireThat(account.test(accountId),'invalid_owner');const key=await this.rpc.call('query',{request_type:'view_access_key',account_id:accountId,public_key:publicKey,finality:'final'});
  requireThat(key.permission==='FullAccess','owner_key_not_full_access');}
 async challenge(kind='login',owner,role='owner'){
  requireThat(['login','grant'].includes(kind)&&['owner','project'].includes(role),'invalid_challenge');
  if(kind==='grant')requireThat(owner===(role==='project'?this.plan.projectAccount:this.plan.ownerAccount),'owner_not_authorized_for_run');
  const now=this.now(),expiry=kind==='login'?now+300000:Math.min(now+300000,this.plan.limits.deadlineMs),nonce=randomBytes(32).toString('base64'),id=hash(randomBytes(32).toString('hex'));
  requireThat(expiry>now,'run_expired');
  const statement={action:kind==='login'?'Sign in to Private Market':role==='project'?'Approve bounded project costs':'Authorize bounded agent custody and purchases',
   origin:this.origin,network:this.plan.network,runId:this.runId,role,owner:owner??null,expiresAtMs:expiry,
   ...(kind==='grant'?{planHash:hash(this.plan),custody:'OutLayer TEE custody; owner-controlled on-chain merchant/principal/signature policy; task budgets and original-operation recovery enforced by the project executor',plan:this.plan}:{})};
  const payload={message:canonical(statement),nonce,recipient:new URL(this.origin).host};
  await this.pool.query('DELETE FROM mpp_direct_p3_challenges WHERE expires_ms<$1 AND NOT consumed',[now-86400000]);
  const count=Number((await this.pool.query('SELECT count(*) FROM mpp_direct_p3_challenges WHERE expires_ms>$1',[now])).rows[0].count);requireThat(count<2000,'challenge_capacity');
  await this.pool.query('INSERT INTO mpp_direct_p3_challenges VALUES($1,$2,$3,$4,$5,$6,false)',[id,kind,payload,owner??null,this.runId,expiry]);
  return {id,payload,expiresAtMs:expiry,kind,role};
 }
 async verify(id,signed,expectedKind='login'){
  requireThat(typeof id==='string'&&typeof signed?.accountId==='string'&&typeof signed.publicKey==='string'&&typeof signed.signature==='string','invalid_owner_signature');
  const c=(await this.pool.query('UPDATE mpp_direct_p3_challenges SET consumed=true WHERE id=$1 AND kind=$2 AND NOT consumed AND expires_ms>$3 RETURNING *',[id,expectedKind,this.now()])).rows[0];requireThat(c,'challenge_expired_or_consumed');
  const statement=JSON.parse(c.payload.message);requireThat(statement.origin===this.origin&&statement.network===this.plan.network&&statement.runId===this.runId,'owner_domain_mismatch');
  const signature=Buffer.from(signed.signature,'base64');requireThat(signature.length===64&&signature.toString('base64')===signed.signature
   &&verify(null,nep413Digest(c.payload),keyObject(signed.publicKey),signature),'invalid_owner_signature');
  requireThat(!c.owner_id||c.owner_id===signed.accountId,'wrong_owner');await this.fullKey(signed.accountId,signed.publicKey);
  if(expectedKind==='login'){
   const token=randomBytes(32).toString('base64url'),expires=this.now()+8*3600000;
   await this.pool.query('INSERT INTO mpp_direct_p3_sessions VALUES($1,$2,$3,$4,true)',[hash(token),signed.accountId,signed.publicKey,expires]);return {token,owner:signed.accountId,expiresAtMs:expires};
  }
  requireThat(statement.planHash===hash(this.plan)&&c.run_id===this.runId,'run_plan_changed');
  const expires=Math.min(this.plan.limits.deadlineMs,this.now()+this.plan.limits.grantDurationMs);
  // A fresh signed challenge is required to replace or resume a revoked grant.
  await this.pool.query(`INSERT INTO mpp_direct_p3_grants(run_id,owner_id,role,proof,expires_ms,active) VALUES($1,$2,$3,$4,$5,true)
   ON CONFLICT(run_id,owner_id,role) DO UPDATE SET proof=excluded.proof,expires_ms=excluded.expires_ms,active=true`,[this.runId,signed.accountId,statement.role,{payload:c.payload,signature:signed.signature,publicKey:signed.publicKey},expires]);
  return {authorized:true,role:statement.role,expiresAtMs:expires};
 }
 async session(token){const s=(await this.pool.query('SELECT * FROM mpp_direct_p3_sessions WHERE token_hash=$1 AND active AND expires_ms>$2',[hash(token??''),this.now()])).rows[0];requireThat(s,'unauthorized');return s;}
 async requireGrant(owner,role='owner',db=this.pool){const g=(await db.query('SELECT * FROM mpp_direct_p3_grants WHERE run_id=$1 AND owner_id=$2 AND role=$3 AND active AND expires_ms>$4 FOR SHARE',[this.runId,owner,role,this.now()])).rows[0];requireThat(g,'run_authorization_required');return g;}
 async revoke(owner,role='owner'){
  requireThat(['owner','project'].includes(role)&&owner===(role==='project'?this.plan.projectAccount:this.plan.ownerAccount),'owner_not_authorized_for_run');
  const db=await this.pool.connect();try{await db.query('BEGIN');
   // Same per-agent fences as purchase reservation and wallet signature creation.
   const users=(await db.query('SELECT user_id FROM mpp_direct_agents WHERE owner_id=$1 ORDER BY user_id',[this.plan.ownerAccount])).rows;
   for(const u of users)await db.query('SELECT pg_advisory_xact_lock(public.balance_cache_advisory_key($1))',[u.user_id]);
   await db.query('UPDATE mpp_direct_p3_grants SET active=false WHERE run_id=$1 AND owner_id=$2 AND role=$3',[this.runId,owner,role]);
   await db.query('UPDATE mpp_direct_tasks SET paused=true,revision=revision+1 WHERE user_id IN(SELECT user_id FROM mpp_direct_agents WHERE owner_id=$1)',[this.plan.ownerAccount]);
   await db.query("UPDATE mpp_direct_p2_sessions SET state=CASE WHEN state='complete' THEN state ELSE 'paused' END,generation=generation+1,writer_until_ms=0 WHERE user_id IN(SELECT user_id FROM mpp_direct_agents WHERE owner_id=$1)",[this.plan.ownerAccount]);
   await db.query('COMMIT');return {revoked:true};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async logout(token){await this.pool.query('UPDATE mpp_direct_p3_sessions SET active=false WHERE token_hash=$1',[hash(token??'')]);}
}
