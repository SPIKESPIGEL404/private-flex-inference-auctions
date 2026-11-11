#![cfg(feature = "sqlite-tools")]
//! Incremental durability keeps the exact original decision, never a new one.
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
use bitrouter_market::{durable::*, exchange::*, order::MicroUsd};
use rusqlite::Connection;
use std::path::PathBuf;
struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "conditional-checkpoint-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn db(&self) -> PathBuf {
        self.0.join("market.sqlite")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn credit(m: &mut DurableMarketHost, n: u64) {
    m.execute(
        format!("credit-{n}"),
        ExchangeCommand::Credit {
            buyer_id: 1,
            amount: MicroUsd(1),
        },
    )
    .unwrap();
}
#[test]
fn periodic_checkpoint_and_tail_recover_original_receipts_and_read_only_views() {
    let dir = Dir::new();
    let mut m = DurableMarketHost::create(dir.db(), pf::bootstrap(false)).unwrap();
    for n in 1..=70 {
        credit(&mut m, n);
    }
    let c = Connection::open(dir.db()).unwrap();
    assert_eq!(
        c.query_row("SELECT revision FROM state_snapshot", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        64
    );
    let fence = c
        .query_row("SELECT fence FROM metadata", [], |r| r.get::<_, i64>(0))
        .unwrap();
    let expected = m.host().unwrap().snapshot();
    assert_eq!(
        DurableMarketHost::read_committed(dir.db())
            .unwrap()
            .snapshot(),
        expected
    );
    assert_eq!(
        c.query_row("SELECT fence FROM metadata", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        fence
    );
    drop(m);
    let mut m = DurableMarketHost::open(dir.db()).unwrap();
    assert_eq!(m.host().unwrap().snapshot(), expected);
    assert_eq!(
        m.execute(
            "credit-1".into(),
            ExchangeCommand::Credit {
                buyer_id: 1,
                amount: MicroUsd(1)
            }
        )
        .unwrap(),
        ExchangeReceipt::Credited {
            buyer_id: 1,
            balance: MicroUsd(1)
        }
    );
    assert_eq!(m.host().unwrap().snapshot(), expected);
    m.checkpoint().unwrap();
    assert_eq!(
        c.query_row("SELECT revision FROM state_snapshot", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        70
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        70
    );
    drop(m);
    assert_eq!(
        DurableMarketHost::open(dir.db())
            .unwrap()
            .host()
            .unwrap()
            .snapshot(),
        expected
    );
}
#[test]
fn read_transaction_observes_one_revision_while_writer_continues() {
    let dir = Dir::new();
    let mut m = DurableMarketHost::create(dir.db(), pf::bootstrap(false)).unwrap();
    credit(&mut m, 1);
    let mut c = Connection::open(dir.db()).unwrap();
    let tx = c.transaction().unwrap();
    let original = DurableMarketHost::read_committed_in(&tx)
        .unwrap()
        .snapshot();
    credit(&mut m, 2);
    assert_eq!(
        DurableMarketHost::read_committed_in(&tx)
            .unwrap()
            .snapshot(),
        original
    );
    tx.commit().unwrap();
    assert_eq!(
        DurableMarketHost::read_committed(dir.db())
            .unwrap()
            .snapshot()
            .revision(),
        2
    );
}
#[test]
fn missing_corrupt_or_gapped_tail_never_resets_a_ledger() {
    for sql in [
        "DELETE FROM events WHERE seq=2",
        "UPDATE events SET payload=x'7b7d' WHERE seq=2",
        "UPDATE events SET previous_hash='wrong' WHERE seq=2",
        "DELETE FROM state_snapshot",
    ] {
        let dir = Dir::new();
        let mut m = DurableMarketHost::create(dir.db(), pf::bootstrap(false)).unwrap();
        credit(&mut m, 1);
        credit(&mut m, 2);
        drop(m);
        let c = Connection::open(dir.db()).unwrap();
        c.execute_batch(sql).unwrap();
        assert!(DurableMarketHost::open(dir.db()).is_err(), "{sql}");
        assert_eq!(
            c.query_row("SELECT head FROM metadata", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
}
#[test]
fn valid_chain_cannot_substitute_a_different_replayed_receipt() {
    use sha2::{Digest, Sha256};
    let hash = |v: &[u8]| format!("{:x}", Sha256::digest(v));
    let dir = Dir::new();
    let mut m = DurableMarketHost::create(dir.db(), pf::bootstrap(false)).unwrap();
    credit(&mut m, 1);
    credit(&mut m, 2);
    drop(m);
    let c = Connection::open(dir.db()).unwrap();
    let (bytes, previous): (Vec<u8>, String) = c
        .query_row(
            "SELECT payload,previous_hash FROM events WHERE seq=2",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["record"]["receipt"]["Credited"]["balance"] = 999.into();
    let bytes = serde_json::to_vec(&value).unwrap();
    let checksum = hash(&bytes);
    let mut chain = previous.into_bytes();
    chain.push(0);
    chain.extend_from_slice(&bytes);
    let digest = hash(&chain);
    c.execute(
        "UPDATE events SET payload=?,checksum=?,event_hash=? WHERE seq=2",
        rusqlite::params![bytes, checksum, digest],
    )
    .unwrap();
    c.execute("UPDATE metadata SET head_hash=?", [digest])
        .unwrap();
    assert!(matches!(
        DurableMarketHost::open(dir.db()),
        Err(DurableError::Corrupt(
            "tail receipt, grants or effects changed"
        ))
    ));
}
#[test]
fn schema_three_and_semantic_probe_ledgers_are_not_reinterpreted_or_migrated() {
    for version in [3, 4, 5] {
        let dir = Dir::new();
        let mut m = DurableMarketHost::create(dir.db(), pf::bootstrap(false)).unwrap();
        credit(&mut m, 1);
        drop(m);
        let c = Connection::open(dir.db()).unwrap();
        c.execute("UPDATE metadata SET version=?", [version])
            .unwrap();
        assert!(DurableMarketHost::open(dir.db()).is_err());
        assert_eq!(
            c.query_row("SELECT version FROM metadata", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            version
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
#[test]
fn checkpoint_crash_worker() {
    let Some(path) = std::env::var_os("BITROUTER_CONDITIONAL_CHECKPOINT_DIR") else {
        return;
    };
    let mut m = DurableMarketHost::create(
        PathBuf::from(path).join("market.sqlite"),
        pf::bootstrap(false),
    )
    .unwrap();
    for n in 1..64 {
        credit(&mut m, n);
    }
    m.set_failpoint(Some(
        if std::env::var("BITROUTER_CONDITIONAL_CHECKPOINT_AFTER").unwrap() == "yes" {
            FaultPoint::MarketAfterCommit
        } else {
            FaultPoint::MarketBeforeCommit
        },
    ));
    credit(&mut m, 64);
    panic!("failpoint did not exit");
}
#[test]
fn checkpoint_boundary_crashes_recover_either_original_tail_or_atomic_new_cut() {
    for after in [false, true] {
        let dir = Dir::new();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "checkpoint_crash_worker"])
            .env("BITROUTER_CONDITIONAL_CHECKPOINT_DIR", &dir.0)
            .env(
                "BITROUTER_CONDITIONAL_CHECKPOINT_AFTER",
                if after { "yes" } else { "no" },
            )
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86));
        let m = DurableMarketHost::open(dir.db()).unwrap();
        assert_eq!(
            m.host().unwrap().snapshot().revision(),
            if after { 64 } else { 63 }
        );
        assert_eq!(
            m.host().unwrap().snapshot().accounts()[&1].balance(),
            MicroUsd(if after { 64 } else { 63 })
        );
        let c = Connection::open(dir.db()).unwrap();
        assert_eq!(
            c.query_row("SELECT revision FROM state_snapshot", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            if after { 64 } else { 1 }
        );
    }
}
