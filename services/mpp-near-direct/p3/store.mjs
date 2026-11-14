import { hash, requireThat, nanoUsdForNear } from '../contract.mjs';

export class OperationStore {
  constructor(pool) { this.pool = pool; }
  async create(row, db = this.pool) {
    requireThat(row.fingerprint === hash(row.frozen), 'operation_fingerprint_mismatch');
    await db.query(`INSERT INTO mpp_direct_p3_operations(id,order_ref,kind,user_id,task_id,payer,frozen,fingerprint,state,document)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
    [row.id,row.orderRef,row.frozen.kind,row.frozen.userId,row.frozen.taskId,row.frozen.binding.payer,row.frozen,row.fingerprint,row.state,row]);
    const old = (await db.query('SELECT document FROM mpp_direct_p3_operations WHERE id=$1',[row.id])).rows[0]?.document;
    requireThat(old?.fingerprint === row.fingerprint, 'original_operation_conflict');
    return old;
  }
  async get(id) { return (await this.pool.query('SELECT document FROM mpp_direct_p3_operations WHERE id=$1',[id])).rows[0]?.document; }
  async lock(id, action) {
    const db = await this.pool.connect(); let locked = false, broken = false, payer;
    const fail = () => { broken = true; }; db.on('error',fail);
    try {
      const first = (await db.query('SELECT payer FROM mpp_direct_p3_operations WHERE id=$1',[id])).rows[0];
      requireThat(first, 'unknown_original_operation'); payer=first.payer;
      // Serialize ALL operations for a sender across processes. A returned
      // Unknown also leaves a durable partial unique index slot occupied.
      await db.query("SELECT pg_advisory_lock(hashtextextended('outlayer-sender:' || $1,0))",[first.payer]); locked = true;
      const get = async () => (await db.query('SELECT document FROM mpp_direct_p3_operations WHERE id=$1',[id])).rows[0]?.document;
      const write = async row => {
        requireThat(row.id === id && row.fingerprint === hash(row.frozen), 'original_operation_corrupted');
        const result = await db.query(`UPDATE mpp_direct_p3_operations SET state=$2,request_id=$3,tx_hash=$4,actual_gas_yocto=$5,document=$6
          WHERE id=$1 AND fingerprint=$7`,[id,row.state,row.requestId,row.txHash,row.feeProof?.gasActualYocto??null,row,row.fingerprint]);
        requireThat(result.rowCount === 1, 'original_operation_conflict');
      };
      const fenced = async fn => {
        await db.query('BEGIN');
        try {
          const row = await get();
          await db.query('SELECT pg_advisory_xact_lock(public.balance_cache_advisory_key($1))',[row.frozen.userId]);
          const result = await fn(row); await db.query('COMMIT'); return result;
        } catch(error) { await db.query('ROLLBACK').catch(()=>{}); throw error; }
      };
      return await action({get,save:row=>fenced(()=>write(row)),begin:authorize=>fenced(async row=>{
        requireThat(row.state === 'prepared' && row.attempts === 0 && !row.requestId && !row.txHash,'original_dispatch_closed');
        await authorize(row.frozen,{db});
        const sending = {...row,state:'sending',attempts:1}; await write(sending); return sending;
      })});
    } finally {
      if (locked && !broken) try { await db.query("SELECT pg_advisory_unlock(hashtextextended('outlayer-sender:' || $1,0))",[payer]); }
      catch { broken = true; }
      db.removeListener('error',fail); db.release(broken);
    }
  }
  async gas({userId,taskId},db=this.pool) {
    const rows=(await db.query(`SELECT frozen,state,actual_gas_yocto::text FROM mpp_direct_p3_operations
      WHERE kind='payment' AND user_id=$1 AND ($2::text IS NULL OR task_id=$2)`,[userId,taskId??null])).rows;
    let actual=0n,reserved=0n,yocto=0n;
    for(const r of rows) {
      if(r.actual_gas_yocto!=null) {actual+=nanoUsdForNear(r.actual_gas_yocto,r.frozen.nanoUsdPerNear);}
      else if(r.state!=='cancelled') {reserved+=nanoUsdForNear(r.frozen.gasReserveYocto,r.frozen.nanoUsdPerNear);yocto+=BigInt(r.frozen.gasReserveYocto);}
    }
    return {actualNano:actual,reservedNano:reserved,reservedYocto:yocto};
  }
}
