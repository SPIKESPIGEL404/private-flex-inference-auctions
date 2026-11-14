CREATE TABLE mpp_nearintents_configuration (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    fingerprint text NOT NULL,
    public_configuration jsonb NOT NULL
);
CREATE TABLE mpp_nearintents_store (
    key text PRIMARY KEY,
    value jsonb NOT NULL
);
CREATE TABLE mpp_nearintents_funding (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES credit_accounts(user_id),
    operation_key text NOT NULL,
    amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd > 0 AND amount_micro_usd <= 10000000),
    challenge jsonb NOT NULL,
    challenge_header text NOT NULL,
    deposit_key text NOT NULL UNIQUE,
    expires_at_ms bigint NOT NULL,
    payment_key text UNIQUE,
    receipt jsonb,
    ledger_id text UNIQUE REFERENCES credit_ledger_entries(id),
    last_credential text,
    last_error text,
    UNIQUE(user_id, operation_key),
    CHECK ((payment_key IS NULL AND receipt IS NULL AND ledger_id IS NULL)
        OR (payment_key IS NOT NULL AND receipt IS NOT NULL AND ledger_id IS NOT NULL))
);
CREATE TABLE mpp_nearintents_payments (
    payment_key text PRIMARY KEY,
    funding_id text NOT NULL UNIQUE REFERENCES mpp_nearintents_funding(id),
    origin_hash text NOT NULL,
    receipt jsonb NOT NULL
);
CREATE TABLE mpp_nearintents_attempts (
    funding_id text NOT NULL REFERENCES mpp_nearintents_funding(id),
    credential_hash text NOT NULL,
    credential text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(funding_id,credential_hash)
);
