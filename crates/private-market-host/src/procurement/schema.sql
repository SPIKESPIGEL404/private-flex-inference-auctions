-- Owned, explicitly controlled-only extension. The existing cash authority,
-- ledger triggers and Redis outbox remain enabled and unchanged.
CREATE TABLE controlled_mpp_configuration (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    verification_key text NOT NULL,
    mode text NOT NULL CHECK (mode = 'controlled-test-only')
);
CREATE TABLE controlled_mpp_funding (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES credit_accounts(user_id),
    operation_key text NOT NULL,
    amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd > 0 AND amount_micro_usd <= 10000000),
    challenge jsonb NOT NULL,
    expires_at_ms bigint NOT NULL,
    payment_id text UNIQUE,
    receipt jsonb,
    ledger_id text UNIQUE REFERENCES credit_ledger_entries(id),
    UNIQUE (user_id, operation_key),
    CHECK ((payment_id IS NULL AND receipt IS NULL AND ledger_id IS NULL)
        OR (payment_id IS NOT NULL AND receipt IS NOT NULL AND ledger_id IS NOT NULL))
);
CREATE TABLE controlled_mpp_payments (
    payment_id text PRIMARY KEY,
    funding_id text NOT NULL UNIQUE REFERENCES controlled_mpp_funding(id),
    proof jsonb NOT NULL
);
