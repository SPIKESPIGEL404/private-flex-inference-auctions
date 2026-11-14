// Offline acceptance client. No signing wallet is ever constructed here.
import { randomBytes } from 'node:crypto'
import { Credential } from 'mppx'
import { Mppx } from 'mppx/client'
import { nearintents } from '@defuse-protocol/nearintents-mpp-sdk/client'
import { presentDeposit } from '../client.mjs'

let raw = ''
for await (const chunk of process.stdin) raw += chunk
const input = JSON.parse(raw)
if (input.action === 'credential') {
  process.stdout.write(
    Credential.serialize({
      challenge: input.challenge,
      payload: { type: 'hash', hash: input.hash },
    }),
  )
} else if (input.action === 'present-known') {
  const response = await presentDeposit(input)
  process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }))
} else {
  const fixture = new URL(input.fixtureUrl)
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1')
    throw new Error('Acceptance payer requires a loopback fixture')
  let credential
  const client = Mppx.create({
    polyfill: false,
    methods: [
      nearintents.charge({
        policy: input.policy,
        async sendDeposit({ challenge, request }) {
          const hash = '0x' + randomBytes(32).toString('hex')
          const response = await fetch(new URL('/fixture/pay', fixture), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ address: request.recipient, hash }),
          })
          if (!response.ok) throw new Error('Fixture rejected synthetic deposit')
          credential = Credential.serialize({ challenge, payload: { type: 'hash', hash } })
          return hash
        },
      }),
    ],
  })
  const response = await client.fetch(input.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.token}` },
    redirect: 'error',
  })
  process.stdout.write(
    JSON.stringify({
      status: response.status,
      body: await response.json(),
      headers: Object.fromEntries(response.headers),
      credential,
    }),
  )
}
