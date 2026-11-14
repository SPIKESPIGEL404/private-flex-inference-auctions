import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { Client } from 'pg'
import { Challenge, Credential, Receipt } from 'mppx'
import { Mppx } from 'mppx/server'
import { OneClick, Types } from '@defuse-protocol/nearintents-mpp-sdk'
import { nearintents } from '@defuse-protocol/nearintents-mpp-sdk/server'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const result = (status, data, headers = {}) => ({ status, data, headers })
const fail = (status, error) => result(status, { error })
const money = (value) =>
  typeof value === 'string' && /^[1-9][0-9]{0,7}$/.test(value) && BigInt(value) <= 10_000_000n

export function validateConfiguration(raw, secret) {
  const allowed = new Set([
    'mode',
    'originAsset',
    'destinationAsset',
    'destinationRecipient',
    'refundTo',
    'realm',
    'expiresWindow',
    'settlementTimeout',
    'pollInterval',
    'oneClickBaseUrl',
  ])
  if (!raw || Object.keys(raw).some((key) => !allowed.has(key)))
    throw new Error('Unknown payment configuration field')
  if (
    !['live', 'controlled'].includes(raw.mode) ||
    typeof secret !== 'string' ||
    secret.length < 32
  )
    throw new Error('Payment mode or secret missing')
  for (const name of ['originAsset', 'destinationAsset']) Types.parseCaip19(raw[name])
  for (const name of ['destinationRecipient', 'refundTo', 'realm'])
    if (typeof raw[name] !== 'string' || !raw[name].trim() || raw[name].length > 256)
      throw new Error(`Invalid ${name}`)
  const expiresWindow = raw.expiresWindow ?? 300
  const settlementTimeout = raw.settlementTimeout ?? 120
  const pollInterval = raw.pollInterval ?? 2000
  if (!Number.isInteger(expiresWindow) || expiresWindow < 1 || expiresWindow > 3600)
    throw new Error('Invalid expiresWindow')
  if (!Number.isInteger(settlementTimeout) || settlementTimeout < 1 || settlementTimeout > 120)
    throw new Error('Invalid settlementTimeout')
  if (!Number.isInteger(pollInterval) || pollInterval < 0 || pollInterval > 10_000)
    throw new Error('Invalid pollInterval')
  const baseUrl = new URL(raw.oneClickBaseUrl ?? OneClick.defaultBaseUrl)
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.pathname !== '/'
  )
    throw new Error('Invalid settlement endpoint')
  if (raw.mode === 'controlled') {
    if (baseUrl.protocol !== 'http:' || baseUrl.hostname !== '127.0.0.1' || !baseUrl.port)
      throw new Error('Controlled settlement must be loopback')
  } else if (baseUrl.origin !== OneClick.defaultBaseUrl)
    throw new Error('Live settlement requires the official 1Click endpoint')
  const config = {
    ...raw,
    expiresWindow,
    settlementTimeout,
    pollInterval,
    oneClickBaseUrl: baseUrl.origin,
  }
  return {
    config,
    fingerprint: hash(
      JSON.stringify(Object.fromEntries(Object.entries(config).sort())) + '\0' + hash(secret),
    ),
  }
}

// Every operation uses one outer PG transaction. All SDK mutations, including
// hash consumption, commit with the original cash ledger and funding receipt.
export function atomicStore(db, fundingId) {
  const keyOf = (key) =>
    key.startsWith('nearintents-mpp-sdk:quote:') ? `funding:${fundingId}:${key}` : `global:${key}`
  const lock = (key) => db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,814517))', [key])
  const getRaw = async (key) =>
    (await db.query('SELECT value FROM mpp_nearintents_store WHERE key=$1', [key])).rows[0]
      ?.value ?? null
  const putRaw = (key, value) =>
    db.query(
      'INSERT INTO mpp_nearintents_store(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, JSON.stringify(value)],
    )
  return {
    get: (key) => getRaw(keyOf(key)),
    async put(key, value) {
      const stored = keyOf(key)
      await lock(stored)
      await putRaw(stored, value)
    },
    async delete(key) {
      const stored = keyOf(key)
      await lock(stored)
      await db.query('DELETE FROM mpp_nearintents_store WHERE key=$1', [stored])
    },
    async update(key, fn) {
      const stored = keyOf(key)
      await lock(stored)
      const change = fn(await getRaw(stored))
      if (change.op === 'set') await putRaw(stored, change.value)
      else if (change.op === 'delete')
        await db.query('DELETE FROM mpp_nearintents_store WHERE key=$1', [stored])
      else if (change.op !== 'noop') throw new Error('Invalid store mutation')
      return change.result
    },
  }
}

