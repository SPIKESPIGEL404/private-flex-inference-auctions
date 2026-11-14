import {execFileSync,spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,stat,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {hash,requireThat} from '../contract.mjs';
import {completion} from '../p1/server.mjs';

const errorCode=e=>/^[a-z_]+$/.test(e.message)?e.message:'original_native_profile_unknown';
export class NativeProfiles {
 constructor({config,fetcher=fetch}){Object.assign(this,{config,fetcher});this.plan=config.plan;this.children=new Map();this.active=new Set();this.controllers=new Set();this.closing=false;}
 attach({pool,auth}){Object.assign(this,{pool,auth});}
 environment(state,dir){
  const name=this.plan.provider.credentialEnvironment;
  requireThat(/^[A-Z][A-Z0-9_]{0,95}$/.test(name)&&typeof process.env[name]==='string'&&process.env[name].length>0,'provider_credential_required');
  return {PATH:process.env.PATH,DATABASE_URL:state.database,REDIS_URL:state.redis,BITROUTER_PREVIEW_BOOTSTRAP_BINDING:state.binding,
   REDIS_BALANCE_CUTOVER_TOKEN:state.cutover,PRIVATE_MARKET_SELLER_KEY:process.env[name],PRIVATE_MARKET_AGENT_P3:'bounded',
   PRIVATE_MARKET_LISTEN:'127.0.0.1:0',INFERENCE_MARKET_CONFIG_PATH:resolve(dir,'catalog.json'),PRIVATE_MARKET_P3_PARENT_PIPE:'1',
   ...(this.config.mode==='qualification-test'?{PRIVATE_MARKET_P3_DIAGNOSTICS:'controlled'}:{}),};
 }
 command(args,state,dir){
  try{return JSON.parse(execFileSync(this.config.hostBinary,args,{env:this.environment(state,dir),encoding:'utf8',timeout:30000,maxBuffer:1024*1024,stdio:['pipe','pipe','pipe']}));}
  catch(error){if(this.config.mode==='qualification-test')process.stderr.write(String(error.stderr??''));throw new Error('original_native_supply_command_unknown');}
 }
 qualify(body){
  requireThat(!this.closing,'native_source_stopping');
  const job=this.run(body);this.active.add(job);job.finally(()=>this.active.delete(job)).catch(()=>{});return job;
 }
 async run(body){
  await this.auth.requireGrant(this.plan.ownerAccount);await this.auth.requireGrant(this.plan.projectAccount,'project');
  requireThat(Date.now()<this.plan.limits.deadlineMs,'run_expired');
  const p=this.plan.provider,base=resolve(this.config.nativeStateDirectory),root=JSON.parse(await readFile(base+'/registration.json','utf8')),state=JSON.parse(await readFile(base+'/state.json','utf8'));
  requireThat(state.database===this.config.databaseUrl&&root.model===p.model&&root.origin===p.origin&&root.tokenizer_ref===p.tokenizerRef
   &&(p.modelRevisionRef===undefined||root.model_revision_ref===p.modelRevisionRef)&&root.max_output_tokens===this.plan.limits.maxOutputTokens
   &&root.context_window_tokens===p.contextWindowTokens&&hash(root.tokenizer_files_sha256)===hash(p.tokenizerFilesSha256)&&hash(root.rates)===hash(p.rates),'original_provider_registration_mismatch');
  const u=new URL(p.tokenizerUrl);requireThat(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.pathname==='/tokenize','qualified_local_tokenizer_required');
  const {background,bitrouter_delivery,...native}=body;
  const response=await this.fetcher(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({protocol:'chat_completions',tokenizer_ref:p.tokenizerRef,model:p.model,request:native}),redirect:'error',signal:AbortSignal.timeout(10000)});
  requireThat(response.ok,'native_tokenizer_unavailable');const tokens=await response.json();
  requireThat(tokens.tokenizer_ref===p.tokenizerRef&&Array.isArray(tokens.token_ids)&&tokens.token_ids.length>0&&tokens.token_ids.length<=8192
   &&tokens.token_ids.every(t=>Number.isInteger(t)&&t>=0&&t<=0xffffffff),'native_tokenizer_scope_invalid');
  const id=hash(body),callId=String(body.user??'').slice(3),directory=resolve(this.config.nativeProfilesDirectory,id);
  requireThat(/^[a-f0-9]{64}$/.test(callId),'original_native_call_required');
  await mkdir(resolve(this.config.nativeProfilesDirectory),{recursive:true,mode:0o700});
  requireThat(((await stat(this.config.nativeProfilesDirectory)).mode&0o077)===0,'private_profile_directory_required');
  await this.pool.query("INSERT INTO mpp_direct_p3_profiles(id,body_hash,registration,state,directory,created_ms,call_id) VALUES($1,$2,'{}','queued',$3,$4,$5) ON CONFLICT(id) DO NOTHING",[id,hash(body),directory,Date.now(),callId]);
  const db=await this.pool.connect();let locked=false;
  try{
   locked=(await db.query('SELECT pg_try_advisory_lock(73112632071) AS locked')).rows[0].locked;requireThat(locked,'supply_unavailable');
   const slot=(await db.query('SELECT profile_id FROM mpp_direct_p3_native_slot WHERE singleton')).rows[0];
   if(slot.profile_id&&slot.profile_id!==id){
    const prior=(await db.query('SELECT * FROM mpp_direct_p3_profiles WHERE id=$1',[slot.profile_id])).rows[0];
    const blocked=(await db.query(`SELECT 1 FROM mpp_direct_orders WHERE decision->'quote'->>'profileId'=$1
      AND financial IS NULL AND state NOT IN('refunded','settled') AND NOT(state='cancelled' AND EXISTS(
        SELECT 1 FROM mpp_direct_sponsor_operations s WHERE s.id=sponsor_operation AND s.state='never_sent'))`,[prior.id])).rowCount;
    const call=(await db.query('SELECT * FROM mpp_direct_p2_calls WHERE id=$1',[prior.call_id])).rows[0];
    const orders=(await db.query("SELECT 1 FROM mpp_direct_orders WHERE decision->'quote'->>'profileId'=$1",[prior.id])).rowCount;
    requireThat(prior.state==='qualified'&&!blocked&&(orders||['cancelled','stopped','terminal'].includes(call.state)||Date.now()>=Number(call.deadline_ms)),'supply_unavailable');
   }
   await db.query('UPDATE mpp_direct_p3_native_slot SET profile_id=$1 WHERE singleton',[id]);
   let row=(await db.query('SELECT * FROM mpp_direct_p3_profiles WHERE id=$1',[id])).rows[0];
   requireThat(row.slot<=32,'bounded_profile_slots_exhausted');
   if(row.state==='qualified'){await this.startHost(row,state);return row.quote;}
   await this.stopHosts();
   const reg={...root,token_ids:tokens.token_ids,max_output_tokens:body.max_completion_tokens,request_sha256:hash(JSON.stringify(native)),
    root_request_sha256:root.request_sha256,profile_slot:999+Number(row.slot),offer_valid_until_ms:this.plan.limits.deadlineMs};
   if(row.state==='queued'){
    const file=resolve(this.config.nativeProfilesDirectory,id+'.registration.json');await writeFile(file,JSON.stringify(reg),{mode:0o600});
    await db.query("UPDATE mpp_direct_p3_profiles SET state='registering',registration=$2 WHERE id=$1",[id,reg]);
    this.command(['register-profile-p3',base,directory,file],state,directory);
    await db.query("UPDATE mpp_direct_p3_profiles SET state='registered' WHERE id=$1",[id]);row={...row,state:'registered',registration:reg};
   }else if(row.state==='registering'){
    const saved=JSON.parse(await readFile(directory+'/state.json','utf8'));requireThat(saved.registration_sha256,'original_supply_registration_unknown');
    await db.query("UPDATE mpp_direct_p3_profiles SET state='registered' WHERE id=$1",[id]);row={...row,state:'registered'};
   }
   requireThat(['registered','calibrating'].includes(row.state),'original_profile_outcome_unknown');
   const quote=this.commandQuote(body,tokens.token_ids,state,directory);
   let measured;
   if(row.state==='registered')measured=await this.calibrate(id,native,quote,state,directory,db);
   else{
    const original=(await db.query('SELECT * FROM mpp_direct_p3_provider_ops WHERE id=$1',[id])).rows[0];
    requireThat(original?.state==='final'&&original.usage?.measurement,'original_calibration_unknown');measured=original.usage.measurement;
   }
   const regBytes=await readFile(directory+'/registration.json');
   measured={...measured,registration_sha256:hash(regBytes.toString()),request_sha256:reg.request_sha256,response_file:directory+'/calibration.sse'};
   await writeFile(directory+'/measurement.json',JSON.stringify(measured),{mode:0o600});
   try{await stat(directory+'/catalog.json');}
   catch{this.command(['qualify-live',directory,directory+'/measurement.json'],state,directory);}
   const result={...quote,profileId:id,forecast:{source:'measured-native-provider',observedMs:measured.ended_at_ms,
    usableMs:measured.ended_at_ms-measured.started_at_ms,sampleRequests:1,inputTokens:tokens.token_ids.length,maxOutputTokens:body.max_completion_tokens},expected_service_micro:quote.total_micro};
   await db.query("UPDATE mpp_direct_p3_profiles SET state='qualified',quote=$2,measurement=$3,last_error=NULL WHERE id=$1",[id,result,measured]);
   await this.startHost({...row,directory},state);return result;
  }catch(e){
   if(locked&&e.message!=='supply_unavailable')await db.query("UPDATE mpp_direct_p3_profiles SET state=CASE WHEN state='qualified' THEN state ELSE 'unknown' END,last_error=$2 WHERE id=$1",[id,errorCode(e)]).catch(()=>{});
   throw new Error(errorCode(e));
  }finally{if(locked)await db.query('SELECT pg_advisory_unlock(73112632071)').catch(()=>{});db.release();}
 }
 commandQuote(body,ids,state,dir){
  try{return JSON.parse(execFileSync(this.config.hostBinary,['quote-native-p3','-'],{input:JSON.stringify({body,token_ids:ids,rates:this.plan.provider.rates}),env:this.environment(state,dir),encoding:'utf8',timeout:15000,maxBuffer:1024*1024}));}
  catch{throw new Error('native_price_scope_unqualified');}
 }
 async calibrate(id,body,quote,state,dir,db){
  await db.query('BEGIN');
  try{
   await this.auth.requireGrant(this.plan.projectAccount,'project',db);
   const budget=(await db.query('SELECT * FROM mpp_direct_p3_provider_budget WHERE singleton FOR UPDATE')).rows[0];
   requireThat(budget&&budget.calls<budget.maximum_calls&&BigInt(budget.spent_micro)+BigInt(budget.reserved_micro)+BigInt(quote.provider_micro)<=BigInt(budget.maximum_micro),'provider_calibration_allowance_exhausted');
   await db.query("INSERT INTO mpp_direct_p3_provider_ops VALUES($1,$2,$3,'sending',NULL,NULL,NULL,$4)",[id,hash(body),quote.provider_micro,Date.now()]);
   await db.query('UPDATE mpp_direct_p3_provider_budget SET reserved_micro=reserved_micro+$1,calls=calls+1 WHERE singleton',[quote.provider_micro]);
   await db.query("UPDATE mpp_direct_p3_profiles SET state='calibrating' WHERE id=$1",[id]);await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
  const controller=new AbortController();this.controllers.add(controller);const timer=setTimeout(()=>controller.abort(),90000),started=Date.now();
  try{
   const name=this.plan.provider.credentialEnvironment,origin=this.plan.provider.origin;
   requireThat(new URL(origin).protocol==='https:'||(this.config.mode==='qualification-test'&&new URL(origin).protocol==='http:'&&new URL(origin).hostname==='127.0.0.1'),'https_provider_required');
   const response=await this.fetcher(origin.replace(/\/$/,'')+'/v1/chat/completions',{method:'POST',redirect:'error',headers:{'content-type':'application/json','authorization':'Bearer '+process.env[name]},body:JSON.stringify(body),signal:controller.signal});
   requireThat(response.ok&&response.body,'calibration_http_unknown');
   const chunks=[];let n=0;for await(const part of response.body){n+=part.length;requireThat(n<=2*1024*1024,'calibration_response_limit_unknown');chunks.push(part);}
   const raw=Buffer.concat(chunks).toString('utf8'),native=completion(raw),usage=native.usage,end=Math.max(Date.now(),started+1);
   requireThat(native.model===this.plan.provider.model&&Number.isSafeInteger(usage?.prompt_tokens)&&Number.isSafeInteger(usage?.completion_tokens)
    &&usage.prompt_tokens===quote.input_tokens&&usage.completion_tokens>0&&usage.completion_tokens<=this.plan.limits.maxOutputTokens
    &&usage.total_tokens===usage.prompt_tokens+usage.completion_tokens,'calibration_usage_unknown');
   const choice=native.choices[0];requireThat(['stop','length','tool_calls'].includes(choice.finish_reason),'calibration_terminal_unknown');
   if(choice.finish_reason==='tool_calls')requireThat(choice.message.tool_calls?.length===1,'calibration_tool_contract_unknown');
   if(choice.finish_reason==='tool_calls')for(const call of choice.message.tool_calls??[]){const args=JSON.parse(call.function.arguments);requireThat(call.function.name==='bash'&&typeof args.command==='string'&&Object.keys(args).length===1,'calibration_tool_contract_unknown');}
   const r=this.plan.provider.rates,inputRate=Math.max(r.input,r.cache_input),amount=(BigInt(usage.prompt_tokens)*BigInt(inputRate)+BigInt(usage.completion_tokens)*BigInt(r.output)+999999n)/1000000n;
   requireThat(amount<=BigInt(quote.provider_micro),'calibration_price_overrun_unknown');
   const measured={started_at_ms:started,ended_at_ms:end,prompt_tokens:usage.prompt_tokens,completion_tokens:usage.completion_tokens,total_tokens:usage.total_tokens,response_model:native.model,finish_reason:choice.finish_reason,response_sha256:hash(raw)};
   await writeFile(dir+'/calibration.sse',raw,{mode:0o600});
   await db.query('BEGIN');try{
    await db.query("UPDATE mpp_direct_p3_provider_ops SET state='final',response=$2,usage=$3,actual_micro=$4 WHERE id=$1",[id,raw,{...usage,measurement:measured},String(amount)]);
    await db.query('UPDATE mpp_direct_p3_provider_budget SET reserved_micro=reserved_micro-$1,spent_micro=spent_micro+$2 WHERE singleton',[quote.provider_micro,String(amount)]);await db.query('COMMIT');
   }catch(e){await db.query('ROLLBACK');throw e;}
   return measured;
  }catch(e){await db.query("UPDATE mpp_direct_p3_provider_ops SET state='unknown' WHERE id=$1 AND state<>'final'",[id]);throw new Error(errorCode(e));}
  finally{clearTimeout(timer);this.controllers.delete(controller);}
 }
 async startHost(row,state){
  if(this.children.has(row.id)){const current=this.children.get(row.id);if(current.child.exitCode===null&&current.child.signalCode===null)return current.url;this.children.delete(row.id);}
  requireThat(!this.closing,'native_source_stopping');
  const log=await open(row.directory+'/host.log','a',0o600),child=spawn(this.config.hostBinary,['serve',row.directory],{env:this.environment(state,row.directory),stdio:['pipe','pipe',log.fd]});
  await log.close();
  const url=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>{child.stdin.end();reject(new Error('native_host_start_unknown'));},75000);
   child.on('error',()=>{clearTimeout(timer);reject(new Error('native_host_start_unknown'));});child.on('exit',()=>{clearTimeout(timer);reject(new Error('native_host_start_unknown'));});
   child.stdout.on('data',b=>{text+=b;for(const line of text.split('\n'))try{const parsed=JSON.parse(line);if(parsed.url){clearTimeout(timer);resolve(parsed.url);}}catch{}});
  });
  requireThat(new URL(url).hostname==='127.0.0.1','native_host_must_be_private');this.children.set(row.id,{child,url});return url;
 }
 async restore(){
  const current=(await this.pool.query('SELECT p.* FROM mpp_direct_p3_native_slot s JOIN mpp_direct_p3_profiles p ON p.id=s.profile_id WHERE singleton')).rows[0];
  if(current?.state==='qualified'){
   const state=JSON.parse(await readFile(resolve(this.config.nativeStateDirectory,'state.json'),'utf8'));
   requireThat(state.database===this.config.databaseUrl,'original_provider_registration_mismatch');
   await this.startHost(current,state);
  }
 }
 async origin(profileId){
  const current=(await this.pool.query('SELECT p.* FROM mpp_direct_p3_native_slot s JOIN mpp_direct_p3_profiles p ON p.id=s.profile_id WHERE singleton')).rows[0];
  requireThat(current?.state==='qualified'&&current.id===profileId,'original_native_profile_unavailable');
  const state=JSON.parse(await readFile(resolve(this.config.nativeStateDirectory,'state.json'),'utf8'));
  return this.startHost(current,state);
 }
 async stopHosts(){for(const {child} of this.children.values()){
  await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null){r();return;}
   let done=false;const finish=()=>{if(!done){done=true;clearTimeout(timer);r();}};
   const timer=setTimeout(()=>{child.kill('SIGKILL');setTimeout(finish,1000);},15000);child.once('exit',finish);child.stdin.end();
  });
 }this.children.clear();}
 async close(){this.closing=true;for(const c of this.controllers)c.abort();await Promise.allSettled([...this.active]);await this.stopHosts();}
}
