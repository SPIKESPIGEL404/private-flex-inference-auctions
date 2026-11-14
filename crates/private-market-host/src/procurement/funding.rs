use super::*;
use axum::extract::Path;
use ed25519_dalek::Signature;
use mpp::protocol::core::{Base64UrlJson, PaymentChallenge, Receipt, parse_authorization};
use sea_orm::QueryResult;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const METHOD: &str = "bitrouter-test";
const CURRENCY: &str = "test:USD6";
const RECIPIENT: &str = "controlled-merchant";
const SIGNING_DOMAIN: &[u8] = b"bitrouter:mpp-test-receipt:v1\n";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FundingRequest {
    amount_micro_usd: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TestReceipt {
    payment_id: String,
    funding_id: String,
    reference: String,
    recipient: String,
    currency: String,
    amount: String,
    settled_at_ms: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TestProof {
    receipt: TestReceipt,
    signature: String,
}

pub(super) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<FundingRequest>,
) -> ApiResult<Response> {
    let user = authenticate(&state, &headers, &uri).await?;
    let key = operation_key(&headers)?;
    let amount = amount(&input.amount_micro_usd)?;
    if let Some(config) = &state.config.nearintents {
        return super::nearintents::invoke(
            &state,
            config,
            "create",
            &user,
            json!({"key":key,"amount_micro_usd":input.amount_micro_usd}),
        )
        .await;
    }
    if amount > 10_000_000 {
        return Err(invalid());
    }
    let id = Uuid::new_v4().to_string();
    let expires = now_ms(state.db.conn()).await? + 300_000;
    let expires_text = chrono::DateTime::from_timestamp_millis(expires)
        .ok_or_else(invalid)?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let challenge = PaymentChallenge::new(
        Uuid::new_v4().to_string(),
        "private-market-controlled",
        METHOD,
        "charge",
        Base64UrlJson::from_value(&json!({"amount":input.amount_micro_usd,"currency":CURRENCY,
            "recipient":RECIPIENT,"externalId":id}))
        .map_err(|_| invalid())?,
    )
    .with_expires(expires_text)
    .with_header("Payment-Authorization");
    let inserted=state.db.conn().execute(sql(
        "INSERT INTO controlled_mpp_funding(id,user_id,operation_key,amount_micro_usd,challenge,expires_at_ms) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,operation_key) DO NOTHING",
        vec![id.into(),user.clone().into(),key.clone().into(),amount.into(),serde_json::to_value(&challenge)?.into(),expires.into()],
    )).await?.rows_affected()==1;
    let row = state
        .db
        .conn()
        .query_one(sql(
            "SELECT * FROM controlled_mpp_funding WHERE user_id=$1 AND operation_key=$2",
            vec![user.into(), key.into()],
        ))
        .await?
        .ok_or_else(not_found)?;
    if row.try_get::<i64>("", "amount_micro_usd")? != amount {
        return Err(conflict());
    }
    Ok(response(
        if inserted {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        view(&state, &row).await?,
    ))
}

async fn owned<C: ConnectionTrait>(
    conn: &C,
    id: &str,
    user: &str,
    lock: bool,
) -> ApiResult<QueryResult> {
    let query = if lock {
        "SELECT * FROM controlled_mpp_funding WHERE id=$1 AND user_id=$2 FOR UPDATE"
    } else {
        "SELECT * FROM controlled_mpp_funding WHERE id=$1 AND user_id=$2"
    };
    conn.query_one(sql(query, vec![id.into(), user.into()]))
        .await?
        .ok_or_else(not_found)
}

async fn view(state: &AppState, row: &QueryResult) -> ApiResult<Value> {
    let ledger: Option<String> = row.try_get("", "ledger_id")?;
    let ready = if let Some(id) = &ledger {
        state.db.conn().query_one(sql("SELECT state='applied' AS ready FROM redis_balance_mutations WHERE ledger_entry_id=$1",vec![id.clone().into()]))
            .await?.is_some_and(|r|r.try_get::<bool>("","ready").unwrap_or(false))
    } else {
        false
    };
    Ok(
        json!({"id":row.try_get::<String>("","id")?,"amount_micro_usd":row.try_get::<i64>("","amount_micro_usd")?.to_string(),
        "status":if ledger.is_some(){if ready{"credited"}else{"projection_pending"}}else{"unpaid"},
        "expires_at_ms":row.try_get::<i64>("","expires_at_ms")?,"challenge":row.try_get::<Value>("","challenge")?,
        "ledger_id":ledger,"payment_receipt":row.try_get::<Option<Value>>("","receipt")?,
        "mode":"controlled-test-only","real_payment":false,"attested":false}),
    )
}

pub(super) async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let user = authenticate(&state, &headers, &uri).await?;
    if let Some(config) = &state.config.nearintents {
        return super::nearintents::invoke(&state, config, "read", &user, json!({"id":id})).await;
    }
    Ok(response(
        StatusCode::OK,
        view(&state, &owned(state.db.conn(), &id, &user, false).await?).await?,
    ))
}

pub(super) async fn pay(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let user = authenticate(&state, &headers, &uri).await?;
    if let Some(config) = &state.config.nearintents {
        if headers.get_all("payment-authorization").iter().count() > 1 {
            return Err(invalid());
        }
        let credential = headers
            .get("payment-authorization")
            .map(|v| v.to_str().map(str::to_owned))
            .transpose()
            .map_err(|_| invalid())?;
        return super::nearintents::invoke(
            &state,
            config,
            "pay",
            &user,
            json!({"id":id,"credential":credential}),
        )
        .await;
    }
    let row = owned(state.db.conn(), &id, &user, false).await?;
    let challenge: PaymentChallenge = serde_json::from_value(row.try_get("", "challenge")?)?;
    if !headers.contains_key("payment-authorization") {
        if row.try_get::<Option<String>>("", "ledger_id")?.is_some() {
            let ready = state.cache.reconcile_balance(&user).await.is_ok();
            let mut result = response(
                if ready {
                    StatusCode::OK
                } else {
                    StatusCode::ACCEPTED
                },
                view(&state, &row).await?,
            );
            if ready {
                let receipt: Receipt =
                    serde_json::from_value(row.try_get::<Value>("", "receipt")?)?;
                result.headers_mut().insert(
                    "payment-receipt",
                    receipt
                        .to_header()
                        .map_err(|_| invalid())?
                        .parse()
                        .map_err(|_| invalid())?,
                );
            }
            return Ok(result);
        }
        if now_ms(state.db.conn()).await? > row.try_get::<i64>("", "expires_at_ms")? {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "payment_requires_reconciliation",
            ));
        }
        let mut result = response(StatusCode::PAYMENT_REQUIRED, view(&state, &row).await?);
        result.headers_mut().insert(
            "www-authenticate",
            challenge
                .to_header()
                .map_err(|_| invalid())?
                .parse()
                .map_err(|_| invalid())?,
        );
        return Ok(result);
    }
    if headers.get_all("payment-authorization").iter().count() != 1 {
        return Err(invalid());
    }
    let raw = headers
        .get("payment-authorization")
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() <= 8192)
        .ok_or_else(invalid)?;
    let credential = parse_authorization(raw).map_err(|_| invalid())?;
    if serde_json::to_value(&credential.challenge)? != serde_json::to_value(challenge.to_echo())? {
        return Err(conflict());
    }
    let proof: TestProof = credential.payload_as().map_err(|_| invalid())?;
    let data = &proof.receipt;
    let payment_id = Uuid::parse_str(&data.payment_id)
        .map_err(|_| invalid())?
        .to_string();
    if payment_id != data.payment_id
        || data.funding_id != id
        || data.reference != id
        || data.recipient != RECIPIENT
        || data.currency != CURRENCY
        || data.amount != row.try_get::<i64>("", "amount_micro_usd")?.to_string()
        || data.settled_at_ms <= 0
    {
        return Err(conflict());
    }
    let signature = Signature::from_slice(&hex::decode(&proof.signature).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    let mut message = SIGNING_DOMAIN.to_vec();
    message.extend(serde_json::to_vec(data)?);
    state
        .config
        .verification_key
        .as_ref()
        .ok_or_else(invalid)?
        .verify_strict(&message, &signature)
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "invalid_test_payment_proof"))?;
    // Fixture verification has no external consume side effect. The proof and
    // its consumption commit atomically with the original ledger and outbox.
    let tx = state.db.conn().begin().await?;
    fence(&tx, &user).await?;
    let row = owned(&tx, &id, &user, true).await?;
    let existing: Option<String> = row.try_get("", "payment_id")?;
    if let Some(existing) = existing {
        if existing != payment_id {
            return Err(conflict());
        }
        let original: Value = tx
            .query_one(sql(
                "SELECT proof FROM controlled_mpp_payments WHERE payment_id=$1 AND funding_id=$2",
                vec![payment_id.clone().into(), id.clone().into()],
            ))
            .await?
            .ok_or_else(conflict)?
            .try_get("", "proof")?;
        if original != serde_json::to_value(&proof)? {
            return Err(conflict());
        }
    } else {
        let now = now_ms(&tx).await?;
        let expires: i64 = row.try_get("", "expires_at_ms")?;
        if now > expires || data.settled_at_ms > now || data.settled_at_ms < expires - 300_000 {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "payment_requires_reconciliation",
            ));
        }
        if tx.execute(sql("INSERT INTO controlled_mpp_payments(payment_id,funding_id,proof) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            vec![payment_id.clone().into(),id.clone().into(),serde_json::to_value(&proof)?.into()])).await?.rows_affected()!=1 {return Err(conflict())}
        let account: String = tx
            .query_one(sql(
                "SELECT id FROM credit_accounts WHERE user_id=$1 AND currency='USD' FOR UPDATE",
                vec![user.clone().into()],
            ))
            .await?
            .ok_or_else(not_found)?
            .try_get("", "id")?;
        let amount: i64 = row.try_get("", "amount_micro_usd")?;
        let ledger = format!("mpp_test_{id}");
        tx.execute(sql("INSERT INTO credit_ledger_entries(id,credit_account_id,entry_type,amount_micro_usd,currency,idempotency_key,metadata) VALUES($1,$2,'purchase',$3,'USD',$1,jsonb_build_object('source','controlled_mpp_test','funding_id',$4::text))",
            vec![ledger.clone().into(),account.clone().into(),amount.into(),id.clone().into()])).await?;
        tx.execute(sql("UPDATE credit_accounts SET balance_micro_usd=balance_micro_usd+$2,updated_at=now() WHERE id=$1",vec![account.into(),amount.into()])).await?;
        let mut digest = Sha256::new();
        digest.update(b"bitrouter:redis-balance-mutation:v2\0");
        digest.update(ledger.as_bytes());
        let mutation = format!("rbm_v2_{}", hex::encode(digest.finalize()));
        tx.execute(sql("INSERT INTO redis_balance_mutations(mutation_id,user_id,ledger_entry_id,signed_delta_micro_usd) VALUES($1,$2,$3,$4)",
            vec![mutation.into(),user.clone().into(),ledger.clone().into(),amount.into()])).await?;
        let mut receipt = Receipt::success(METHOD, &payment_id).with_external_id(&id);
        receipt
            .extensions
            .insert("mode".into(), json!("controlled-test-only"));
        tx.execute(sql(
            "UPDATE controlled_mpp_funding SET payment_id=$2,receipt=$3,ledger_id=$4 WHERE id=$1",
            vec![
                id.clone().into(),
                payment_id.into(),
                serde_json::to_value(receipt)?.into(),
                ledger.into(),
            ],
        ))
        .await?;
    }
    tx.commit().await?;
    // Outbox precedes Redis. Failure stays pending; replay repairs the same entry.
    let ready = state.cache.reconcile_balance(&user).await.is_ok();
    let row = owned(state.db.conn(), &id, &user, false).await?;
    let mut result = response(
        if ready {
            StatusCode::OK
        } else {
            StatusCode::ACCEPTED
        },
        view(&state, &row).await?,
    );
    if ready {
        let receipt: Receipt = serde_json::from_value(row.try_get::<Value>("", "receipt")?)?;
        result.headers_mut().insert(
            "payment-receipt",
            receipt
                .to_header()
                .map_err(|_| invalid())?
                .parse()
                .map_err(|_| invalid())?,
        );
    }
    Ok(result)
}

