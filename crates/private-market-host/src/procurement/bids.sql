CREATE TABLE controlled_procurement_intents (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES credit_accounts(user_id),
    operation_key text NOT NULL,
    specification jsonb NOT NULL,
    started_at_ms bigint NOT NULL,
    deadline_ms bigint NOT NULL,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    current_cap_micro_usd bigint NOT NULL CHECK (current_cap_micro_usd > 0),
    manual_override boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled','expired')),
    UNIQUE (user_id, operation_key)
);
CREATE TABLE controlled_procurement_operations (
    user_id text NOT NULL,
    operation_key text NOT NULL,
    intent_id text NOT NULL REFERENCES controlled_procurement_intents(id),
    command jsonb NOT NULL,
    result jsonb NOT NULL,
    PRIMARY KEY (user_id, operation_key)
);
CREATE TABLE controlled_procurement_revisions (
    intent_id text NOT NULL REFERENCES controlled_procurement_intents(id),
    revision bigint NOT NULL,
    snapshot jsonb NOT NULL,
    PRIMARY KEY (intent_id, revision)
);