const modeOf = (config) => `nearintents-${config.mode}`
function oneClick(config, jwt) {
  return {
    baseUrl: config.oneClickBaseUrl,
    jwt,
    requestTimeoutMs: 5000,
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error' }),
  }
}

async function handler(db, config, secret, jwt, id, amount, expires) {
  const method = nearintents.charge({
    originAsset: config.originAsset,
    destinationAsset: config.destinationAsset,
    destinationRecipient: config.destinationRecipient,
    refundTo: config.refundTo,
    amountOut: amount,
    externalId: id,
    expiresWindow: config.expiresWindow,
    settlementTimeout: config.settlementTimeout,
    pollInterval: config.pollInterval,
    oneClick: oneClick(config, jwt),
    store: atomicStore(db, id),
  })
  return Mppx.create({
    secretKey: secret,
    realm: config.realm,
    requiresAuth: true,
    methods: [method],
  }).charge({ expires: new Date(expires).toISOString(), scope: `funding:${id}` })
}

async function view(db, row, config) {
  const ready = row.ledger_id
    ? (
        await db.query(
          "SELECT state='applied' AS ready FROM redis_balance_mutations WHERE ledger_entry_id=$1",
          [row.ledger_id],
        )
      ).rows[0]?.ready === true
    : false
  return {
    id: row.id,
    amount_micro_usd: row.amount_micro_usd,
    status: row.ledger_id
      ? ready
        ? 'credited'
        : 'projection_pending'
      : row.last_error
        ? 'reconciliation_required'
        : 'unpaid',
    expires_at_ms: Number(row.expires_at_ms),
    challenge: row.challenge,
    ledger_id: row.ledger_id,
    payment_receipt: row.receipt,
    last_payment_error: row.last_error,
    mode: modeOf(config),
    method: 'nearintents',
    live_settlement: config.mode === 'live',
    real_payment: config.mode === 'live' && row.receipt !== null,
    attested: false,
  }
}

async function lookup(db, id, user) {
  return (
    await db.query('SELECT * FROM mpp_nearintents_funding WHERE id=$1 AND user_id=$2', [id, user])
  ).rows[0]
}
function endpoint(id) {
  return `https://private-market.invalid/market/v1/funding-intents/${id}/pay`
}

async function create(db, input, config, secret, jwt) {
  if (!money(input.amount_micro_usd) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.key))
    return fail(422, 'invalid_funding_request')
  const previous = (
    await db.query('SELECT * FROM mpp_nearintents_funding WHERE user_id=$1 AND operation_key=$2', [
      input.user_id,
      input.key,
    ])
  ).rows[0]
  if (previous)
    return previous.amount_micro_usd === input.amount_micro_usd
      ? result(200, await view(db, previous, config))
      : fail(409, 'operation_conflict')
  const transport = oneClick(config, jwt)
  const tokens = await OneClick.getTokens(transport)
  const destination = OneClick.createAssetMap(tokens).tokenOf(config.destinationAsset)
  if (!destination || destination.decimals !== 6)
    throw new Error('The credit asset must have six verified decimals')
  const id = randomUUID(),
    expires = Date.now() + config.expiresWindow * 1000
  const charge = await handler(db, config, secret, jwt, id, input.amount_micro_usd, expires)
  const issued = await charge(new Request(endpoint(id), { method: 'POST' }))
  if (issued.status !== 402 || issued.challenge.status !== 402)
    return fail(503, 'quote_unavailable')
  const header = issued.challenge.headers.get('www-authenticate')
  if (!header) return fail(503, 'quote_unavailable')
  const challenge = Challenge.deserialize(header)
  if (
    challenge.method !== 'nearintents' ||
    challenge.request.externalId !== id ||
    challenge.request.methodDetails.amountOut !== input.amount_micro_usd
  )
    throw new Error('SDK quote did not bind the funding resource')
  const depositKey =
    Types.chainOf(config.originAsset) +
    '|' +
    (Types.chainOf(config.originAsset).startsWith('eip155:')
      ? challenge.request.recipient.toLowerCase()
      : challenge.request.recipient)
  await db.query(
    'INSERT INTO mpp_nearintents_funding(id,user_id,operation_key,amount_micro_usd,challenge,challenge_header,deposit_key,expires_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      id,
      input.user_id,
      input.key,
      input.amount_micro_usd,
      JSON.stringify(challenge),
      header,
      depositKey,
      expires,
    ],
  )
  return result(201, await view(db, await lookup(db, id, input.user_id), config))
}

