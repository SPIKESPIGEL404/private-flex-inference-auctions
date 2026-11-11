#![cfg(feature = "sqlite-tools")]
#[allow(dead_code)]
mod common;
#[allow(dead_code)]
#[path = "support/frozen_fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "support/conditional_exchange.rs"]
mod fx;
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;

use bitrouter_market::durable::{DurableAuthority, DurableError, DurableMarketHost};
use bitrouter_market::exchange::{ExchangeCommand, ExchangeError, PrepareOutcome};
use bitrouter_market::execution_contract::ExecutionRequestKind;
use bitrouter_market::market_host::HostError;
use bitrouter_market::order::MicroUsd;
use rusqlite::Connection;
use std::path::PathBuf;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "market-convergence-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn market(&self) -> PathBuf {
        self.0.join("market.sqlite")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn preparation_cannot_cross_divergent_writers_at_the_same_revision() {
    let seed = pf::bootstrap(false);
    let mut left = seed.clone();
    let mut right = seed;
    let credit = ExchangeCommand::Credit {
        buyer_id: 1,
        amount: MicroUsd(5),
    };
    left.execute("left".into(), credit.clone()).unwrap();
    right.execute("right".into(), credit.clone()).unwrap();
    assert_eq!(left.snapshot(), right.snapshot());
    let PrepareOutcome::Prepared(prepared) = left.prepare("more".into(), credit).unwrap() else {
        panic!("prepared")
    };
    let before = right.snapshot();
    assert!(matches!(
        right.publish(*prepared),
        Err(HostError::Market(ExchangeError::StalePlan))
    ));
    assert_eq!(right.snapshot(), before);
}

#[test]
fn bootstrap_policy_changes_invalidate_prepared_values_without_a_revision_change() {
    let host = fixture::bootstrap(false);
    let PrepareOutcome::Prepared(prepared) = host
        .prepare(
            "credit".into(),
            ExchangeCommand::Credit {
                buyer_id: 1,
                amount: MicroUsd(5),
            },
        )
        .unwrap()
    else {
        panic!("prepared")
    };
    let mut host = host.with_purchase_orders(pf::policy()).unwrap();
    assert_eq!(host.snapshot().revision(), 0);
    assert!(matches!(
        host.publish(*prepared),
        Err(HostError::Market(ExchangeError::StalePlan))
    ));
    assert!(host.snapshot().purchase_orders().unwrap().is_empty());
    assert!(host.snapshot().accounts().is_empty());
}

#[test]
fn resolver_checks_its_original_g_but_corrupt_event_history_stops_writer_recovery() {
    for corrupt_grant_event in [false, true] {
        let dir = Dir::new();
        let (seed, authority) = pf::setup(false, false);
        let mut market = DurableMarketHost::create(dir.market(), pf::bootstrap(false)).unwrap();
        for (key, command) in seed.journal().commands() {
            market.execute(key.clone(), command.clone()).unwrap();
        }
        let order = pf::registration("snapshot", 1, &["a"], false);
        market
            .execute(
                order.idempotency_key.clone(),
                ExchangeCommand::PlaceFormalOrder(Box::new(order.clone())),
            )
            .unwrap();
        let quote = pf::publication(market.host().unwrap(), &order, 1, "snapshot");
        market
            .execute(
                "quote".into(),
                ExchangeCommand::PurchaseQuote(Box::new(quote)),
            )
            .unwrap();
        market.drive_formal_due(32).unwrap();
        let request = market
            .host()
            .unwrap()
            .snapshot()
            .execution_requests()
            .unwrap()
            .values()
            .find(|r| r.kind == ExecutionRequestKind::Submit)
            .unwrap()
            .clone();
        let resolver = market.resolver();
        let authority =
            DurableAuthority::create(dir.0.join("authority.sqlite"), authority, market.resolver())
                .unwrap();
        drop(market);
        let sql = Connection::open(dir.market()).unwrap();
        let revision: i64 = if corrupt_grant_event {
            sql.query_row("SELECT revision FROM grants LIMIT 1", [], |r| r.get(0))
                .unwrap()
        } else {
            sql.query_row("SELECT min(seq) FROM events", [], |r| r.get(0))
                .unwrap()
        };
        sql.execute("UPDATE events SET payload=x'7b7d' WHERE seq=?", [revision])
            .unwrap();
        drop(sql);
        assert_eq!(
            resolver.resolve(&request.binding).is_ok(),
            !corrupt_grant_event
        );
        assert!(DurableMarketHost::open(dir.market()).is_err());
        assert!(authority.authority().unwrap().attempts().is_empty());
    }
}

