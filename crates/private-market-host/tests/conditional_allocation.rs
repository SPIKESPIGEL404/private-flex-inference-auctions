use bitrouter_market::{admission::AttemptId, authorization::*, sale::SaleAllocation};
use std::collections::BTreeSet;
fn id(n: u64) -> AttemptId {
    AttemptId {
        market_id: "m".into(),
        order_id: n,
        sequence: 1,
    }
}
fn allocation() -> SaleAllocation {
    SaleAllocation::new(
        OrderRef::new("e".into(), OrderSide::Sell, 7, "offer".into()).unwrap(),
        (1..=64).map(OptionId).collect(),
    )
    .unwrap()
}
#[test]
fn exact_option_bound_and_immutable_owner_scoped_identity() {
    let r = OrderRef::new("e".into(), OrderSide::Sell, 7, "same".into()).unwrap();
    assert!(SaleAllocation::new(r.clone(), BTreeSet::new()).is_err());
    assert!(SaleAllocation::new(r, (0..65).map(OptionId).collect()).is_err());
    assert_eq!(
        BTreeSet::from([
            OrderRef::new("e".into(), OrderSide::Sell, 7, "same".into()).unwrap(),
            OrderRef::new("e".into(), OrderSide::Buy, 7, "same".into()).unwrap(),
            OrderRef::new("e".into(), OrderSide::Sell, 8, "same".into()).unwrap()
        ])
        .len(),
        3
    );
    assert!(OrderRef::new("e".into(), OrderSide::Buy, 1, "é".repeat(64)).is_ok());
    assert!(OrderRef::new("e".into(), OrderSide::Buy, 1, "é".repeat(65)).is_err());
}
#[test]
fn only_authoritative_fence_releases_and_never_resurrects_old_identity() {
    let mut a = allocation();
    a.reserve(OptionId(1), id(1)).unwrap();
    a.observe(&id(1), ResponsibilityEvent::Unknown).unwrap();
    for option in 1..=64 {
        assert!(a.check_available(OptionId(option)).is_err());
    }
    a.observe(&id(1), ResponsibilityEvent::NotExecuted).unwrap();
    assert!(a.bound_attempt().is_none());
    assert!(!a.reserve(OptionId(1), id(1)).unwrap());
    a.reserve(OptionId(2), id(2)).unwrap();
    let before = a.clone();
    assert!(a.observe(&id(1), ResponsibilityEvent::Accepted).is_err());
    assert_eq!(a, before);
}
#[test]
fn execution_terminal_consumes_without_earlier_acceptance_and_close_keeps_unknown() {
    for event in [
        ResponsibilityEvent::Accepted,
        ResponsibilityEvent::ExecutionTerminal,
    ] {
        let mut a = allocation();
        a.reserve(OptionId(1), id(1)).unwrap();
        a.observe(&id(1), ResponsibilityEvent::Unknown).unwrap();
        a.close();
        assert!(a.attempts()[&id(1)].unknown);
        a.observe(&id(1), event).unwrap();
        assert!(a.is_closed());
        assert!(a.is_consumed());
        assert!(a.observe(&id(1), ResponsibilityEvent::NotExecuted).is_err());
        assert!(a.reserve(OptionId(2), id(2)).is_err());
    }
}
#[test]
fn acceptance_replay_does_not_cure_later_contact_loss() {
    let mut a = allocation();
    a.reserve(OptionId(1), id(1)).unwrap();
    a.observe(&id(1), ResponsibilityEvent::Accepted).unwrap();
    a.observe(&id(1), ResponsibilityEvent::Unknown).unwrap();
    assert!(!a.observe(&id(1), ResponsibilityEvent::Accepted).unwrap());
    assert!(a.attempts()[&id(1)].unknown);
    a.observe(&id(1), ResponsibilityEvent::ContactConfirmed)
        .unwrap();
    assert!(!a.attempts()[&id(1)].unknown);
}
/// Independent oracle stores a single sale slot and its original facts.
#[test]
fn randomized_sequences_preserve_one_sale_idempotency_and_replay() {
    for seed in 1..=128u64 {
        let mut random = seed;
        let mut a = allocation();
        let mut states = std::collections::BTreeMap::<u64, (u32, u8)>::new();
        let mut bound = None;
        for _ in 0..1000 {
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            let n = (random >> 8) % 32;
            let option = (random >> 24) as u32 % 64 + 1;
            let action = random % 4;
            let before = a.clone();
            let expected = if action == 0 {
                if let Some((old, _)) = states.get(&n) {
                    *old == option
                } else if bound.is_none() {
                    states.insert(n, (option, 0));
                    bound = Some(n);
                    true
                } else {
                    false
                }
            } else if let Some((_, progress)) = states.get_mut(&n) {
                match action {
                    1 if *progress != 3 => {
                        if *progress == 0 {
                            *progress = 1;
                        }
                        true
                    }
                    2 if *progress == 0 || *progress == 3 => {
                        *progress = 3;
                        if bound == Some(n) {
                            bound = None;
                        }
                        true
                    }
                    3 if *progress != 3 => {
                        *progress = 2;
                        true
                    }
                    _ => false,
                }
            } else {
                false
            };
            let result = if action == 0 {
                a.reserve(OptionId(option), id(n))
            } else {
                a.observe(
                    &id(n),
                    match action {
                        1 => ResponsibilityEvent::Accepted,
                        2 => ResponsibilityEvent::NotExecuted,
                        _ => ResponsibilityEvent::ExecutionTerminal,
                    },
                )
            };
            assert_eq!(
                result.is_ok(),
                expected,
                "seed={seed} command={action} id={n}"
            );
            if !expected {
                assert_eq!(a, before);
            }
            assert_eq!(a.bound_attempt(), bound.as_ref().map(|n| id(*n)).as_ref());
            let bytes = serde_json::to_vec(&a).unwrap();
            assert_eq!(serde_json::from_slice::<SaleAllocation>(&bytes).unwrap(), a);
        }
    }
}
