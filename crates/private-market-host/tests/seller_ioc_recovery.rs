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
#[allow(dead_code)]
#[path = "support/seller_fixture.rs"]
mod sf;
use bitrouter_market::admission::*;
use bitrouter_market::authorization::OrderRef;
use bitrouter_market::durable::*;
use bitrouter_market::exchange::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::formal_order::DriveFormalOrders;
use bitrouter_market::order::*;
use bitrouter_market::seller_order::*;
use std::path::PathBuf;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "bitrouter-seller-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn market(&self) -> PathBuf {
        self.0.join("market.sqlite")
    }
    fn authority(&self) -> PathBuf {
        self.0.join("authority.sqlite")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Round {
    seller: OrderRef,
    input: DriveFormalOrders,
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct Decisions {
    decisions: Vec<PurchaseDecisionReceipt>,
    unallocated_options: Vec<bitrouter_market::authorization::OptionId>,
}
fn setup(
    dir: &Dir,
) -> (
    DurableMarketHost,
    DurableAuthority,
    RegisterSellerOrder,
    Round,
) {
    let (mut h, a, sellers) = sf::independent_setup(false, true);
    let r = sellers[0].clone();
    let _p1 = sf::buyer(&mut h, 1, "a", "first", false);
    let _p2 = sf::buyer(&mut h, 2, "b", "second", false);
    let round = Round {
        seller: r.order.reference.clone(),
        input: sf::drive_input(&h, "drive-ioc"),
    };
    let mut m = DurableMarketHost::create(dir.market(), sf::bootstrap(false)).unwrap();
    for (key, c) in h.journal().commands() {
        m.execute(key.clone(), c.clone()).unwrap();
    }
    let a = DurableAuthority::create(dir.authority(), a, m.resolver()).unwrap();
    (m, a, r, round)
}
fn decide(m: &mut DurableMarketHost, input: &Round) -> Decisions {
    match m
        .execute(
            input.input.idempotency_key.clone(),
            ExchangeCommand::DriveFormalOrders(input.input.clone()),
        )
        .unwrap()
    {
        ExchangeReceipt::FormalOrdersDriven(r) => Decisions {
            decisions: r
                .reviewed
                .into_iter()
                .filter_map(|(_, r)| r.decision)
                .collect(),
            unallocated_options: m
                .host()
                .unwrap()
                .snapshot()
                .seller_orders()
                .unwrap()
                .values()
                .filter_map(|s| s.round())
                .flat_map(|r| r.unallocated_options.clone())
                .collect(),
        },
        _ => panic!("drive receipt"),
    }
}
fn query(
    m: &mut DurableMarketHost,
    a: &mut DurableAuthority,
    id: &AttemptId,
    kind: ExecutionRequestKind,
    key: &str,
) -> ExecutionReport {
    m.execute(
        key.into(),
        ExchangeCommand::Frozen(Box::new(FrozenCommand::Request {
            attempt: id.clone(),
            kind,
        })),
    )
    .unwrap();
    let request = pf::request(m.host().unwrap(), id, kind);
    m.dispatch(&request.effect_id, a).unwrap()
}
fn receive(m: &mut DurableMarketHost, a: &DurableAuthority, key: &str, report: ExecutionReport) {
    m.receive(key.into(), a.authority().unwrap().origin(), report)
        .unwrap();
}

#[test]
fn seller_crash_worker() {
    let Some(path) = std::env::var_os("BITROUTER_SELLER_CRASH_DIR") else {
        return;
    };
    let dir = Dir(PathBuf::from(path));
    let action = std::env::var("BITROUTER_SELLER_CRASH_ACTION").unwrap();
    if action.ends_with("register") {
        let mut m = DurableMarketHost::create(dir.market(), sf::bootstrap(false)).unwrap();
        let r = sf::registration(true);
        std::fs::write(dir.0.join("register.json"), serde_json::to_vec(&r).unwrap()).unwrap();
        m.set_failpoint(Some(if action == "before-register" {
            FaultPoint::MarketBeforeCommit
        } else {
            FaultPoint::MarketAfterCommit
        }));
        m.execute(
            r.idempotency_key.clone(),
            ExchangeCommand::RegisterSellerOrder(Box::new(r)),
        )
        .unwrap();
    } else {
        let (mut m, mut a, _r, round) = setup(&dir);
        if action == "no-g" {
            m.execute(
                "pause".into(),
                ExchangeCommand::Execution(Box::new(ExecutionCommand::Pause(true))),
            )
            .unwrap();
        }
        std::fs::write(
            dir.0.join("round.json"),
            serde_json::to_vec(&round).unwrap(),
        )
        .unwrap();
        if ["before-round", "after-round", "no-g"].contains(&action.as_str()) {
            m.set_failpoint(Some(if action == "before-round" {
                FaultPoint::MarketBeforeCommit
            } else {
                FaultPoint::MarketAfterCommit
            }));
            decide(&mut m, &round);
        } else {
            let receipt = decide(&mut m, &round);
            let id = pf::id(&receipt.decisions[0]);
            if action == "after-send" {
                m.set_failpoint(Some(FaultPoint::AfterSendMarker));
            } else if action == "after-e" {
                a.set_failpoint(Some(FaultPoint::AuthorityAfterCommit));
            } else {
                panic!("unknown crash action")
            }
            let effect =
                pf::request(m.host().unwrap(), &id, ExecutionRequestKind::Submit).effect_id;
            m.dispatch(&effect, &mut a).unwrap();
        }
    }
    panic!("crash point did not terminate")
}
fn crash(dir: &Dir, action: &str) {
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "seller_crash_worker", "--nocapture"])
        .env("BITROUTER_SELLER_CRASH_DIR", &dir.0)
        .env("BITROUTER_SELLER_CRASH_ACTION", action)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(86), "{action}");
}