#[test]
fn current_snapshot_is_required_and_bad_storage_never_resets_the_ledger() {
    for damage in [
        "DELETE FROM state_snapshot",
        "UPDATE state_snapshot SET payload=x'7b7d'",
        "UPDATE metadata SET version=999",
    ] {
        let dir = Dir::new();
        let mut market = DurableMarketHost::create(dir.market(), pf::bootstrap(false)).unwrap();
        market
            .execute(
                "credit".into(),
                ExchangeCommand::Credit {
                    buyer_id: 1,
                    amount: MicroUsd(5),
                },
            )
            .unwrap();
        assert!(matches!(
            DurableMarketHost::open(dir.market()),
            Err(DurableError::Locked)
        ));
        drop(market);
        let sql = Connection::open(dir.market()).unwrap();
        sql.execute(damage, []).unwrap();
        drop(sql);
        assert!(DurableMarketHost::open(dir.market()).is_err());
        let sql = Connection::open(dir.market()).unwrap();
        assert_eq!(
            sql.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

#[test]
fn current_capacity_ledger_retains_unknown_when_reports_omit_it_or_change_generation() {
    use bitrouter_market::exchange::FrozenCommand;
    let (mut host, _) = pf::setup(true, false);
    let order = pf::registration("capacity", 1, &["a"], false);
    pf::register(&mut host, &order);
    let quote = pf::publication(&host, &order, 1, "capacity");
    pf::publish(&mut host, &quote);
    let proposal = pf::proposal(&host, &order, &[quote], "capacity");
    let attempt = pf::id(&pf::propose(&mut host, &proposal));
    host.execute(
        "contact-lost".into(),
        ExchangeCommand::Frozen(Box::new(FrozenCommand::ContactLost(attempt.clone()))),
    )
    .unwrap();
    for generation in [1, 2] {
        let mut report = fx::report(30, 2, vec![]);
        report.metadata.version.generation = generation;
        host.execute(
            format!("report-{generation}"),
            ExchangeCommand::ScopeReport(report),
        )
        .unwrap();
        let state = host.snapshot();
        assert_eq!(
            state.occupancy(bitrouter_market::admission::AdmissionScopeId(30)),
            1
        );
        assert!(state.purchase_trades().unwrap()[&attempt].unknown);
        assert_eq!(state.accounts()[&1].held(), MicroUsd(100));
    }
    let before = host.snapshot();
    assert!(host
        .execute(
            "old-report".into(),
            ExchangeCommand::ScopeReport(fx::report(30, 1, vec![]))
        )
        .is_err());
    assert_eq!(host.snapshot(), before);
}

#[test]
fn restored_authority_cannot_change_its_resource_identity_even_with_a_valid_checksum() {
    use bitrouter_market::admission::AdmissionScopeId;
    use sha2::{Digest, Sha256};
    let dir = Dir::new();
    let market = DurableMarketHost::create(dir.market(), pf::bootstrap(false)).unwrap();
    let authority_path = dir.0.join("authority.sqlite");
    let mut authority = DurableAuthority::create(
        &authority_path,
        fixture::authority(false, fx::NOW),
        market.resolver(),
    )
    .unwrap();
    authority.set_ready(AdmissionScopeId(30), false).unwrap();
    drop(authority);
    let sql = Connection::open(&authority_path).unwrap();
    let bytes: Vec<u8> = sql
        .query_row("SELECT payload FROM state_snapshot", [], |r| r.get(0))
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["targets"][0]["backend_ref"] = "different-resource".into();
    let bytes = serde_json::to_vec(&value).unwrap();
    let checksum = format!("{:x}", Sha256::digest(&bytes));
    sql.execute(
        "UPDATE state_snapshot SET payload=?,checksum=?",
        rusqlite::params![bytes, checksum],
    )
    .unwrap();
    drop(sql);
    assert!(DurableAuthority::open(&authority_path).is_err());
}