async function credit(db, row, receipt, originHash, paymentKey) {
  await db.query(
    'INSERT INTO mpp_nearintents_payments(payment_key,funding_id,origin_hash,receipt) VALUES($1,$2,$3,$4)',
    [paymentKey, row.id, originHash, JSON.stringify(receipt)],
  )
  const account = (
    await db.query(
      "SELECT id FROM credit_accounts WHERE user_id=$1 AND currency='USD' FOR UPDATE",
      [row.user_id],
    )
  ).rows[0]
  if (!account) throw new Error('Cash account unavailable')
  const ledger = `mpp_nearintents_${row.id}`
  await db.query(
    "INSERT INTO credit_ledger_entries(id,credit_account_id,entry_type,amount_micro_usd,currency,idempotency_key,metadata) VALUES($1,$2,'purchase',$3,'USD',$1,jsonb_build_object('source','mpp_nearintents','funding_id',$4::text))",
    [ledger, account.id, row.amount_micro_usd, row.id],
  )
  await db.query(
    'UPDATE credit_accounts SET balance_micro_usd=balance_micro_usd+$2,updated_at=now() WHERE id=$1',
    [account.id, row.amount_micro_usd],
  )
  const mutation =
    'rbm_v2_' +
    hash(Buffer.concat([Buffer.from('bitrouter:redis-balance-mutation:v2\0'), Buffer.from(ledger)]))
  await db.query(
    'INSERT INTO redis_balance_mutations(mutation_id,user_id,ledger_entry_id,signed_delta_micro_usd) VALUES($1,$2,$3,$4)',
    [mutation, row.user_id, ledger, row.amount_micro_usd],
  )
  await db.query(
    'UPDATE mpp_nearintents_funding SET payment_key=$2,receipt=$3,ledger_id=$4,last_error=NULL WHERE id=$1',
    [row.id, paymentKey, JSON.stringify(receipt), ledger],
  )
}

