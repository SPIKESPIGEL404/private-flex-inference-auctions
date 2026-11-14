import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateConfiguration } from '../bridge.mjs'

const secret = 'x'.repeat(32)
const config = {
  mode: 'live',
  originAsset: 'eip155:42161/erc20:0x1111111111111111111111111111111111111111',
  destinationAsset: 'near:mainnet/nep141:usdc.test.near',
  destinationRecipient: 'merchant.test.near',
  refundTo: '0x2222222222222222222222222222222222222222',
  realm: 'market.test',
}
test('live endpoint cannot be redirected to a fake settlement authority', () => {
  assert.throws(() =>
    validateConfiguration({ ...config, oneClickBaseUrl: 'http://127.0.0.1:1234' }, secret),
  )
  assert.throws(() =>
    validateConfiguration({ ...config, oneClickBaseUrl: 'https://evil.example' }, secret),
  )
  assert.throws(() =>
    validateConfiguration(
      { ...config, oneClickBaseUrl: 'https://1click.chaindefuser.com/?token=secret' },
      secret,
    ),
  )
  assert.equal(
    validateConfiguration(config, secret).config.oneClickBaseUrl,
    'https://1click.chaindefuser.com',
  )
})
test('controlled endpoint and HMAC secret are explicit and pinned', () => {
  const controlled = { ...config, mode: 'controlled', oneClickBaseUrl: 'http://127.0.0.1:1234' }
  assert.throws(() =>
    validateConfiguration(
      { ...controlled, oneClickBaseUrl: 'https://1click.chaindefuser.com' },
      secret,
    ),
  )
  assert.throws(() => validateConfiguration(controlled, 'short'))
  assert.notEqual(
    validateConfiguration(controlled, secret).fingerprint,
    validateConfiguration(controlled, 'y'.repeat(32)).fingerprint,
  )
  assert.equal(
    validateConfiguration(controlled, secret).fingerprint,
    validateConfiguration(Object.fromEntries(Object.entries(controlled).reverse()), secret)
      .fingerprint,
  )
  assert.throws(() => validateConfiguration({ ...controlled, privateKey: 'forbidden' }, secret))
})
