// Read-only live 1Click route/price check. No deposit address, signing or send.
import { readFile } from 'node:fs/promises'
import { OneClick, Types } from '@defuse-protocol/nearintents-mpp-sdk'

const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const amount = process.argv[3] ?? '10000'
if (!/^[1-9][0-9]{0,7}$/.test(amount) || BigInt(amount) > 10_000_000n)
  throw new Error('Invalid quote amount')
Types.parseCaip19(config.originAsset)
Types.parseCaip19(config.destinationAsset)
const transport = {
  requestTimeoutMs: 10_000,
  fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
}
const tokens = await OneClick.getTokens(transport)
const map = OneClick.createAssetMap(tokens)
const origin = map.tokenOf(config.originAsset),
  destination = map.tokenOf(config.destinationAsset)
if (!origin || !destination || destination.decimals !== 6)
  throw new Error('Unsupported asset or credit precision')
const request = {
  dry: true,
  swapType: 'EXACT_OUTPUT',
  depositType: 'ORIGIN_CHAIN',
  recipientType: 'DESTINATION_CHAIN',
  refundType: 'ORIGIN_CHAIN',
  originAsset: origin.assetId,
  destinationAsset: destination.assetId,
  amount,
  recipient: config.destinationRecipient,
  refundTo: config.refundTo,
  slippageTolerance: 100,
  deadline: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  referral: 'mpp',
}
const response = await fetch(OneClick.defaultBaseUrl + '/v0/quote', {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(20_000),
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request),
})
const body = await response.json()
process.stdout.write(
  JSON.stringify(
    {
      checked_at: new Date().toISOString(),
      dry: true,
      real_payment: false,
      quote_available: response.ok && typeof body.quote?.amountIn === 'string',
      http_status: response.status,
      origin: { asset: config.originAsset, decimals: origin.decimals, symbol: origin.symbol },
      destination: {
        asset: config.destinationAsset,
        decimals: destination.decimals,
        symbol: destination.symbol,
      },
      request,
      response: body,
    },
    null,
    2,
  ) + '\n',
)
