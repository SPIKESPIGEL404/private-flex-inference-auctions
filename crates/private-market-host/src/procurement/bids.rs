//! Durable pre-admission state only. Cash/Offer admission remains disabled until
//! its owning transaction interface, task budget and dispatch fencing are ready.
use super::*;
use axum::extract::Path;
use bitrouter_cloud::platform_billing::{
    meter::{self, ApiProtocol},
    money::MicroUsd,
};
use sea_orm::QueryResult;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BidSpec {
    native_request: Value,
    initial_provider_cap_micro_usd: String,
    hard_provider_cap_micro_usd: String,
    hard_total_cap_nano_usd: String,
    step_micro_usd: String,
    interval_ms: u64,
    deadline_ms: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Revision {
    expected_revision: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NewBid {
    expected_revision: i64,
    provider_cap_micro_usd: String,
}

impl BidSpec {
    fn validate(&self, now: i64) -> ApiResult<()> {
        let initial = amount(&self.initial_provider_cap_micro_usd)?;
        let hard = amount(&self.hard_provider_cap_micro_usd)?;
        let total = amount(&self.hard_total_cap_nano_usd)?;
        let step = amount(&self.step_micro_usd)?;
        if initial > hard
            || hard > 10_000_000
            || step > hard
            || !(10..=3_600_000).contains(&self.interval_ms)
            || self.deadline_ms <= now
            || self.deadline_ms > now + 86_400_000
        {
            return Err(invalid());
        }
        let body = self.native_request.as_object().ok_or_else(invalid)?;
        if body.get("model").and_then(Value::as_str) != Some("m/external")
            || body.keys().any(|k| k.starts_with("bitrouter_"))
        {
            return Err(invalid());
        }
        let output = body
            .get("max_completion_tokens")
            .or_else(|| body.get("max_tokens"))
            .and_then(Value::as_u64)
            .filter(|n| *n > 0 && *n <= 4096)
            .ok_or_else(invalid)?;
        if output == 0
            || (body.contains_key("max_completion_tokens") && body.contains_key("max_tokens"))
        {
            return Err(invalid());
        }
        let snapshot = meter::freeze(ApiProtocol::ChatCompletions, &self.native_request)
            .map_err(|_| invalid())?;
        bitrouter_cloud::market::inference::output_contract(
            ApiProtocol::ChatCompletions,
            &self.native_request,
        )
        .map_err(|_| invalid())?;
        let fee = MicroUsd::from_input_tokens(u128::from(snapshot.billable_input_tokens))
            .map_err(|_| invalid())?;
        if (i128::from(hard) + i128::from(fee.value())) * 1000 > i128::from(total) {
            return Err(invalid());
        }
        Ok(())
    }
}

async fn owned<C: ConnectionTrait>(conn: &C, id: &str, user: &str) -> ApiResult<QueryResult> {
    conn.query_one(sql(
        "SELECT * FROM controlled_procurement_intents WHERE id=$1 AND user_id=$2",
        vec![id.into(), user.into()],
    ))
    .await?
    .ok_or_else(not_found)
}

fn view(row: &QueryResult, now: i64) -> ApiResult<Value> {
    Ok(
        json!({"id":row.try_get::<String>("","id")?,"revision":row.try_get::<i64>("","revision")?,
        "provider_cap_micro_usd":row.try_get::<i64>("","current_cap_micro_usd")?.to_string(),
        "status":row.try_get::<String>("","status")?,"started_at_ms":row.try_get::<i64>("","started_at_ms")?,
        "deadline_ms":row.try_get::<i64>("","deadline_ms")?,"deadline_elapsed":now>=row.try_get::<i64>("","deadline_ms")?,
        "manual_override":row.try_get::<bool>("","manual_override")?,"specification":row.try_get::<Value>("","specification")?,
        "mode":"controlled-test-only","admission_enabled":false,"provider_dispatched":false}),
    )
}

pub(super) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<BidSpec>,
) -> ApiResult<Response> {
    let user = authenticate(&state, &headers, &uri).await?;
    let key = operation_key(&headers)?;
    let specification = serde_json::to_value(&input)?;
    let tx = state.db.conn().begin().await?;
    fence(&tx, &user).await?;
    let now = now_ms(&tx).await?;
    if let Some(row) = tx
        .query_one(sql(
            "SELECT * FROM controlled_procurement_intents WHERE user_id=$1 AND operation_key=$2",
            vec![user.clone().into(), key.clone().into()],
        ))
        .await?
    {
        if row.try_get::<Value>("", "specification")? != specification {
            return Err(conflict());
        }
        let result = view(&row, now)?;
        tx.commit().await?;
        return Ok(response(StatusCode::OK, result));
    }
    input.validate(now)?;
    let id = Uuid::new_v4().to_string();
    tx.execute(sql("INSERT INTO controlled_procurement_intents(id,user_id,operation_key,specification,started_at_ms,deadline_ms,current_cap_micro_usd) VALUES($1,$2,$3,$4,$5,$6,$7)",
        vec![id.clone().into(),user.clone().into(),key.into(),specification.into(),now.into(),input.deadline_ms.into(),amount(&input.initial_provider_cap_micro_usd)?.into()])).await?;
    let result = view(&owned(&tx, &id, &user).await?, now)?;
    tx.execute(sql(
        "INSERT INTO controlled_procurement_revisions(intent_id,revision,snapshot) VALUES($1,0,$2)",
        vec![id.into(), result.clone().into()],
    ))
    .await?;
    tx.commit().await?;
    Ok(response(StatusCode::CREATED, result))
}

pub(super) async fn read(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let user = authenticate(&state, &headers, &uri).await?;
    Ok(response(
        StatusCode::OK,
        view(
            &owned(state.db.conn(), &id, &user).await?,
            now_ms(state.db.conn()).await?,
        )?,
    ))
}

pub(super) async fn revise(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<NewBid>,
) -> ApiResult<Response> {
    let value = serde_json::to_value(&input)?;
    command(
        state,
        id,
        headers,
        uri,
        input.expected_revision,
        "revise",
        value,
    )
    .await
}
pub(super) async fn tick(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<Revision>,
) -> ApiResult<Response> {
    let value = serde_json::to_value(&input)?;
    command(
        state,
        id,
        headers,
        uri,
        input.expected_revision,
        "tick",
        value,
    )
    .await
}
pub(super) async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
    Json(input): Json<Revision>,
) -> ApiResult<Response> {
    let value = serde_json::to_value(&input)?;
    command(
        state,
        id,
        headers,
        uri,
        input.expected_revision,
        "cancel",
        value,
    )
    .await
}

