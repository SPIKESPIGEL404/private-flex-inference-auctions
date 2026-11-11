-- Explicit offline installation only. Not part of #663's frozen public
-- migration chain, startup, Auth schema, or cash balance reconstruction.
BEGIN;
CREATE SCHEMA cloud_platform_billing;
REVOKE ALL ON SCHEMA cloud_platform_billing FROM PUBLIC;

CREATE TABLE cloud_platform_billing.schema_version (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version integer NOT NULL CHECK (version = 1),
    policy_bundle text NOT NULL CHECK (policy_bundle = 'byok_platform_fee_v1')
);
INSERT INTO cloud_platform_billing.schema_version VALUES (true,1,'byok_platform_fee_v1');

CREATE TABLE cloud_platform_billing.account_settings (
    issuer text NOT NULL CHECK (octet_length(issuer) BETWEEN 1 AND 512),
    user_id text NOT NULL CHECK (octet_length(user_id) BETWEEN 1 AND 256),
    cash_fallback_enabled boolean NOT NULL DEFAULT true,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (issuer,user_id)
);
CREATE TABLE cloud_platform_billing.setting_events (
    issuer text NOT NULL,
    user_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 0),
    cash_fallback_enabled boolean NOT NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (issuer,user_id,revision),
    FOREIGN KEY (issuer,user_id) REFERENCES cloud_platform_billing.account_settings
        ON DELETE RESTRICT
);

CREATE FUNCTION cloud_platform_billing.guard_setting() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'billing preference history must be retained';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.issuer IS DISTINCT FROM OLD.issuer
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.revision <> OLD.revision + 1) THEN
        RAISE EXCEPTION 'billing preference identity/revision conflict';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.revision <> 0 THEN
        RAISE EXCEPTION 'billing preference must begin at revision zero';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END $$;
CREATE TRIGGER setting_guard BEFORE INSERT OR UPDATE OR DELETE
    ON cloud_platform_billing.account_settings FOR EACH ROW
    EXECUTE FUNCTION cloud_platform_billing.guard_setting();

CREATE FUNCTION cloud_platform_billing.record_setting() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    INSERT INTO cloud_platform_billing.setting_events
        VALUES (NEW.issuer,NEW.user_id,NEW.revision,NEW.cash_fallback_enabled,NEW.updated_at);
    RETURN NEW;
END $$;
CREATE TRIGGER setting_record AFTER INSERT OR UPDATE
    ON cloud_platform_billing.account_settings FOR EACH ROW
    EXECUTE FUNCTION cloud_platform_billing.record_setting();

-- SECURITY DEFINER confines the runtime role to these two writes. Deploy with
-- a separate Cloud business migration owner, never an Auth owner or app role.
CREATE FUNCTION cloud_platform_billing.initialize_setting(p_issuer text,p_user text)
RETURNS TABLE(cash_fallback_enabled boolean,revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    INSERT INTO cloud_platform_billing.account_settings(issuer,user_id)
        VALUES (p_issuer,p_user) ON CONFLICT DO NOTHING;
    RETURN QUERY SELECT s.cash_fallback_enabled,s.revision
        FROM cloud_platform_billing.account_settings s
        WHERE s.issuer=p_issuer AND s.user_id=p_user FOR UPDATE;
END $$;
CREATE FUNCTION cloud_platform_billing.update_setting(
    p_issuer text,p_user text,p_revision bigint,p_enabled boolean)
RETURNS TABLE(cash_fallback_enabled boolean,revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    RETURN QUERY UPDATE cloud_platform_billing.account_settings s
        SET cash_fallback_enabled=p_enabled,revision=s.revision+1
        WHERE s.issuer=p_issuer AND s.user_id=p_user AND s.revision=p_revision
        RETURNING s.cash_fallback_enabled,s.revision;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'billing preference missing or revision conflict' USING ERRCODE='40001';
    END IF;
END $$;
CREATE FUNCTION cloud_platform_billing.lock_setting(p_issuer text,p_user text)
RETURNS TABLE(cash_fallback_enabled boolean,revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    RETURN QUERY SELECT s.cash_fallback_enabled,s.revision
        FROM cloud_platform_billing.account_settings s
        WHERE s.issuer=p_issuer AND s.user_id=p_user FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'billing preference missing; explicit initialization required';
    END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cloud_platform_billing FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA cloud_platform_billing FROM PUBLIC;
COMMIT;
