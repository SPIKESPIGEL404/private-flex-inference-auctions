use crate::{fx, mf, pf};
use bitrouter_market::execution_authorization::FrozenIdentity;
use bitrouter_market::manual_market::*;
use bitrouter_market::manual_seller_order::SubmitManualSellerOrder;
use bitrouter_market::order::UnixMillis;
use bitrouter_market::purchase_order::TimeInForce;
use std::path::PathBuf;

pub fn config(now: UnixMillis) -> ManualMarketConfig {
    let scopes = fx::scopes(false);
    let mut policy = pf::policy();
    policy.time.immediate_decision_window_ms = 5000;
    policy.time.immediate_total_window_ms = 6000;
    ManualMarketConfig {
        version: MANUAL_MARKET_VERSION,
        rules_ref: MANUAL_MARKET_RULES.into(),
        exchange_id: "exchange".into(),
        specs: vec![fx::spec("a"), fx::spec("b")],
        identities: scopes
            .iter()
            .flat_map(|s| &s.members)
            .flat_map(|m| &m.offering.backend_refs)
            .map(|b| {
                (
                    b.clone(),
                    FrozenIdentity {
                        source_epoch: 4,
                        backend_incarnation: "instance-1".into(),
                    },
                )
            })
            .collect(),
        scopes,
        initial_time: now,
        purchase_policy: policy,
        runtime: None,
    }
}
pub fn live_input(now: UnixMillis) -> SubmitManualSellerOrder {
    let mut input = mf::input(false);
    let until = UnixMillis(now.0 + 60_000);
    input.order.tif = TimeInForce::Gtd { expires_at: until };
    for option in &mut input.order.options {
        option.ask.valid_until = until;
    }
    input
}
pub struct Dir(pub PathBuf);
impl Dir {
    pub fn new() -> Self {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "manual-market-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    pub fn market(&self) -> PathBuf {
        self.0.join("market.sqlite")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
