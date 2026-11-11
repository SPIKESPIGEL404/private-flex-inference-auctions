//! Historical scan implementation retained only as an independent test oracle.
use bitrouter_market::exchange::ExchangeSnapshot;
use bitrouter_market::execution_contract::*;
use bitrouter_market::execution_coordinator::*;
use bitrouter_market::order::UnixMillis;
pub fn scan_plan(
    s: &ExchangeSnapshot,
    p: &ExecutionCoordinationPolicy,
) -> Result<Vec<ExecutionWork>, CoordinationError> {
    p.validate()?;
    let Some(trades) = s.purchase_trades() else {
        return Ok(Vec::new());
    };
    let requests = s
        .execution_requests()
        .ok_or(CoordinationError::InvalidState)?;
    let metadata = s
        .execution_request_metadata()
        .ok_or(CoordinationError::InvalidState)?;
    let mut work = Vec::new();
    for t in trades.values().filter(|t| t.terminal.is_none()) {
        let mut operations = requests
            .values()
            .filter(|r| r.binding.attempt_id == t.id)
            .map(|r| {
                metadata
                    .get(&r.effect_id)
                    .map(|m| (r, m))
                    .ok_or(CoordinationError::InvalidState)
            })
            .collect::<Result<Vec<_>, _>>()?;
        operations.sort_by_key(|(_, m)| m.sequence);
        let (last, m) = operations
            .last()
            .copied()
            .ok_or(CoordinationError::InvalidState)?;
        // A query issued manually before initial dispatch cannot silently discard
        // the original unsent Submit while its authorization is still valid.
        let unsent_submit = operations.iter().find(|(r, _)| {
            r.kind == ExecutionRequestKind::Submit && !s.execution_request_sent(&r.effect_id)
        });
        let dispatch = if t.accepted_at.is_none() && s.now() < t.accept_before {
            unsent_submit
                .copied()
                .or_else(|| (!s.execution_request_sent(&last.effect_id)).then_some((last, m)))
        } else {
            (!s.execution_request_sent(&last.effect_id)
                && last.kind != ExecutionRequestKind::Submit)
                .then_some((last, m))
        };
        if let Some((r, m)) = dispatch {
            work.push(ExecutionWork {
                attempt: t.id.clone(),
                at: m.created_at,
                kind: ExecutionWorkKind::Dispatch {
                    effect_id: r.effect_id.clone(),
                },
            });
            continue;
        }
        let interval = if t.unknown {
            p.unknown_retry_interval_ms
        } else {
            p.query_interval_ms
        };
        let query_at = m.created_at.0.checked_add(interval).map(UnixMillis);
        let (at, kind) =
            if t.accepted_at.is_none() && last.kind != ExecutionRequestKind::FenceUnaccepted {
                // Even an unrepresentable next Query must not hide a representable
                // original acceptance deadline/fence obligation.
                let at = if s.now() >= t.accept_before {
                    t.accept_before.max(m.created_at)
                } else {
                    query_at.map_or(t.accept_before, |q| q.min(t.accept_before))
                };
                (
                    at,
                    if at >= t.accept_before {
                        ExecutionRequestKind::FenceUnaccepted
                    } else {
                        ExecutionRequestKind::Query
                    },
                )
            } else {
                (
                    query_at.ok_or(CoordinationError::TimeOverflow)?,
                    if t.accepted_at.is_some() {
                        ExecutionRequestKind::Query
                    } else {
                        ExecutionRequestKind::FenceUnaccepted
                    },
                )
            };
        work.push(ExecutionWork {
            attempt: t.id.clone(),
            at,
            kind: ExecutionWorkKind::Request {
                kind,
                after_effect: last.effect_id.clone(),
            },
        });
    }
    work.sort_by(|a, b| (a.at, &a.attempt).cmp(&(b.at, &b.attempt)));
    Ok(work)
}