fn scheduled_cap(initial: i64, step: i64, hard: i64, elapsed: i64, interval: u64) -> i64 {
    // i128 also covers the product of any valid elapsed i64 and step i64.
    let steps = i128::from(elapsed.max(0)) / i128::from(interval);
    (i128::from(initial) + steps * i128::from(step)).min(i128::from(hard)) as i64
}

async fn command(
    state: AppState,
    id: String,
    headers: HeaderMap,
    uri: Uri,
    expected: i64,
    kind: &str,
    input: Value,
) -> ApiResult<Response> {
    let user = authenticate(&state, &headers, &uri).await?;
    let key = operation_key(&headers)?;
    let operation = json!({"kind":kind,"input":input});
    let tx = state.db.conn().begin().await?;
    fence(&tx, &user).await?;
    let row = owned(&tx, &id, &user).await?;
    if let Some(previous)=tx.query_one(sql("SELECT intent_id,command,result FROM controlled_procurement_operations WHERE user_id=$1 AND operation_key=$2",vec![user.clone().into(),key.clone().into()])).await? {
        if previous.try_get::<String>("","intent_id")?!=id || previous.try_get::<Value>("","command")?!=operation {return Err(conflict())}
        let result=previous.try_get("","result")?;
        tx.commit().await?;
        return Ok(response(StatusCode::OK,result));
    }
    let revision: i64 = row.try_get("", "revision")?;
    if revision != expected || row.try_get::<String>("", "status")? != "open" {
        return Err(conflict());
    }
    let now = now_ms(&tx).await?;
    let spec: BidSpec = serde_json::from_value(row.try_get("", "specification")?)?;
    let current: i64 = row.try_get("", "current_cap_micro_usd")?;
    let mut manual: bool = row.try_get("", "manual_override")?;
    let mut status = "open";
    let next = if now >= spec.deadline_ms {
        status = "expired";
        current
    } else {
        match kind {
            "cancel" => {
                status = "cancelled";
                current
            }
            "revise" => {
                let updated = amount(
                    input["provider_cap_micro_usd"]
                        .as_str()
                        .ok_or_else(invalid)?,
                )?;
                if updated > amount(&spec.hard_provider_cap_micro_usd)? {
                    return Err(invalid());
                }
                manual = true;
                updated
            }
            "tick" => {
                if manual {
                    current
                } else {
                    scheduled_cap(
                        amount(&spec.initial_provider_cap_micro_usd)?,
                        amount(&spec.step_micro_usd)?,
                        amount(&spec.hard_provider_cap_micro_usd)?,
                        now - row.try_get::<i64>("", "started_at_ms")?,
                        spec.interval_ms,
                    )
                }
            }
            _ => return Err(invalid()),
        }
    };
    let changed = next != current
        || status != "open"
        || manual != row.try_get::<bool>("", "manual_override")?;
    let new_revision = revision
        .checked_add(i64::from(changed))
        .ok_or_else(conflict)?;
    tx.execute(sql("UPDATE controlled_procurement_intents SET current_cap_micro_usd=$2,revision=$3,status=$4,manual_override=$5 WHERE id=$1",
        vec![id.clone().into(),next.into(),new_revision.into(),status.into(),manual.into()])).await?;
    let result = view(&owned(&tx, &id, &user).await?, now)?;
    if changed {
        tx.execute(sql("INSERT INTO controlled_procurement_revisions(intent_id,revision,snapshot) VALUES($1,$2,$3)",vec![id.clone().into(),new_revision.into(),result.clone().into()])).await?;
    }
    tx.execute(sql("INSERT INTO controlled_procurement_operations(user_id,operation_key,intent_id,command,result) VALUES($1,$2,$3,$4,$5)",
        vec![user.into(),key.into(),id.into(),operation.into(),result.clone().into()])).await?;
    tx.commit().await?;
    Ok(response(StatusCode::OK, result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absolute_schedule_is_capped_without_overflow() {
        assert_eq!(scheduled_cap(10, 5, 100, -1, 10), 10);
        assert_eq!(scheduled_cap(10, 5, 100, 39, 10), 25);
        assert_eq!(scheduled_cap(10, i64::MAX, i64::MAX, i64::MAX, 1), i64::MAX);
    }
}
