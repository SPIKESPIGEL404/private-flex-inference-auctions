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
use bitrouter_market::{
    exchange::*, execution_contract::*, market_host::MarketHost, order::*,
    purchase_order::PurchaseResult,
};
#[test]
fn fence_of_one_option_wakes_buyers_for_other_market_options_of_the_same_sale() {
    let (mut h, mut a, _) = sf::setup(false, false);
    sf::buyer(&mut h, 1, "a", "first", false);
    sf::buyer(&mut h, 2, "b", "waiting", false);
    let receipt = sf::drive(&mut h, "first-drive");
    let id = pf::id(receipt.reviewed[0].1.decision.as_ref().unwrap());
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
    assert_eq!(h.snapshot().formal_pending(), 0);
    let fence = pf::query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::FenceUnaccepted,
        "fence-query",
    );
    h.receive("fenced".into(), a.origin(), fence).unwrap();
    let receipt = sf::drive(&mut h, "after-fence");
    assert!(receipt.reviewed.iter().any(|(root, r)| root.owner_id() == 2
        && r.decision
            .as_ref()
            .is_some_and(|d| matches!(d.result, PurchaseResult::Granted { .. }))));
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 2);
}
#[test]
fn unrelated_credit_does_not_wake_open_funded_orders() {
    let (mut h, _) = pf::setup(false, false);
    let i = pf::registration("wait", 1, &["a"], false);
    pf::register(&mut h, &i);
    sf::drive(&mut h, "review");
    assert_eq!(h.snapshot().formal_pending(), 0);
    h.execute(
        "unrelated".into(),
        ExchangeCommand::Credit {
            buyer_id: 99,
            amount: MicroUsd(1),
        },
    )
    .unwrap();
    assert_eq!(h.snapshot().formal_pending(), 0);
    let q = pf::publication(&h, &i, 1, "supply");
    pf::publish(&mut h, &q);
    assert_eq!(h.snapshot().formal_pending(), 1);
    assert_eq!(sf::drive(&mut h, "supply-drive").reviewed.len(), 1);
}
#[test]
fn seeded_funding_sequences_match_an_independent_shared_balance_oracle() {
    for seed in 1..=8u64 {
        let mut h = pf::bootstrap(false);
        let mut random = seed;
        let mut cash = [0u64; 3];
        let mut roots =
            Vec::<(bitrouter_market::formal_order::PlaceFormalOrder, bool, bool)>::new();
        for step in 0..100 {
            random = random
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let owner = (random >> 24) % 3;
            let action = random % 5;
            if action == 0 || roots.is_empty() {
                let mut i = pf::registration(
                    &format!("random-{step}"),
                    owner + 1,
                    if random & 256 == 0 {
                        &["a"]
                    } else {
                        &["a", "b"]
                    },
                    false,
                );
                i.authorization.max_charge = MicroUsd(30 + (random >> 32) % 71);
                pf::register(&mut h, &i);
                roots.push((i, false, false));
            } else if action == 1 {
                let amount = (random >> 32) % 151;
                cash[owner as usize] += amount;
                h.execute(
                    format!("credit-{step}"),
                    ExchangeCommand::Credit {
                        buyer_id: owner + 1,
                        amount: MicroUsd(amount),
                    },
                )
                .unwrap();
            } else {
                let index = (random >> 32) as usize % roots.len();
                let (i, closed, funded) = &mut roots[index];
                if action == 2 {
                    pf::close(&mut h, i, &format!("close-{step}"));
                    *closed = true;
                    *funded = false;
                } else if action == 3 {
                    let before = h.snapshot();
                    pf::register(&mut h, i);
                    assert_eq!(h.snapshot(), before);
                } else {
                    let before = h.snapshot();
                    let mut conflict = i.clone();
                    conflict.authorization.max_charge.0 += 1;
                    assert!(h
                        .execute(
                            conflict.idempotency_key.clone(),
                            ExchangeCommand::PlaceFormalOrder(Box::new(conflict))
                        )
                        .is_err());
                    assert_eq!(h.snapshot(), before);
                }
            }
            let mut held = [0u64; 3];
            for (i, closed, funded) in &roots {
                if !closed && *funded {
                    held[(i.authorization.binding.root.owner_id() - 1) as usize] +=
                        i.authorization.max_charge.0;
                }
            }
            for (i, closed, funded) in &mut roots {
                let owner = (i.authorization.binding.root.owner_id() - 1) as usize;
                let cap = i.authorization.max_charge.0;
                if !*closed && !*funded && cash[owner] - held[owner] >= cap {
                    *funded = true;
                    held[owner] += cap;
                }
            }
            let s = h.snapshot();
            for owner in 0..3 {
                if let Some(account) = s.accounts().get(&(owner as u64 + 1)) {
                    assert_eq!(account.balance(), MicroUsd(cash[owner]));
                    assert_eq!(account.held(), MicroUsd(held[owner]));
                }
            }
            if step % 25 == 0 {
                assert_eq!(
                    MarketHost::replay(pf::bootstrap(false), &h.journal())
                        .unwrap()
                        .snapshot(),
                    s
                );
            }
        }
    }
}

