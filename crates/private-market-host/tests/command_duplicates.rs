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

use bitrouter_market::{
    durable::{DurableError, DurableMarketHost},
    exchange::{ExchangeCommand, ExchangeError, PrepareOutcome},
    formal_order::ProviderScope,
    market_host::HostError,
    order::{MicroUsd, UnixMillis},
};

#[test]
fn receipt_probe_shares_normalization_full_identity_and_validation_with_prepare() {
    let mut host = pf::bootstrap(false);
    let mut input = pf::registration("duplicate", 1, &["a", "b"], false);
    input.provider_scope = ProviderScope::Only {
        provider_ids: vec![9, 7],
    };
    let key = input.idempotency_key.clone();
    let command = |input, agent_id| ExchangeCommand::PlaceFormalOrderByAgent {
        input: Box::new(input),
        agent_id,
    };
    assert_eq!(
        host.duplicate_receipt(&key, &command(input.clone(), 42))
            .unwrap(),
        None
    );
    let receipt = host
        .execute(key.clone(), command(input.clone(), 42))
        .unwrap();
    input.provider_scope = ProviderScope::Only {
        provider_ids: vec![7, 9],
    };
    assert_eq!(
        host.duplicate_receipt(&key, &command(input.clone(), 42))
            .unwrap(),
        Some(receipt.clone())
    );
    assert!(matches!(
        host.prepare(key.clone(), command(input.clone(), 42)).unwrap(),
        PrepareOutcome::Duplicate(r) if r == receipt
    ));
    let unchanged = host.snapshot();
    let mut payload = input.clone();
    payload.authorization.max_charge = MicroUsd(101);
    let mut reordered_options = input.clone();
    reordered_options.authorization.options.reverse();
    for changed in [
        command(payload, 42),
        command(reordered_options, 42),
        command(input.clone(), 43),
        ExchangeCommand::PlaceFormalOrder(Box::new(input.clone())),
    ] {
        assert_eq!(host.duplicate_receipt(&key, &changed).unwrap(), None);
        assert!(matches!(
            host.prepare(key.clone(), changed).unwrap(),
            PrepareOutcome::Rejected(ExchangeError::Conflict("idempotency"))
        ));
    }
    assert_eq!(
        host.duplicate_receipt("other-key", &command(input.clone(), 42))
            .unwrap(),
        None
    );
    assert!(matches!(
        host.prepare("other-key".into(), command(input.clone(), 42))
            .unwrap(),
        PrepareOutcome::Rejected(ExchangeError::Conflict("command key binding"))
    ));
    let mut invalid = input.clone();
    invalid.provider_scope = ProviderScope::Only {
        provider_ids: vec![7, 7],
    };
    assert_eq!(
        host.duplicate_receipt(&key, &command(invalid.clone(), 42))
            .unwrap(),
        None
    );
    // Canonicalization errors precede invalid IDs, key binding and equality.
    for bad_key in [key.as_str(), "", "other-key"] {
        assert!(matches!(
            host.prepare(bad_key.into(), command(invalid.clone(), 42))
                .unwrap(),
            PrepareOutcome::Rejected(ExchangeError::Purchase(_))
        ));
    }
    assert_eq!(
        host.duplicate_receipt("", &command(input.clone(), 42))
            .unwrap(),
        None
    );
    assert!(matches!(
        host.prepare("".into(), command(input.clone(), 42)).unwrap(),
        PrepareOutcome::Rejected(ExchangeError::InvalidId)
    ));
    assert_eq!(host.snapshot(), unchanged);

    host.execute(
        "move-clock".into(),
        ExchangeCommand::AdvanceTime(UnixMillis(10_000)),
    )
    .unwrap();
    assert_eq!(
        host.duplicate_receipt(&key, &command(input, 42)).unwrap(),
        Some(receipt)
    );
}

#[test]
fn receipt_probe_keeps_actor_scoping_and_external_command_gate() {
    let mut host = fixture::bootstrap(false);
    let key = "credit";
    let credit = |buyer_id| ExchangeCommand::Credit {
        buyer_id,
        amount: MicroUsd(100),
    };
    let receipt = host.execute(key.into(), credit(1)).unwrap();
    assert_eq!(
        host.duplicate_receipt(key, &credit(1)).unwrap(),
        Some(receipt)
    );
    assert_eq!(host.duplicate_receipt(key, &credit(2)).unwrap(), None);
    assert!(matches!(
        host.prepare(key.into(), credit(2)).unwrap(),
        PrepareOutcome::Prepared(_)
    ));
    assert!(matches!(
        host.duplicate_receipt("host/internal", &credit(1)),
        Err(HostError::InternalCommand)
    ));
    assert!(matches!(
        host.prepare("host/internal".into(), credit(1)),
        Err(HostError::InternalCommand)
    ));
}

#[test]
fn durable_receipt_probe_cannot_bypass_fencing_or_poisoning() {
    for fence in [false, true] {
        let path = std::env::temp_dir().join(format!(
            "market-command-probe-{}-{}-{fence}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut host = DurableMarketHost::create(&path, fixture::bootstrap(false)).unwrap();
        let command = ExchangeCommand::Credit {
            buyer_id: 1,
            amount: MicroUsd(100),
        };
        let receipt = host.execute("credit".into(), command.clone()).unwrap();
        assert_eq!(
            host.duplicate_receipt("credit", &command).unwrap(),
            Some(receipt)
        );
        let db = rusqlite::Connection::open(&path).unwrap();
        if fence {
            db.execute("UPDATE metadata SET fence=fence+1", []).unwrap();
            assert!(matches!(
                host.duplicate_receipt("credit", &command),
                Err(DurableError::Fenced)
            ));
            assert!(matches!(
                host.prepare("credit".into(), command),
                Err(DurableError::Fenced)
            ));
        } else {
            db.execute_batch("CREATE TRIGGER reject_command BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'command failure'); END;").unwrap();
            assert!(host.execute("next-credit".into(), command.clone()).is_err());
            assert!(matches!(
                host.duplicate_receipt("credit", &command),
                Err(DurableError::Poisoned)
            ));
            assert!(matches!(
                host.prepare("credit".into(), command),
                Err(DurableError::Poisoned)
            ));
        }
        drop(db);
        drop(host);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite.lock"));
    }
}
