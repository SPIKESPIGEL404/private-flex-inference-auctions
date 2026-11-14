// Read-only chain/financial audit. No wallets, private keys, inference calls or
// broadcasts. Model attestation/signature verification was performed by the SDK
// during capture; this audit does not claim to repeat encrypted-wire checks.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Credential } from 'mppx';
import { TestnetAcceptanceRpc } from '../p3/rpc-provider.mjs';
import { verifyAgentPaidCredential } from '../p3/native-verification.mjs';
import { verifyNativeTransfer } from '../near.mjs';
import { verifyReceipt } from './authority.mjs';
import { hash, requireThat, checkConservation, meterSettlement, uint } from '../contract.mjs';
import { usageCostMicro, validateTariff } from '../../inference-comparison/core.mjs';

export async function auditEvidence(evidence, rpc = new TestnetAcceptanceRpc()) {
  const { order } = evidence, credential = Credential.deserialize(evidence.paymentCredential);
  requireThat(evidence.network === 'testnet' && credential.challenge.request.network === 'testnet'
    && credential.challenge.request.orderRef === order.id && credential.challenge.request.nativeRequestHash === evidence.requestHash
    && credential.challenge.request.termsHash === hash(order.terms), 'evidence_order_binding_mismatch');
  const payment = await verifyAgentPaidCredential({ credential, expectedChallenge: credential.challenge, rpc });
  requireThat(payment.txHash === order.payment.txHash && payment.amount === order.principal.P, 'evidence_payment_mismatch');
  const merchantKey = order.financialReceipt.publicKey;
  const financial = verifyReceipt(order.financialReceipt, merchantKey), refunded = verifyReceipt(order.refundReceipt, merchantKey);
  const tariff = validateTariff(order.terms.tariff, order.terms.tariff.observedAtMs);
  requireThat(hash(financial.usage) === hash(evidence.usage) && financial.actualServiceMicroUsd === usageCostMicro(tariff.rates, evidence.usage)
    && financial.orderRef === order.id && financial.termsHash === credential.challenge.request.termsHash
    && refunded.orderRef === order.id && refunded.refundTxHash === order.refund.txHash, 'evidence_financial_mismatch');
  const expected = meterSettlement({ principalYocto: payment.amount, actualServiceNano: String(uint(financial.actualServiceMicroUsd) * 1000n),
    serviceMaximumNano: String(uint(order.terms.maximumMicro) * 1000n), nanoUsdPerNear: order.terms.fx.nanoUsdPerNear });
  requireThat(hash(expected) === hash(financial.principal) && order.principal.C === expected.C && order.principal.R === expected.W
    && order.payment.gasActualYocto === payment.gasActualYocto, 'evidence_charge_or_gas_mismatch');
  const refund = await verifyNativeTransfer({ rpc, p: { txHash: order.refund.txHash, publicKey: merchantKey },
    r: { network: 'testnet', payer: credential.challenge.request.recipient, recipient: credential.challenge.request.payer,
      amount: order.principal.R, orderRef: order.id, issuedAtMs: credential.challenge.request.issuedAtMs, expiresAtMs: Number.MAX_SAFE_INTEGER },
    challengeId: 'independent-read-only-refund-audit' });
  checkConservation(order.principal);
  requireThat(order.principal.W === '0' && order.principal.H === '0' && refund.amount === order.principal.R, 'evidence_refund_incomplete');
  const nativeRefund = await rpc.transaction(order.refund.txHash, credential.challenge.request.recipient);
  const merchantGas = [nativeRefund.transaction_outcome, ...nativeRefund.receipts_outcome].reduce((n, row) => n + uint(row.outcome.tokens_burnt), 0n);
  requireThat(String(merchantGas) === order.refund.gasActualYocto, 'evidence_merchant_gas_mismatch');
  return { version: 1, scope: 'independent-read-only-chain-and-financial-audit', network: 'testnet',
    orderId: order.id, paymentTxHash: payment.txHash, refundTxHash: refund.txHash, finalTransfers: 2,
    financialSignaturesValid: true, actualServiceMicroUsd: financial.actualServiceMicroUsd, principal: order.principal,
    agentGasActualYocto: payment.gasActualYocto, merchantGasActualYocto: String(merchantGas), providerVerification: 'recorded-official-SDK-runtime-provider_tee',
    providerSignatureRecorded: order.provider.verification.signatureKind === 'provider_tee',
    modelEncryptedWireReverifiedOffline: false, broadcasts: 0, providerCalls: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await auditEvidence(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
