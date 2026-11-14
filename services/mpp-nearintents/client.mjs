// Present an already-broadcast deposit hash through the official SDK. This
// adapter never holds wallet keys and never starts a second transfer on retry.
import { Mppx } from 'mppx/client'
import { nearintents } from '@defuse-protocol/nearintents-mpp-sdk/client'

export async function presentDeposit({ url, token, hash, policy }) {
  const endpoint = new URL(url)
  if (
    !policy ||
    typeof hash !== 'string' ||
    !hash ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Explicit endpoint, deposit hash and payment policy required')
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1')
  )
    throw new Error('HTTPS or controlled loopback required')
  const client = Mppx.create({ polyfill: false, methods: [nearintents.charge({ policy })] })
  return client.fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    context: { hash },
  })
}