#[test]
fn close_receipt_distinguishes_stopped_intake_from_released_funds_and_stays_original() {
    use bitrouter_market::formal_order::CloseFormalOrder;
    for granted in [false, true] {
        let (mut h, mut authority) = pf::setup(false, false);
        let order = pf::registration("close-funds", 1, &["a"], false);
        pf::register(&mut h, &order);
        let attempt = if granted {
            let q = pf::publication(&h, &order, 1, "close-funds");
            pf::publish(&mut h, &q);
            let p = pf::proposal(&h, &order, &[q], "close-funds");
            Some(pf::id(&pf::propose(&mut h, &p)))
        } else {
            None
        };
        let command = |key: &str| {
            ExchangeCommand::CloseFormalOrder(CloseFormalOrder {
                idempotency_key: key.into(),
                root: order.authorization.binding.clone(),
            })
        };
        let receipt = h.execute("close".into(), command("close")).unwrap();
        let ExchangeReceipt::OrderClosed(closed) = &receipt else {
            panic!("close receipt")
        };
        let funds = closed.funds.as_ref().unwrap();
        assert_eq!(funds.originally_reserved, MicroUsd(100));
        assert_eq!(
            funds.held_remaining,
            MicroUsd(if granted { 100 } else { 0 })
        );
        assert_eq!(
            funds.released_from_order,
            MicroUsd(if granted { 0 } else { 100 })
        );
        assert_eq!(funds.charged, MicroUsd(0));
        if let Some(id) = attempt {
            let report = pf::query(
                &mut h,
                &mut authority,
                &id,
                ExecutionRequestKind::FenceUnaccepted,
                "fence-query",
            );
            h.receive("fenced".into(), authority.origin(), report)
                .unwrap();
        }
        assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
        assert_eq!(
            h.snapshot().purchase_orders().unwrap()[&order.authorization.binding.root]
                .funding()
                .unwrap()
                .released(),
            MicroUsd(100)
        );
        assert_eq!(
            h.execute("close".into(), command("close")).unwrap(),
            receipt
        );
        assert_eq!(
            h.execute("close-alias".into(), command("close-alias"))
                .unwrap(),
            receipt
        );
        assert_eq!(
            MarketHost::replay(pf::bootstrap(false), &h.journal())
                .unwrap()
                .snapshot(),
            h.snapshot()
        );
    }
}

#[test]
fn accepted_close_reports_only_remaining_trade_hold_and_unfunded_close_has_no_reservation() {
    use bitrouter_market::formal_order::CloseFormalOrder;
    let (mut h, mut authority) = pf::setup(false, false);
    let order = pf::registration("accepted-close", 1, &["a"], false);
    pf::register(&mut h, &order);
    let q = pf::publication(&h, &order, 1, "accepted-close");
    pf::publish(&mut h, &q);
    let p = pf::proposal(&h, &order, &[q], "accepted-close");
    let id = pf::id(&pf::propose(&mut h, &p));
    let report = h
        .dispatch(
            &pf::request(&h, &id, ExecutionRequestKind::Submit).effect_id,
            &mut authority,
        )
        .unwrap();
    h.receive("accepted".into(), authority.origin(), report)
        .unwrap();
    let receipt = h
        .execute(
            "close".into(),
            ExchangeCommand::CloseFormalOrder(CloseFormalOrder {
                idempotency_key: "close".into(),
                root: order.authorization.binding,
            }),
        )
        .unwrap();
    let ExchangeReceipt::OrderClosed(r) = receipt else {
        panic!("receipt")
    };
    let funds = r.funds.unwrap();
    assert_eq!(funds.held_remaining, MicroUsd(11));
    assert_eq!(funds.released_from_order, MicroUsd(89));
    assert_eq!(funds.charged, MicroUsd(0));
    let mut h = pf::bootstrap(false);
    let order = pf::registration("unfunded-close", 1, &["a"], false);
    pf::register(&mut h, &order);
    let ExchangeReceipt::OrderClosed(r) = h
        .execute(
            "close".into(),
            ExchangeCommand::CloseFormalOrder(CloseFormalOrder {
                idempotency_key: "close".into(),
                root: order.authorization.binding,
            }),
        )
        .unwrap()
    else {
        panic!("receipt")
    };
    assert!(r.funds.is_none());
}