async function pay(db, input, config, secret, jwt) {
  const row = await lookup(db, input.id, input.user_id)
  if (!row) return fail(404, 'resource_not_found')
  let header = input.credential
  if (input.operation === 'reconcile' && !header) header = row.last_credential
  let credential, originHash, paymentKey
  if (header) {
    try {
      credential = Credential.deserialize(header)
    } catch {
      return fail(422, 'invalid_payment_credential')
    }
    if (
      !isDeepStrictEqual(credential.challenge, row.challenge) ||
      credential.payload?.type !== 'hash' ||
      typeof credential.payload.hash !== 'string'
    )
      return fail(409, 'payment_binding_conflict')
    originHash = credential.payload.hash
    paymentKey =
      Types.chainOf(config.originAsset) +
      '|' +
      OneClick.canonicalTxHash(originHash, Types.chainOf(config.originAsset))
  }
  if (row.ledger_id) {
    if (header && paymentKey !== row.payment_key) return fail(409, 'payment_conflict')
    return result(200, await view(db, row, config), {
      'payment-receipt': Receipt.serialize(row.receipt),
    })
  }
  if (!header) {
    if (row.last_credential) return result(202, await view(db, row, config))
    if (Date.now() >= Number(row.expires_at_ms)) return fail(409, 'payment_requires_reconciliation')
    return result(402, await view(db, row, config), { 'www-authenticate': row.challenge_header })
  }
  const used = (
    await db.query('SELECT funding_id FROM mpp_nearintents_payments WHERE payment_key=$1', [
      paymentKey,
    ])
  ).rows[0]
  if (used && used.funding_id !== row.id) return fail(409, 'payment_already_used')
  await db.query('UPDATE mpp_nearintents_funding SET last_credential=$2 WHERE id=$1', [
    row.id,
    header,
  ])
  if (Date.now() >= Number(row.expires_at_ms)) {
    await db.query(
      "UPDATE mpp_nearintents_funding SET last_error='expired_payment_requires_reconciliation' WHERE id=$1",
      [row.id],
    )
    return result(409, await view(db, await lookup(db, row.id, input.user_id), config))
  }
  const charge = await handler(
    db,
    config,
    secret,
    jwt,
    row.id,
    row.amount_micro_usd,
    Number(row.expires_at_ms),
  )
  const verification = await charge(
    new Request(endpoint(row.id), { method: 'POST', headers: { 'Payment-Authorization': header } }),
  )
  if (verification.status !== 200) {
    const status = verification.challenge.status
    const problem = await verification.challenge
      .json()
      .catch(() => ({ type: 'payment_verification_unavailable' }))
    await db.query('UPDATE mpp_nearintents_funding SET last_error=$2 WHERE id=$1', [
      row.id,
      String(problem.type ?? 'payment_not_accepted'),
    ])
    // Do not expose a freshly minted challenge after a paid attempt. Retain the
    // original funding responsibility; retries may not silently pay again.
    return result(
      status >= 500 ? status : 409,
      await view(db, await lookup(db, row.id, input.user_id), config),
    )
  }
  const response = await verification.withReceipt(Response.json({}))
  const receipt = Receipt.deserialize(response.headers.get('payment-receipt'))
  if (
    receipt.method !== 'nearintents' ||
    receipt.externalId !== row.id ||
    receipt.challengeId !== row.challenge.id ||
    !receipt.reference
  )
    throw new Error('Invalid SDK settlement receipt')
  await credit(db, row, receipt, originHash, paymentKey)
  return result(200, await view(db, await lookup(db, row.id, input.user_id), config), {
    'payment-receipt': Receipt.serialize(receipt),
  })
}

async function funds(db, user, config) {
  const row = (
    await db.query(
      `SELECT a.balance_micro_usd,
    coalesce((SELECT sum(amount_micro_usd) FROM mpp_nearintents_funding WHERE user_id=$1 AND ledger_id IS NOT NULL),0)::bigint AS funded,
    coalesce((SELECT sum(cap_micro_usd) FROM market_inference_cash WHERE user_id=$1 AND receipt IS NULL),0)::bigint AS held,
    coalesce((SELECT sum((receipt->>'cash_micro_usd')::bigint) FROM market_inference_cash WHERE user_id=$1 AND receipt IS NOT NULL),0)::bigint AS charged,
    NOT EXISTS(SELECT FROM redis_balance_mutations WHERE user_id=$1 AND state<>'applied') AS ready
    FROM credit_accounts a WHERE a.user_id=$1`,
      [user],
    )
  ).rows[0]
  if (!row) return fail(404, 'resource_not_found')
  return result(200, {
    mode: modeOf(config),
    method: 'nearintents',
    live_settlement: config.mode === 'live',
    real_payment: config.mode === 'live' && BigInt(row.funded) > 0n,
    cash_balance_micro_usd: row.balance_micro_usd,
    funded_micro_usd: row.funded,
    held_micro_usd: row.held,
    charged_micro_usd: row.charged,
    cash_projection_ready: row.ready,
    conserved:
      BigInt(row.funded) === BigInt(row.balance_micro_usd) + BigInt(row.held) + BigInt(row.charged),
  })
}

