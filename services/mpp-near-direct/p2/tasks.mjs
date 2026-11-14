import {Bash} from 'just-bash';
import {randomUUID} from 'node:crypto';
import {hash,requireThat} from '../contract.mjs';
import {completion} from '../p1/server.mjs';
const now=async db=>Number((await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n')).rows[0].n);
export class Tasks{
 constructor(authority){this.a=authority;this.pool=authority.pool;}
 async owner(token){const row=(await this.pool.query('SELECT owner_id FROM mpp_direct_p2_owners WHERE token_hash=$1',[hash(token)])).rows[0];requireThat(row,'unauthorized');return row.owner_id;}
 async session(owner,id,db=this.pool,lock=''){
  const row=(await db.query(`SELECT s.*,a.owner_id,a.agent_id,a.active AS agent_active FROM mpp_direct_p2_sessions s JOIN mpp_direct_agents a ON a.user_id=s.user_id WHERE s.id=$1 AND a.owner_id=$2 ${lock}`,[id,owner])).rows[0];
  requireThat(row,'unknown_session');return row;
 }
 guard(s,writer,generation,at){requireThat(s.writer_hash===hash(writer??'')&&String(s.generation)===String(generation)&&Number(s.writer_until_ms)>at,'writer_fenced');}
 async list(owner){return (await this.pool.query(`SELECT a.agent_id,a.payer,s.id,s.state,s.generation,s.task_id,s.prompt,s.workspace_version,s.result,
  t.budget_nano,t.reserved_nano,t.spent_nano,t.deadline_ms,t.preference,t.paused,t.revision FROM mpp_direct_agents a
  JOIN mpp_direct_p2_sessions s ON s.user_id=a.user_id JOIN mpp_direct_tasks t ON t.id=s.task_id WHERE a.owner_id=$1 ORDER BY a.agent_id,s.id`,[owner])).rows;}
 async create(owner,agentId,input){
  requireThat(typeof input.prompt==='string'&&input.prompt.trim().length>0&&input.prompt.length<=1000&&/^[1-9][0-9]{0,12}$/.test(input.budgetNano)
   &&['save','balanced','fast'].includes(input.preference),'invalid_task');
  const agent=(await this.pool.query('SELECT * FROM mpp_direct_agents WHERE owner_id=$1 AND agent_id=$2 AND active',[owner,agentId])).rows[0];requireThat(agent,'unknown_agent');
  return this.a.transaction(agent.user_id,async db=>{
   const count=Number((await db.query('SELECT count(*) FROM mpp_direct_tasks WHERE user_id=$1',[agent.user_id])).rows[0].count);requireThat(count<2,'task_count_limit');
   const limit=(await db.query('SELECT * FROM mpp_direct_p2_agent_limits WHERE user_id=$1 FOR UPDATE',[agent.user_id])).rows[0];requireThat(BigInt(input.budgetNano)<=BigInt(limit.budget_nano),'agent_budget_limit');
   const original=(await db.query('SELECT workspace FROM mpp_direct_p2_sessions WHERE user_id=$1 ORDER BY created_ms LIMIT 1',[agent.user_id])).rows[0];
   const id=randomUUID(),task='task-'+id,at=await now(db),workspace={'/workspace/task.txt':input.prompt,'/workspace/numbers.txt':original.workspace['/workspace/numbers.txt']};
   await db.query('INSERT INTO mpp_direct_tasks(id,user_id,budget_nano,hard_bid_nano,call_cap_nano,deadline_ms,preference) VALUES($1,$2,$3,3000000,3000000,$4,$5)',[task,agent.user_id,input.budgetNano,at+180000,input.preference]);
   await db.query('INSERT INTO mpp_direct_p2_sessions(id,user_id,task_id,prompt,workspace,created_ms) VALUES($1,$2,$3,$4,$5,$6)',[id,agent.user_id,task,input.prompt,workspace,at]);
   return {id,taskId:task};
  });
 }
 async claim(owner,id,input){
  const first=await this.session(owner,id);requireThat(/^[a-f0-9]{64}$/.test(input.writer),'invalid_writer');
  return this.a.transaction(first.user_id,async db=>{
   const s=await this.session(owner,id,db,'FOR UPDATE OF s');const at=await now(db);
   if(s.writer_hash===hash(input.writer)&&Number(s.writer_until_ms)>at)return {generation:s.generation,state:s.state};
   requireThat(String(input.expectedGeneration)===String(s.generation),'revision_conflict');
   requireThat(input.force===true||Number(s.writer_until_ms)<=at,'writer_busy');
   const task=(await db.query('SELECT * FROM mpp_direct_tasks WHERE id=$1 FOR UPDATE',[s.task_id])).rows[0];
   requireThat(task.active&&!task.paused&&s.agent_active&&at<Number(task.deadline_ms),'task_not_running');
   requireThat(s.state!=='complete','task_complete');
   const row=(await db.query("UPDATE mpp_direct_p2_sessions SET generation=generation+1,writer_hash=$2,writer_until_ms=$3,state='running' WHERE id=$1 RETURNING generation,state",[id,hash(input.writer),at+10000])).rows[0];
   return row;
  });
 }
 async context(owner,id,writer,generation,db=this.pool,lock=''){
  const s=await this.session(owner,id,db,lock);this.guard(s,writer,generation,await now(db));return s;
 }
 async heartbeat(owner,id,w,g){const s=await this.context(owner,id,w,g);const changed=await this.pool.query('UPDATE mpp_direct_p2_sessions SET writer_until_ms=$2 WHERE id=$1 AND generation=$3 AND writer_hash=$4',[id,Date.now()+10000,g,hash(w)]);requireThat(changed.rowCount===1,'writer_fenced');return {generation:s.generation};}
 async load(owner,id,w,g){
  await this.context(owner,id,w,g);const rows=(await this.pool.query('SELECT cursor::text,data FROM mpp_direct_p2_journal WHERE session_id=$1 ORDER BY cursor',[id])).rows;
  return {journal:rows.map(r=>({cursor:r.cursor,data:r.data.toString('base64')}))};
 }
 async append(owner,id,w,g,input){
  requireThat(typeof input.data==='string'&&input.data.length<=6*1024*1024&&typeof input.idempotencyKey==='string'&&input.idempotencyKey.length<=256,'invalid_journal');
  const data=Buffer.from(input.data,'base64');requireThat(data.toString('base64')===input.data&&data.length<=4*1024*1024,'invalid_journal');
  requireThat(Array.isArray(input.marks)&&input.marks.length<=4096,'invalid_marks');const digest=hash(input.data);
  const first=await this.session(owner,id);
  return this.a.transaction(first.user_id,async db=>{
   const s=await this.context(owner,id,w,g,db,'FOR UPDATE OF s');
   const old=(await db.query('SELECT * FROM mpp_direct_p2_journal WHERE session_id=$1 AND operation=$2',[id,input.idempotencyKey])).rows[0];
   if(old){requireThat(old.digest===digest,'journal_operation_conflict');return {cursor:String(old.cursor)};}
   requireThat(String(input.expected??'0')===String(s.head),'journal_fenced');
   const size=Number((await db.query('SELECT coalesce(sum(octet_length(data)),0) AS n FROM mpp_direct_p2_journal WHERE session_id=$1',[id])).rows[0].n);
   requireThat(size+data.length<=8*1024*1024,'journal_limit');
   const cursor=BigInt(s.head)+1n;let step=Number(s.model_step),started=s.fx_started;
   for(const mark of input.marks){if(mark.start)started=true;if(typeof mark.step==='string'){const n=Number(mark.step.split(':')[0]);requireThat(Number.isInteger(n)&&n>=step&&n<=4,'invalid_model_step');step=n;}}
   await db.query('INSERT INTO mpp_direct_p2_journal VALUES($1,$2,$3,$4,$5,$6)',[id,String(cursor),input.idempotencyKey,digest,data,JSON.stringify(input.marks)]);
   await db.query('UPDATE mpp_direct_p2_sessions SET head=$2,model_step=$3,fx_started=$4 WHERE id=$1',[id,String(cursor),step,started]);
   return {cursor:String(cursor)};
  });
 }
 async tool(owner,id,w,g,input){
  requireThat(typeof input.executionId==='string'&&input.executionId.length<=256&&input.command?.length>0&&input.command.length<=4096,'invalid_tool');
  const first=await this.session(owner,id),fingerprint=hash(input.command);
  return this.a.transaction(first.user_id,async db=>{
   const s=await this.context(owner,id,w,g,db,'FOR UPDATE OF s');
   const old=(await db.query('SELECT * FROM mpp_direct_p2_tools WHERE session_id=$1 AND execution_id=$2',[id,input.executionId])).rows[0];
   if(old){requireThat(old.input_hash===fingerprint,'tool_operation_conflict');return old.result;}
   const paid=(await db.query('SELECT r.body FROM mpp_direct_p2_responses r JOIN mpp_direct_p2_calls c ON c.id=r.call_id WHERE c.session_id=$1',[id])).rows;
   const approved=paid.some(r=>{const response=r.body.trimStart().startsWith('{')?JSON.parse(r.body):completion(r.body),choice=response.choices[0];return choice.finish_reason==='tool_calls'&&choice.message.tool_calls?.some(t=>t.id===input.executionId&&t.function.name==='bash'&&JSON.parse(t.function.arguments).command===input.command);});
   requireThat(approved,'paid_tool_authorization_required');
   const t=(await db.query('SELECT * FROM mpp_direct_tasks WHERE id=$1 FOR SHARE',[s.task_id])).rows[0];
   requireThat(s.state==='running'&&s.agent_active&&t.active&&!t.paused,'task_not_running');
   // All effects are in-memory. Workspace snapshot + result become durable in
   // this single PG commit. No external command/network/real filesystem exists.
   const bash=new Bash({cwd:'/workspace',files:s.workspace,executionLimits:{maxCommandCount:200,maxLoopIterations:200,maxCallDepth:30}});
   const result=await bash.exec(input.command,{signal:AbortSignal.timeout(2000)});
   requireThat(Buffer.byteLength(result.stdout+result.stderr)<=64000,'tool_output_limit');
   const workspace={};let total=0;
   for(const path of bash.fs.getAllPaths())if(path.startsWith('/workspace/')){
    const stat=await bash.fs.stat(path);if(stat.isFile){const text=await bash.fs.readFile(path);total+=Buffer.byteLength(text);workspace[path]=text;}
   }
   requireThat(Object.keys(workspace).length<=64&&total<=256000,'workspace_limit');
   const value={stdout:result.stdout,stderr:result.stderr,exitCode:result.exitCode};
   await db.query('UPDATE mpp_direct_p2_sessions SET workspace=$2,workspace_version=workspace_version+1 WHERE id=$1',[id,workspace]);
   await db.query('INSERT INTO mpp_direct_p2_tools VALUES($1,$2,$3,$4,$5)',[id,input.executionId,fingerprint,value,String(BigInt(s.workspace_version)+1n)]);
   return value;
  });
 }
 async control(owner,kind,id,input){
  requireThat(typeof input.operation==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(input.operation),'invalid_operation');
  const first=kind==='session'?await this.session(owner,id):(await this.pool.query('SELECT c.* FROM mpp_direct_p2_calls c JOIN mpp_direct_agents a ON a.user_id=c.user_id WHERE c.id=$1 AND a.owner_id=$2',[id,owner])).rows[0];requireThat(first,'unknown_call');
  const digest=hash(JSON.stringify(input));
  return this.a.transaction(first.user_id,async db=>{
   const old=(await db.query('SELECT * FROM mpp_direct_p2_operations WHERE user_id=$1 AND operation=$2',[first.user_id,input.operation])).rows[0];
   if(old){requireThat(old.resource===kind+':'+id&&old.digest===digest,'operation_conflict');return old.result;}
   let result;
   if(kind==='session'){
    const s=await this.session(owner,id,db,'FOR UPDATE OF s');
    const task=(await db.query('SELECT * FROM mpp_direct_tasks WHERE id=$1 FOR UPDATE',[s.task_id])).rows[0];
    requireThat(String(input.expectedRevision)===String(task.revision),'revision_conflict');
    requireThat(['pause','resume','preference','budget'].includes(input.action),'invalid_control');
    if(input.action==='budget'){requireThat(/^[1-9][0-9]{0,12}$/.test(input.budgetNano),'invalid_budget');await db.query('UPDATE mpp_direct_tasks SET budget_nano=$2,revision=revision+1 WHERE id=$1',[task.id,input.budgetNano]);}
    else if(input.action==='preference'){
     requireThat(['save','balanced','fast'].includes(input.preference),'invalid_preference');await db.query('UPDATE mpp_direct_tasks SET preference=$2,revision=revision+1 WHERE id=$1',[task.id,input.preference]);
     const calls=(await db.query("UPDATE mpp_direct_p2_calls SET preference=$2,revision=revision+1 WHERE task_id=$1 AND state='bidding' RETURNING id,revision",[task.id,input.preference])).rows;
     for(const c of calls)await db.query("INSERT INTO mpp_direct_p2_revisions VALUES($1,$2,'manual',$3,$4)",[c.id,c.revision,{preference:input.preference,reason:'owner_preference'},await now(db)]);
    }
    else{
     const paused=input.action==='pause';
     await db.query('UPDATE mpp_direct_tasks SET paused=$2,revision=revision+1 WHERE id=$1',[task.id,paused]);
     await db.query("UPDATE mpp_direct_p2_sessions SET state=$2,writer_until_ms=0,generation=generation+1 WHERE id=$1",[id,paused?'paused':'ready']);
    }
    result={revision:String(BigInt(task.revision)+1n),action:input.action};
   }else{
    const c=(await db.query('SELECT * FROM mpp_direct_p2_calls WHERE id=$1 FOR UPDATE',[id])).rows[0];
    const task=(await db.query('SELECT * FROM mpp_direct_tasks WHERE id=$1 FOR SHARE',[c.task_id])).rows[0];
    requireThat(String(input.expectedRevision)===String(c.revision),'revision_conflict');
    requireThat(['revise_bid','resume_auto','cancel'].includes(input.action),'invalid_control');
    requireThat(c.state==='bidding'||(input.action==='cancel'&&c.state==='quoted'),'bid_already_frozen');
    let bid=c.bid_nano,manual=c.manual;
    if(input.action==='revise_bid'){requireThat(/^[1-9][0-9]{0,12}$/.test(input.bidNano)&&BigInt(input.bidNano)<=BigInt(task.hard_bid_nano),'bid_outside_authorization');bid=input.bidNano;manual=true;}
    if(input.action==='resume_auto')manual=false;
    result={callId:id,revision:String(BigInt(c.revision)+1n),action:input.action,bidNano:bid,manual};
    await db.query("UPDATE mpp_direct_p2_calls SET revision=revision+1,bid_nano=$2,manual=$3,state=CASE WHEN $4 THEN 'cancelled' ELSE state END WHERE id=$1",[id,bid,manual,input.action==='cancel']);
    await db.query("INSERT INTO mpp_direct_p2_revisions VALUES($1,$2,'manual',$3,$4)",[id,result.revision,result,await now(db)]);
   }
   await db.query('INSERT INTO mpp_direct_p2_operations VALUES($1,$2,$3,$4,$5)',[first.user_id,input.operation,kind+':'+id,digest,result]);return result;
  });
 }
 async finish(owner,id,w,g,result){const s=await this.context(owner,id,w,g);requireThat(JSON.stringify(result).length<=64000,'result_limit');
  const changed=await this.pool.query("UPDATE mpp_direct_p2_sessions SET state=$2,result=$3,writer_until_ms=0 WHERE id=$1 AND generation=$4 AND writer_hash=$5",[id,result.stopReason==='end_turn'?'complete':'error',result,g,hash(w)]);requireThat(changed.rowCount===1,'writer_fenced');return {saved:true};}
 async status(owner,id){
  const s=await this.session(owner,id);const task=(await this.pool.query('SELECT * FROM mpp_direct_tasks WHERE id=$1',[s.task_id])).rows[0];
  const calls=(await this.pool.query('SELECT id,state,revision,bid_nano,manual,started_ms,deadline_ms,decision,order_id FROM mpp_direct_p2_calls WHERE session_id=$1 ORDER BY started_ms,id',[id])).rows;
  const orders=[];for(const c of calls)if(c.order_id)orders.push(this.a.view(await this.a.getOrder(c.order_id,s.user_id)));
  // Reconstruct display from paid responses and committed tool receipts. Reading
  // a pane never starts fx, buys inference, or reapplies a tool.
  const responses=(await this.pool.query('SELECT r.body FROM mpp_direct_p2_responses r JOIN mpp_direct_p2_calls c ON c.id=r.call_id WHERE c.session_id=$1 ORDER BY c.progress_version,c.id',[id])).rows;
  const tools=(await this.pool.query('SELECT execution_id,result FROM mpp_direct_p2_tools WHERE session_id=$1',[id])).rows;
  let transcript='> '+s.prompt+'\n';
  for(const r of responses){const native=r.body.trimStart().startsWith('{')?JSON.parse(r.body):completion(r.body),message=native.choices[0].message;
   if(message.content)transcript+=message.content+'\n';
   for(const t of message.tool_calls??[]){transcript+='[bash] '+JSON.parse(t.function.arguments).command+'\n';const tool=tools.find(x=>x.execution_id===t.id);if(tool)transcript+=tool.result.stdout+tool.result.stderr+'[exit '+tool.result.exitCode+']\n';}
  }
  if(s.result)transcript+='['+s.result.stopReason+']\n';
  return {id:s.id,state:s.state,generation:s.generation,fxStarted:s.fx_started,task,workspace:s.workspace,workspaceVersion:s.workspace_version,result:s.result,calls,orders,transcript};
 }
}
