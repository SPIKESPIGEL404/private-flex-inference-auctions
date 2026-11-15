//! Operator-owned, synthetic seller for the explicitly controlled playground.
//! Each generation is a NEW finite sale. Original allocations and physical
//! responsibility remain in the kernel; no buyer can enable this publisher.
use super::*;
use bitrouter_market::{
    exchange::{ExecutionCommand, OfferingKey},
    order::Readiness,
    terms::SupplyState,
    throughput::{ThroughputClaim, ThroughputObservation, ThroughputRate},
};

pub(super) fn enabled() -> bool {
    std::env::var("PRIVATE_MARKET_AGENT_P2").as_deref() == Ok("controlled")
        && std::env::var("PRIVATE_MARKET_P2_CONTINUOUS_SUPPLY").as_deref() == Ok("1")
}

fn local_now() -> Result<UnixMillis> {
    Ok(UnixMillis(u64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis())?))
}

impl PgMarket {
    pub(super) async fn controlled_admission(&mut self, input: &mut coordinator::Admission) -> Result<()> {
        if !enabled() { return Ok(()); }
        // Keep the first frozen window on retries, including lost HTTP replies.
        let tx = self.db.begin().await?;
        self.verify_read_owner(&tx).await?;
        let exists = tx.query_one(sql("SELECT 1 FROM public.market_inference_requests WHERE market_id=$1 AND request_id=$2",
            vec![self.config.market_id.clone().into(), input.terms.request_id.clone().into()])).await?.is_some();
        input.tif = if exists {
            store::load(&tx, &self.config.market_id, &input.terms.request_id).await?.0.initial_tif
        } else {
            let mut expires = local_now()?.0 + input.policy.wait_budget_ms.min(15_000).max(1);
            if let Some(order) = tx.query_one(sql("SELECT expires_ms FROM public.mpp_direct_orders WHERE user_id=$1 AND dispatch_key=$2",
                vec![input.proof.user_id.clone().into(), input.terms.idempotency_key.clone().into()])).await? {
                expires = expires.min(u64::try_from(order.try_get::<i64>("", "expires_ms")?)?);
            }
            TimeInForce::Gtd { expires_at: UnixMillis(expires) }
        };
        tx.rollback().await?;
        self.controlled_candidates(&mut input.candidates).await
    }
    pub(super) async fn controlled_candidates(&mut self, candidates: &mut [MarketCandidate]) -> Result<()> {
        if !enabled() { return Ok(()); }
        // Use the existing finite inventory first. Refill at most one sale per
        // collection when fewer than two remain, keeping publication work
        // bounded and avoiding a new generation on every successful call.
        let snapshot = self.host.snapshot_ref();
        let available = candidates.iter().filter(|c| {
            let key = OfferingKey { market_id: c.candidate.context.spec.reference.market_id.clone(), offering_id: c.candidate.input.offer_id };
            snapshot.sources().get(&key).is_some_and(|source| !source.withdrawn && source.ask.valid_until > snapshot.now()
                && source.option.as_ref().is_some_and(|option| {
                    let allocation = snapshot.sells()[&option.order].allocation();
                    !allocation.is_closed() && allocation.bound_attempt().is_none()
                }))
        }).count();
        let mut refill = available < 2;
        for candidate in candidates {
            let key = OfferingKey {
                market_id: candidate.candidate.context.spec.reference.market_id.clone(),
                offering_id: candidate.candidate.input.offer_id,
            };
            let snapshot = self.host.snapshot_ref();
            let (scope, _) = snapshot.scope_member(&key)?;
            let report = snapshot.scope_report(scope.id).context("controlled scope missing")?;
            if snapshot.occupancy(scope.id) == 0 && report.metadata.valid_until <= local_now()? {
                let mut report = report.clone();
                report.metadata.version.sequence = report.metadata.version.sequence.checked_add(1).context("scope sequence overflow")?;
                report.metadata.observed_at = snapshot.now();
                report.metadata.valid_until = UnixMillis(local_now()?.0 + 604_800_000);
                self.publish_supply(format!("controlled/scope/{:?}/{}", scope.id, report.metadata.version.sequence), ExchangeCommand::ScopeReport(report)).await?;
            }
            let snapshot = self.host.snapshot_ref();
            let Some(source) = snapshot.sources().get(&key) else { continue; };
            let Some(option) = &source.option else { continue; };
            let sale = &snapshot.sells()[&option.order];
            let (scope, _) = snapshot.scope_member(&key)?;
            // Unknown, accepted or executing work retains the shared physical
            // slot. A consumed sale alone is never evidence of free capacity.
            let renew = refill && source.withdrawn && sale.allocation().is_closed()
                && snapshot.occupancy(scope.id) == 0;
            if renew {
                refill = false;
                let mut submission = snapshot.manual_seller_orders()
                    .and_then(|orders| orders.get(&option.order))
                    .context("controlled seller provenance missing")?.submission().clone();
                ensure!(submission.order.options.len() == 1, "controlled seller must be finite");
                let generation = source.generation.checked_add(1).context("seller generation overflow")?;
                let at = snapshot.now();
                let until = UnixMillis(local_now()?.0.max(at.0).checked_add(604_800_000).context("seller validity overflow")?);
                let stem = format!("controlled/{}/{generation}", key.offering_id);
                submission.idempotency_key = format!("{stem}/sale");
                submission.order.reference = OrderRef::new(self.config.market_id.clone(), OrderSide::Sell,
                    source.ask.provider_id, stem.clone())?;
                submission.order.opportunity_id = stem.clone();
                submission.order.tif = TimeInForce::Gtd { expires_at: until };
                submission.order.options[0].expected_binding_generation = source.generation;
                submission.order.options[0].ask.valid_until = until;
                // Use a bounded identity, rather than extending prior strings.
                for service in &mut submission.services {
                    service.schedule.reference = format!("{stem}/service");
                    service.schedule.revision = generation;
                }
                self.publish_supply(format!("{stem}/sale"), ExchangeCommand::SubmitManualSellerOrder(Box::new(submission))).await?;
            }
            // Repair interrupted publication on restart using the committed
            // source generation and deterministic operation identities.
            let snapshot = self.host.snapshot_ref();
            let source = snapshot.sources()[&key].clone();
            let (scope, _) = snapshot.scope_member(&key)?;
            if !source.withdrawn && source.generation > 1 && snapshot.occupancy(scope.id) == 0 {
                let at = snapshot.now();
                let until = source.ask.valid_until;
                let generation = source.generation;
                let stem = format!("controlled/{}/{generation}", key.offering_id);
                let current = snapshot.books()[&key.market_id].get_offering(key.offering_id)
                    .and_then(|o| o.offering());
                // Only missing evidence is supplied. Replaying an existing
                // operation must use its original bytes, never a new clock.
                if current.is_some_and(|o| o.readiness != Readiness::Ready) {
                    self.publish_supply(format!("{stem}/ready"), ExchangeCommand::Execution(Box::new(ExecutionCommand::RefreshSupply {
                        provider_id: source.ask.provider_id, source: key.clone(), generation,
                        state: SupplyState { readiness: Readiness::Ready,
                            throughput: ThroughputClaim { profile_ref: candidate.candidate.context.profile.reference.clone(),
                                rate: ThroughputRate { output_tokens: 1, completed_requests: 1, interval_ms: 1000 } },
                            observed_at: at, valid_until: until },
                    }))).await?;
                }
                let snapshot = self.host.snapshot_ref();
                if snapshot.books()[&key.market_id].get_throughput_observation(key.offering_id).is_none() {
                    let offering = snapshot.books()[&key.market_id].get_offering(key.offering_id)
                        .and_then(|o| o.offering()).context("controlled offering missing")?.clone();
                    let ended_at = UnixMillis(snapshot.now().0.max(offering.observed_at.0 + 1));
                    if ended_at > snapshot.now() {
                        self.publish_supply(format!("{stem}/observation-clock"), ExchangeCommand::AdvanceTime(ended_at)).await?;
                    }
                    self.publish_supply(format!("{stem}/throughput"), ExchangeCommand::Execution(Box::new(ExecutionCommand::Throughput(Box::new(
                        ThroughputObservation { offering, profile: candidate.candidate.context.profile.clone(),
                            started_at: UnixMillis(ended_at.0 - 1), ended_at, valid_until: until,
                            demand_sufficient: true, completed_requests: 1, failed_requests: 0,
                            billable_output_tokens: 48, p95_e2e_ms: Some(1) }
                    ))))).await?;
                }
            }
            let snapshot = self.host.snapshot_ref();
            let source = &snapshot.sources()[&key];
            let Some(offering) = snapshot.books()[&key.market_id].get_offering(key.offering_id).and_then(|o| o.offering()) else { continue; };
            let (scope, _) = snapshot.scope_member(&key)?;
            let report = snapshot.scope_report(scope.id).context("controlled scope missing")?;
            candidate.candidate.input.offering = offering.clone();
            candidate.candidate.input.throughput_observation = snapshot.books()[&key.market_id].get_throughput_observation(key.offering_id).cloned();
            candidate.candidate.source_generation = source.generation;
            candidate.candidate.seller_option = source.option.clone();
            candidate.candidate.load_report = report.metadata.clone();
            candidate.candidate.input.load.version = report.metadata.version.sequence;
            candidate.candidate.input.load.observed_at = report.metadata.observed_at;
            candidate.candidate.input.load.valid_until = report.metadata.valid_until;
            candidate.candidate.service = snapshot.seller_service(&key).context("controlled service missing")?.schedule
                .freeze(candidate.candidate.context.profile.request_size)?;
        }
        Ok(())
    }
}