export async function execute(input, environment = process.env) {
  const raw = JSON.parse(await readFile(environment.PRIVATE_MARKET_MPP_NEARINTENTS_CONFIG, 'utf8'))
  const secret = environment.MPP_SECRET_KEY
  const { config, fingerprint } = validateConfiguration(raw, secret)
  const db = new Client({
    connectionString: environment.DATABASE_URL,
    application_name: 'market-nearintents',
  })
  await db.connect()
  try {
    // Persist presented payment evidence before external verification. This
    // journal survives a verification/credit rollback or a killed SDK process.
    if (['pay', 'reconcile'].includes(input.operation) && input.credential) {
      const pinned = (
        await db.query('SELECT fingerprint FROM mpp_nearintents_configuration WHERE singleton')
      ).rows[0]
      if (pinned?.fingerprint !== fingerprint)
        throw new Error('Payment configuration or signing secret changed')
      const row = await lookup(db, input.id, input.user_id)
      let candidate
      try {
        candidate = Credential.deserialize(input.credential)
      } catch {
        return fail(422, 'invalid_payment_credential')
      }
      if (!row) return fail(404, 'resource_not_found')
      if (
        !isDeepStrictEqual(candidate.challenge, row.challenge) ||
        candidate.payload?.type !== 'hash' ||
        typeof candidate.payload.hash !== 'string'
      )
        return fail(409, 'payment_binding_conflict')
      await db.query(
        'INSERT INTO mpp_nearintents_attempts(funding_id,credential_hash,credential) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [row.id, hash(input.credential), input.credential],
      )
      await db.query('UPDATE mpp_nearintents_funding SET last_credential=$2 WHERE id=$1', [
        row.id,
        input.credential,
      ])
    }
    await db.query('BEGIN')
    let response
    if (input.operation === 'initialize') {
      await db.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
      await db.query(
        'INSERT INTO mpp_nearintents_configuration(fingerprint,public_configuration) VALUES($1,$2)',
        [fingerprint, JSON.stringify(config)],
      )
      response = result(200, { initialized: true, method: 'nearintents', mode: modeOf(config) })
    } else {
      const pinned = (
        await db.query('SELECT fingerprint FROM mpp_nearintents_configuration WHERE singleton')
      ).rows[0]
      if (pinned?.fingerprint !== fingerprint)
        throw new Error('Payment configuration or signing secret changed')
      if (input.operation === 'check') response = result(200, { ready: true, mode: modeOf(config) })
      else {
        if (typeof input.user_id !== 'string' || !input.user_id)
          throw new Error('Verified buyer required')
        await db.query('SELECT pg_advisory_xact_lock(public.balance_cache_advisory_key($1))', [
          input.user_id,
        ])
        switch (input.operation) {
          case 'create':
            response = await create(db, input, config, secret, environment.ONE_CLICK_JWT)
            break
          case 'pay':
          case 'reconcile':
            response = await pay(db, input, config, secret, environment.ONE_CLICK_JWT)
            break
          case 'read': {
            const row = await lookup(db, input.id, input.user_id)
            response = row
              ? result(200, await view(db, row, config))
              : fail(404, 'resource_not_found')
            break
          }
          case 'funds':
            response = await funds(db, input.user_id, config)
            break
          default:
            response = fail(422, 'unknown_operation')
        }
      }
    }
    await db.query('COMMIT')
    return response
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    await db.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let raw = ''
    for await (const chunk of process.stdin) {
      raw += chunk
      if (raw.length > 128 * 1024) throw new Error('Bridge request too large')
    }
    process.stdout.write(JSON.stringify(await execute(JSON.parse(raw))))
  } catch (error) {
    console.error(`[nearintents] ${error.code ?? error.name}: ${error.message}`)
    process.stdout.write(JSON.stringify(fail(503, 'nearintents_unavailable')))
    process.exitCode = 1
  }
}
