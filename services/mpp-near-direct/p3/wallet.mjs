import { hash, signedPayload, requireThat, challengeIdentity, nativePlan } from '../contract.mjs';
import { verifyBinding } from '../near.mjs';
import { uuid, publicKey, signatureBase64, WalletError } from './outlayer.mjs';
import { verifyAgentPaymentFee, verifyAgentPaidTransfer } from './outlayer-native-verification.mjs';

const safeError = e => /^[a-z][a-z0-9_]{0,95}$/.test(e?.message) ? e.message : 'wallet_operation_unknown';
export class Wallet {
  constructor({store,api,rpc,authorize,policy,now=Date.now}) { Object.assign(this,{store,api,rpc,authorize,policy,now}); }
  async prepare({challenge,binding,gasReserveYocto,gasFloorYocto,nanoUsdPerNear,taskId,userId,kind='payment'},db) {
    const transfer=nativePlan(challenge,binding).transfer;
    requireThat(binding.network===this.rpc.network && binding.walletId && binding.credentialRef && binding.policy,'outlayer_binding_required');
    requireThat(!Object.keys(binding).some(k=>/apiKey|secret|grantToken|privateKey/i.test(k)),'private_binding_field');
    const frozen={kind,challenge,binding,transfer,gasReserveYocto,gasFloorYocto,nanoUsdPerNear,taskId,userId};
    const id=(kind==='refund'?'near-refund-v1-':'near-pay-v1-')+challenge.request.orderRef;
    return this.store.create({id,orderRef:challenge.request.orderRef,frozen,fingerprint:hash(frozen),state:'prepared',
      requestId:null,txHash:null,attempts:0,credential:null,proof:null,feeProof:null,lastError:null,createdMs:this.now()},db);
  }
  async cancel(id) {
    return this.store.lock(id,async j=>{
      let row=await j.get();
      if(row.state==='prepared') {row={...row,state:'cancelled'};await j.save(row);}
      return {operationKey:id,orderRef:row.orderRef,knownUnsent:row.state==='cancelled'};
    });
  }
  async status(row,result,j) {
    if(uuid(result.request_id)) {
      requireThat(!row.requestId||row.requestId===result.request_id,'request_identity_conflict');
      row={...row,requestId:result.request_id}; await j.save(row);
    }
    const tx=result.tx_hash??result.result?.tx_hash;
    if(tx) {
      requireThat(!row.txHash||row.txHash===tx,'transaction_identity_conflict');
      row={...row,txHash:tx};await j.save(row);
    }
    if(result.type)requireThat(result.type==='transfer','wallet_operation_type_conflict');
    if(result.result?.signer_id)requireThat(result.result.signer_id===row.frozen.binding.payer,'wallet_signer_conflict');
    const state=result.status;
    requireThat(['success','processing','failed','needs_review','pending_approval','approved'].includes(state),'unrecognized_wallet_status');
    row={...row,providerStatus:state,state:['needs_review','pending_approval','approved'].includes(state)?'review':'unknown'};
    if(!row.txHash && !row.requestId)row.state='review';
    await j.save(row); return row;
  }
  async recover(id) {
    return this.store.lock(id,async j=>{
      let row=await j.get();
      if(['final','cancelled','review'].includes(row.state))return row;
      const {binding,challenge,transfer,kind}=row.frozen;
      try {
        requireThat(row.fingerprint===hash(row.frozen) && challengeIdentity(challenge), 'original_operation_corrupted');
        if(row.state==='prepared') {
          requireThat(kind==='refund'||this.now()<challenge.request.expiresAtMs,'new_payment_window_closed');
          await this.policy(binding);
          row=await j.begin(this.authorize);
          // Exactly one dispatch. Native upstream same-key retries are NOT
          // assumed safe: a missing ACK remains Unknown without another POST.
          try {row=await this.status(row,await this.api.transfer(binding,transfer,row.id),j);}
          catch(error) {
            if(error instanceof WalletError && (error.requestId||error.txHash))row=await this.status(row,{request_id:error.requestId,tx_hash:error.txHash,status:'failed'},j);
            else if(error instanceof WalletError && error.definiteRefusal) {row={...row,state:'cancelled',lastError:safeError(error)};await j.save(row);return row;}
            else throw error;
          }
        } else if(!row.txHash && row.requestId)row=await this.status(row,await this.api.status(binding,row.requestId),j);
        else if(!row.txHash) {row={...row,state:'review',lastError:'original_ack_missing_no_automatic_resend'};await j.save(row);return row;}
        if(row.state==='review'||!row.txHash)return row;
        if(!row.feeProof) {
          const feeProof=await verifyAgentPaymentFee({challenge,txHash:row.txHash,publicKey:binding.publicKey,rpc:this.rpc});
          row={...row,feeProof,gasOverrun:BigInt(feeProof.gasActualYocto)>BigInt(row.frozen.gasReserveYocto)};await j.save(row);
        }
        if(!row.proof) {
          const proof=await verifyAgentPaidTransfer({challenge,txHash:row.txHash,publicKey:binding.publicKey,rpc:this.rpc});
          requireThat(proof.gasActualYocto===row.feeProof.gasActualYocto,'fee_snapshot_conflict');
          row={...row,state:'paid',proof};await j.save(row);
        }
        if(kind==='refund') {row={...row,state:'final',lastError:null};await j.save(row);return row;}
        const payload=signedPayload(challenge,row.txHash),signature=await this.api.sign(binding,payload);
        requireThat(signature.account_id===binding.payer && publicKey(signature.public_key).base58===binding.publicKey
          && signature.nonce===payload.nonce,'wallet_signature_binding_mismatch');
        const credential={challenge,payload:{txHash:row.txHash,publicKey:binding.publicKey,signature:signatureBase64(signature.signature)}};
        verifyBinding(challenge,credential.payload);
        row={...row,state:'final',credential,lastError:null};await j.save(row);return row;
      } catch(error) {
        row={...await j.get(),lastError:safeError(error)};
        if(/conflict|corrupted|unrecognized/.test(row.lastError))row.state='review';
        await j.save(row);return row;
      }
    });
  }
}