#[test]
fn registration_crashes_keep_either_no_source_or_original_window_and_opportunity() {
    for action in ["before-register", "after-register"] {
        let dir = Dir::new();
        crash(&dir, action);
        let r: RegisterSellerOrder =
            serde_json::from_slice(&std::fs::read(dir.0.join("register.json")).unwrap()).unwrap();
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        assert_eq!(
            m.host()
                .unwrap()
                .snapshot()
                .seller_orders()
                .unwrap()
                .contains_key(&r.order.reference),
            action == "after-register"
        );
        let receipt = m
            .execute(
                r.idempotency_key.clone(),
                ExchangeCommand::RegisterSellerOrder(Box::new(r.clone())),
            )
            .unwrap();
        let ExchangeReceipt::SellerOrderRegistered(receipt) = receipt else {
            panic!("receipt")
        };
        assert_eq!(receipt.window.registered_at, fx::NOW);
        assert_eq!(
            receipt.window.decision_before,
            UnixMillis(fx::NOW.0 + 5_000)
        );
        let before = m.host().unwrap().snapshot();
        assert_eq!(
            m.execute(
                r.idempotency_key.clone(),
                ExchangeCommand::RegisterSellerOrder(Box::new(r))
            )
            .unwrap(),
            ExchangeReceipt::SellerOrderRegistered(receipt)
        );
        assert_eq!(m.host().unwrap().snapshot(), before);
    }
}

#[test]
fn internal_drive_crashes_recover_all_or_no_g_and_final_independent_rounds() {
    for action in ["before-round", "after-round", "no-g"] {
        let dir = Dir::new();
        crash(&dir, action);
        let round: Round =
            serde_json::from_slice(&std::fs::read(dir.0.join("round.json")).unwrap()).unwrap();
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        let s = m.host().unwrap().snapshot();
        assert_eq!(
            s.purchase_trades().unwrap().len(),
            if action == "after-round" { 2 } else { 0 }
        );
        assert_eq!(
            s.seller_orders().unwrap()[&round.seller].round().is_some(),
            action != "before-round"
        );
        let receipt = decide(&mut m, &round);
        if action != "no-g" {
            assert_eq!(receipt.decisions[0].competition_seq, 1);
            assert_eq!(receipt.decisions[1].competition_seq, 2);
            assert_eq!(
                m.host().unwrap().snapshot().frozen_grants().unwrap().len(),
                2
            );
        } else {
            assert_eq!(receipt.unallocated_options.len(), 2);
        }
        let expected = m.host().unwrap().snapshot();
        drop(m);
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        assert_eq!(m.host().unwrap().snapshot(), expected);
        assert_eq!(decide(&mut m, &round), receipt);
        assert_eq!(m.host().unwrap().snapshot(), expected);
    }
}

