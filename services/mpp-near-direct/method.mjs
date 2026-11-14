import { Method, Credential, Receipt } from 'mppx';
import { nearDirect, payloadSchema, challengeIdentity, requireThat, METHOD } from './contract.mjs';
import { verifyPayment } from './near.mjs';

// The client presents an ALREADY persisted original payment. Automatic payment
// on 402/retry is deliberately outside the method, in the durable executor.
export function clientMethod({ recoverPayment }) {
  return Method.toClient(nearDirect, { async createCredential({ challenge }) {
    const original = await recoverPayment(challenge);
    requireThat(challengeIdentity(original.challenge) === challengeIdentity(challenge), 'original_payment_required');
    payloadSchema.parse(original.payload);
    return Credential.serialize(original);
  } });
}

export function serverMethod({ rpc, authority, verify = verifyPayment }) {
  // No default in-memory Store: consumption and ledger/purpose/admission must
  // be integrated by ONE owning authority. This is an explicit P1 seam.
  for (const name of ['loadChallenge', 'journalPresentation', 'consumeVerifiedPayment'])
    requireThat(typeof authority?.[name] === 'function', `missing_authority_${name}`);
  return Method.toServer(nearDirect, { async verify({ credential }) {
    const expectedChallenge = await authority.loadChallenge(credential.challenge.id);
    requireThat(expectedChallenge, 'unknown_challenge');
    await authority.journalPresentation(credential); // commit BEFORE RPC work
    const verified = await verify({ credential, expectedChallenge, rpc });
    const result = await authority.consumeVerifiedPayment(verified);
    // Must atomically consume canonical movement globally and bind original
    // ledger/outbox/order-purpose. A successful proof alone cannot dispatch.
    requireThat(result?.committed === true && result?.projectionReady === true
      && result.orderRef === verified.orderRef && verified.late === false, 'payment_not_admissible');
    return Receipt.from({ method: METHOD, status: 'success', reference: verified.movementKey,
      timestamp: new Date(verified.paidAtMs).toISOString() });
  } });
}