pub(super) async fn funds(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let user = authenticate(&state, &headers, &uri).await?;
    if let Some(config) = &state.config.nearintents {
        return super::nearintents::invoke(&state, config, "funds", &user, json!({})).await;
    }
    let row=state.db.conn().query_one(sql("SELECT a.balance_micro_usd,
        coalesce((SELECT sum(amount_micro_usd) FROM controlled_mpp_funding WHERE user_id=$1 AND ledger_id IS NOT NULL),0)::bigint AS funded,
        coalesce((SELECT sum(cap_micro_usd) FROM market_inference_cash WHERE user_id=$1 AND receipt IS NULL),0)::bigint AS held,
        coalesce((SELECT sum((receipt->>'cash_micro_usd')::bigint) FROM market_inference_cash WHERE user_id=$1 AND receipt IS NOT NULL),0)::bigint AS charged,
        NOT EXISTS(SELECT FROM redis_balance_mutations WHERE user_id=$1 AND state<>'applied') AS ready
        FROM credit_accounts a WHERE a.user_id=$1",vec![user.into()])).await?.ok_or_else(not_found)?;
    let balance: i64 = row.try_get("", "balance_micro_usd")?;
    let funded: i64 = row.try_get("", "funded")?;
    let held: i64 = row.try_get("", "held")?;
    let charged: i64 = row.try_get("", "charged")?;
    Ok(response(
        StatusCode::OK,
        json!({"mode":"controlled-test-only","real_payment":false,
        "cash_balance_micro_usd":balance.to_string(),"funded_micro_usd":funded.to_string(),"held_micro_usd":held.to_string(),
        "charged_micro_usd":charged.to_string(),"cash_projection_ready":row.try_get::<bool>("","ready")?,
        "conserved":i128::from(funded)==i128::from(balance)+i128::from(held)+i128::from(charged)}),
    ))
}