#[test]
fn send_and_e_crashes_keep_closed_seller_and_original_task_or_not_found_responsibility() {
    for action in ["after-send", "after-e"] {
        let dir = Dir::new();
        crash(&dir, action);
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        let mut a = DurableAuthority::open(dir.authority()).unwrap();
        let round: Round =
            serde_json::from_slice(&std::fs::read(dir.0.join("round.json")).unwrap()).unwrap();
        let receipt = decide(&mut m, &round);
        let id = pf::id(&receipt.decisions[0]);
        let submit = m
            .host()
            .unwrap()
            .snapshot()
            .execution_requests()
            .unwrap()
            .values()
            .find(|r| r.binding.attempt_id == id && r.kind == ExecutionRequestKind::Submit)
            .unwrap()
            .clone();
        assert!(m.dispatch(&submit.effect_id, &mut a).is_err());
        let report = query(
            &mut m,
            &mut a,
            &id,
            ExecutionRequestKind::Query,
            "reconcile",
        );
        if action == "after-send" {
            assert!(matches!(
                report.observation,
                ExecutionReportState::NotFound { .. }
            ));
            receive(&mut m, &a, "not-found", report);
            assert_eq!(
                m.host().unwrap().snapshot().accounts()[&1].held(),
                MicroUsd(100)
            );
            assert_eq!(
                m.host().unwrap().snapshot().occupancy(AdmissionScopeId(30)),
                1
            );
            let report = query(
                &mut m,
                &mut a,
                &id,
                ExecutionRequestKind::FenceUnaccepted,
                "fence",
            );
            receive(&mut m, &a, "fenced", report);
        } else {
            assert!(matches!(
                report.observation,
                ExecutionReportState::Accepted { .. }
            ));
            receive(&mut m, &a, "accepted", report);
            let task = a.authority().unwrap().attempts()[&("exchange".into(), id.clone())]
                .task_id
                .clone();
            assert!(task.is_some());
            let now = m.host().unwrap().snapshot().now();
            a.start_pending(now).unwrap();
            a.start_pending(now).unwrap();
            assert_eq!(a.task_start_count("exchange", &id).unwrap(), 1);
            a.finish(
                "exchange",
                &id,
                ExecutionOutcome::Completed,
                Some(TokenUsage {
                    uncached_input_tokens: 10,
                    cached_input_tokens: 0,
                    billable_output_tokens: 1,
                }),
                now,
            )
            .unwrap();
            let report = query(
                &mut m,
                &mut a,
                &id,
                ExecutionRequestKind::Query,
                "terminal-query",
            );
            receive(&mut m, &a, "terminal", report.clone());
            let before = m.host().unwrap().snapshot();
            receive(&mut m, &a, "repeat-terminal", report);
            assert_eq!(m.host().unwrap().snapshot().accounts(), before.accounts());
            assert_eq!(
                m.host().unwrap().snapshot().accounts()[&1].balance(),
                MicroUsd(1000)
            );
            assert_eq!(
                a.authority().unwrap().attempts()[&("exchange".into(), id.clone())].task_id,
                task
            );
        }
        assert!(m.host().unwrap().snapshot().sells()[&round.seller]
            .allocation()
            .is_closed());
        assert_eq!(
            m.host()
                .unwrap()
                .snapshot()
                .purchase_trades()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            m.host().unwrap().snapshot().occupancy(AdmissionScopeId(31)),
            1
        );
        drop(a);
        drop(m);
        let m = DurableMarketHost::open(dir.market()).unwrap();
        assert!(m.host().unwrap().snapshot().sells()[&round.seller]
            .allocation()
            .is_closed());
    }
}

#[test]
fn second_outbox_sql_failure_rolls_back_entire_round_buyer_keys_and_both_gs() {
    let dir = Dir::new();
    let (mut m, _a, _r, round) = setup(&dir);
    let db = rusqlite::Connection::open(dir.market()).unwrap();
    db.execute_batch("CREATE TRIGGER reject_second_g BEFORE INSERT ON outbox WHEN (SELECT COUNT(*) FROM outbox) >= 1 BEGIN SELECT RAISE(ABORT,'second g failure'); END;").unwrap();
    assert!(m
        .execute(
            round.input.idempotency_key.clone(),
            ExchangeCommand::DriveFormalOrders(round.input.clone())
        )
        .is_err());
    assert!(matches!(m.host(), Err(DurableError::Poisoned)));
    drop(m);
    db.execute_batch("DROP TRIGGER reject_second_g").unwrap();
    drop(db);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    let s = m.host().unwrap().snapshot();
    assert!(s.purchase_trades().unwrap().is_empty());
    assert!(s.purchase_decisions().unwrap().is_empty());
    assert!(s.frozen_grants().unwrap().is_empty());
    assert!(s.seller_orders().unwrap()[&round.seller].round().is_none());
    let receipt = decide(&mut m, &round);
    assert_eq!(
        receipt
            .decisions
            .iter()
            .map(|d| d.competition_seq)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
}
