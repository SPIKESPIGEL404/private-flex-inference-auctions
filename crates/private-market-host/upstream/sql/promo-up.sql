-- Offline additive P1 installation. P0 settings must already be installed.
BEGIN;
DO $$ BEGIN
 IF (SELECT version FROM cloud_platform_billing.schema_version) IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'P1 requires exact installed P0 schema';
 END IF;
END $$;
ALTER TABLE cloud_platform_billing.schema_version DROP CONSTRAINT schema_version_version_check;
ALTER TABLE cloud_platform_billing.schema_version ADD CONSTRAINT schema_version_version_check CHECK(version IN (1,2));

-- Explicit deployment-fixed issuer/campaign; no automatic production defaults.
CREATE TABLE cloud_platform_billing.promo_config (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 issuer text NOT NULL CHECK(octet_length(issuer) BETWEEN 1 AND 512),
 campaign_starts_at timestamptz NOT NULL,
 max_input_tokens bigint NOT NULL DEFAULT 131072 CHECK(max_input_tokens=131072),
 max_input_bytes bigint NOT NULL DEFAULT 1048576 CHECK(max_input_bytes=1048576),
 user_pending_limit integer NOT NULL DEFAULT 32 CHECK(user_pending_limit=32),
 global_pending_limit integer NOT NULL DEFAULT 1024 CHECK(global_pending_limit=1024),
 user_exposure_micro_usd bigint NOT NULL DEFAULT 41920 CHECK(user_exposure_micro_usd=41920),
 global_exposure_micro_usd bigint NOT NULL DEFAULT 1341440 CHECK(global_exposure_micro_usd=1341440),
 user_per_minute integer NOT NULL DEFAULT 120 CHECK(user_per_minute=120),
 global_per_minute integer NOT NULL DEFAULT 12000 CHECK(global_per_minute=12000),
 execution_seconds integer NOT NULL DEFAULT 600 CHECK(execution_seconds=600)
);
CREATE TABLE cloud_platform_billing.accounts (
 issuer text NOT NULL, user_id text NOT NULL,
 auth_version bigint NOT NULL CHECK(auth_version>=1),
 auth_status text NOT NULL CHECK(auth_status IN ('active','banned','deleted')),
 email_verified boolean NOT NULL,
 registered_at timestamptz NOT NULL,
 observed_at timestamptz NOT NULL,
 valid_until timestamptz NOT NULL,
 query_id text NOT NULL CHECK(octet_length(query_id) BETWEEN 1 AND 128),
 query_elapsed_ms bigint NOT NULL CHECK(query_elapsed_ms BETWEEN 0 AND 5000),
 lifecycle text NOT NULL DEFAULT 'open' CHECK(lifecycle IN ('open','closing','closed')),
 PRIMARY KEY(issuer,user_id), CHECK(valid_until<=observed_at+interval '5 minutes'),
 CHECK(octet_length(issuer) BETWEEN 1 AND 512 AND octet_length(user_id) BETWEEN 1 AND 256)
);
CREATE TABLE cloud_platform_billing.grants (
 issuer text NOT NULL, user_id text NOT NULL,
 issued_micro_usd bigint NOT NULL CHECK(issued_micro_usd BETWEEN 1 AND 10000000),
 remaining_micro_usd bigint NOT NULL CHECK(remaining_micro_usd>=0 AND remaining_micro_usd<=issued_micro_usd),
 granted_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(issuer,user_id), FOREIGN KEY(issuer,user_id) REFERENCES cloud_platform_billing.accounts ON DELETE RESTRICT,
 CHECK(expires_at=granted_at+interval '720 hours')
);
CREATE TABLE cloud_platform_billing.promo_requests (
 request_id text PRIMARY KEY CHECK(octet_length(request_id) BETWEEN 1 AND 256),
 issuer text NOT NULL, user_id text NOT NULL, idempotency_key text,
 execution_sha256 text NOT NULL CHECK(execution_sha256 ~ '^[0-9a-f]{64}$'),
 meter_version text NOT NULL CHECK(octet_length(meter_version) BETWEEN 1 AND 128),
 total_input_tokens bigint NOT NULL CHECK(total_input_tokens BETWEEN 0 AND 131072),
 reused_input_tokens bigint NOT NULL DEFAULT 0 CHECK(reused_input_tokens=0),
 input_bytes bigint NOT NULL CHECK(input_bytes BETWEEN 0 AND 1048576),
 fee_cap_micro_usd bigint NOT NULL CHECK(fee_cap_micro_usd=total_input_tokens/100),
 funding_mode text NOT NULL DEFAULT 'byok_promo' CHECK(funding_mode='byok_promo'),
 setting_revision bigint NOT NULL CHECK(setting_revision>=0),
 admission_auth_version bigint NOT NULL CHECK(admission_auth_version>=1),
 admission_auth_valid_until timestamptz NOT NULL,
 admission_grant_expires_at timestamptz NOT NULL,
 policy_bundle text NOT NULL DEFAULT 'byok_platform_fee_v1' CHECK(policy_bundle='byok_platform_fee_v1'),
 money_policy text NOT NULL DEFAULT 'micro_usd_floor_per_request_v1' CHECK(money_policy='micro_usd_floor_per_request_v1'),
 metering_policy text NOT NULL DEFAULT 'full_input_v1' CHECK(metering_policy='full_input_v1'),
 promo_policy text NOT NULL DEFAULT 'promo_soft_budget_v1' CHECK(promo_policy='promo_soft_budget_v1'),
 funding_policy text NOT NULL DEFAULT 'promo_first_account_cash_fallback_v1' CHECK(funding_policy='promo_first_account_cash_fallback_v1'),
 success_policy text NOT NULL DEFAULT 'byok_execution_delivery_v1' CHECK(success_policy='byok_execution_delivery_v1'),
 admitted_at timestamptz NOT NULL, execution_deadline timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','settled')),
 FOREIGN KEY(issuer,user_id) REFERENCES cloud_platform_billing.accounts ON DELETE RESTRICT,
 CHECK(idempotency_key IS NULL OR octet_length(idempotency_key) BETWEEN 1 AND 256),
 CHECK(admission_auth_valid_until>admitted_at AND admission_grant_expires_at>admitted_at),
 CHECK(execution_deadline=admitted_at+interval '600 seconds')
);
CREATE TABLE cloud_platform_billing.grant_eligibility (
 issuer text NOT NULL,user_id text NOT NULL, auth_version bigint NOT NULL,
 registered_at timestamptz NOT NULL, observed_at timestamptz NOT NULL,
 query_id text NOT NULL,query_elapsed_ms bigint NOT NULL,
 checked_at timestamptz NOT NULL,rule_version text NOT NULL CHECK(rule_version='welcome_once_720h_v1'),
 PRIMARY KEY(issuer,user_id), FOREIGN KEY(issuer,user_id) REFERENCES cloud_platform_billing.grants ON DELETE RESTRICT
);
CREATE UNIQUE INDEX promo_idempotency ON cloud_platform_billing.promo_requests(issuer,user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX promo_pending ON cloud_platform_billing.promo_requests(issuer,user_id) INCLUDE(fee_cap_micro_usd) WHERE state='pending';
CREATE INDEX promo_rate ON cloud_platform_billing.promo_requests(admitted_at,issuer,user_id);
CREATE TABLE cloud_platform_billing.promo_settlements (
 request_id text PRIMARY KEY REFERENCES cloud_platform_billing.promo_requests ON DELETE RESTRICT,
 qualified_input_tokens bigint NOT NULL CHECK(qualified_input_tokens>=0),
 verdict text NOT NULL CHECK(verdict IN ('complete','qualified_stop','failed','closed_unproven')),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 fee_micro_usd bigint NOT NULL CHECK(fee_micro_usd=qualified_input_tokens/100),
 promo_micro_usd bigint NOT NULL CHECK(promo_micro_usd>=0),
 cash_micro_usd bigint NOT NULL DEFAULT 0 CHECK(cash_micro_usd=0),
 waiver_micro_usd bigint NOT NULL CHECK(waiver_micro_usd>=0),
 waiver_reason text NOT NULL CHECK(waiver_reason IN ('none','promo_exhausted','promo_expired')),
 settled_at timestamptz NOT NULL,
 CHECK(fee_micro_usd=promo_micro_usd+cash_micro_usd+waiver_micro_usd),
 CHECK(verdict NOT IN ('failed','closed_unproven') OR qualified_input_tokens=0)
);
CREATE TABLE cloud_platform_billing.promo_corrections (
 request_id text NOT NULL REFERENCES cloud_platform_billing.promo_settlements ON DELETE RESTRICT,
 correction_id text NOT NULL CHECK(octet_length(correction_id) BETWEEN 1 AND 256),
 promo_restore_micro_usd bigint NOT NULL CHECK(promo_restore_micro_usd>=0),
 waiver_reverse_micro_usd bigint NOT NULL CHECK(waiver_reverse_micro_usd>=0),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(request_id,correction_id)
);
CREATE TABLE cloud_platform_billing.grant_events (
 issuer text NOT NULL, user_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('issue','consume','restore')),
 event_id text NOT NULL, delta_micro_usd bigint NOT NULL,
 request_id text REFERENCES cloud_platform_billing.promo_requests ON DELETE RESTRICT,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(issuer,user_id,kind,event_id),
 FOREIGN KEY(issuer,user_id) REFERENCES cloud_platform_billing.grants ON DELETE RESTRICT,
 CHECK((kind='issue' AND delta_micro_usd>0 AND request_id IS NULL)
    OR (kind='consume' AND delta_micro_usd<=0 AND request_id IS NOT NULL)
    OR (kind='restore' AND delta_micro_usd>=0 AND request_id IS NOT NULL))
);

CREATE FUNCTION cloud_platform_billing.lock_user(p_issuer text,p_user text) RETURNS void
LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('bitrouter.platform-billing.user.v1:'||jsonb_build_array(p_issuer,p_user)::text,0));
$$;
CREATE FUNCTION cloud_platform_billing.lock_risk() RETURNS void
LANGUAGE sql SET search_path=pg_catalog AS $$
 SELECT pg_advisory_xact_lock(hashtextextended('bitrouter.platform-billing.risk.v1',0));
$$;
CREATE FUNCTION cloud_platform_billing.lock_existing_setting(p_issuer text,p_user text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM revision FROM cloud_platform_billing.account_settings WHERE issuer=p_issuer AND user_id=p_user FOR UPDATE;
END $$;

CREATE FUNCTION cloud_platform_billing.apply_auth(
 p_issuer text,p_user text,p_version bigint,p_status text,p_verified boolean,
 p_registered timestamptz,p_observed timestamptz,p_query text,p_elapsed bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old cloud_platform_billing.accounts; now_at timestamptz:=clock_timestamp();
BEGIN
 PERFORM cloud_platform_billing.lock_user(p_issuer,p_user);
 IF NOT EXISTS(SELECT FROM cloud_platform_billing.promo_config WHERE issuer=p_issuer)
    OR p_observed>now_at+interval '5 seconds' OR p_observed<now_at-interval '60 seconds'
    OR p_registered>p_observed+interval '5 seconds' THEN
  RAISE EXCEPTION 'ineligible issuer or expired source observation';
 END IF;
 SELECT * INTO old FROM cloud_platform_billing.accounts WHERE issuer=p_issuer AND user_id=p_user FOR UPDATE;
 IF FOUND THEN
  IF old.auth_version>p_version OR (old.auth_status='deleted' AND p_status<>'deleted') THEN
   RAISE EXCEPTION 'stale or terminal Auth state';
  END IF;
  IF old.auth_version=p_version AND
     (old.auth_status<>p_status OR old.email_verified<>p_verified OR old.registered_at<>p_registered) THEN
   RAISE EXCEPTION 'same-version Auth conflict';
  END IF;
  UPDATE cloud_platform_billing.accounts SET auth_version=p_version,auth_status=p_status,
   email_verified=p_verified,registered_at=p_registered,observed_at=greatest(observed_at,p_observed),
   query_id=p_query,query_elapsed_ms=p_elapsed,
   valid_until=greatest(observed_at,p_observed)+interval '5 minutes'
   WHERE issuer=p_issuer AND user_id=p_user;
 ELSE
  INSERT INTO cloud_platform_billing.accounts(issuer,user_id,auth_version,auth_status,email_verified,registered_at,observed_at,valid_until,query_id,query_elapsed_ms)
   VALUES(p_issuer,p_user,p_version,p_status,p_verified,p_registered,p_observed,p_observed+interval '5 minutes',p_query,p_elapsed);
 END IF;
END $$;

CREATE FUNCTION cloud_platform_billing.ensure_grant(p_issuer text,p_user text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a cloud_platform_billing.accounts; g cloud_platform_billing.grants; at_time timestamptz;
BEGIN
 PERFORM cloud_platform_billing.lock_user(p_issuer,p_user);
 SELECT * INTO a FROM cloud_platform_billing.accounts WHERE issuer=p_issuer AND user_id=p_user FOR UPDATE;
 IF NOT FOUND OR a.lifecycle<>'open' OR a.auth_status<>'active' OR NOT a.email_verified
    OR a.valid_until<=clock_timestamp() THEN RETURN false; END IF;
 SELECT * INTO g FROM cloud_platform_billing.grants WHERE issuer=p_issuer AND user_id=p_user;
 IF FOUND THEN RETURN true; END IF;
 IF a.registered_at<(SELECT campaign_starts_at FROM cloud_platform_billing.promo_config WHERE issuer=p_issuer)
    OR a.observed_at<clock_timestamp()-interval '60 seconds' THEN RETURN false; END IF;
 PERFORM cloud_platform_billing.initialize_setting(p_issuer,p_user);
 at_time:=clock_timestamp();
 IF a.observed_at<at_time-interval '60 seconds' OR a.valid_until<=at_time THEN RETURN false; END IF;
 INSERT INTO cloud_platform_billing.grants VALUES(p_issuer,p_user,10000000,10000000,at_time,at_time+interval '720 hours');
 INSERT INTO cloud_platform_billing.grant_eligibility VALUES(p_issuer,p_user,a.auth_version,a.registered_at,a.observed_at,a.query_id,a.query_elapsed_ms,at_time,'welcome_once_720h_v1');
 INSERT INTO cloud_platform_billing.grant_events(issuer,user_id,kind,event_id,delta_micro_usd)
  VALUES(p_issuer,p_user,'issue','welcome_once',10000000);
 RETURN true;
END $$;

CREATE FUNCTION cloud_platform_billing.admit_promo(
 p_issuer text,p_user text,p_request text,p_key text,p_digest text,p_meter text,p_tokens bigint,p_bytes bigint)
RETURNS cloud_platform_billing.promo_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a cloud_platform_billing.accounts; r cloud_platform_billing.promo_requests;
 s record; g cloud_platform_billing.grants; c cloud_platform_billing.promo_config;
 at_time timestamptz; n bigint; exposure numeric; fee bigint;
BEGIN
 PERFORM cloud_platform_billing.lock_risk();
 PERFORM cloud_platform_billing.lock_user(p_issuer,p_user);
 SELECT * INTO c FROM cloud_platform_billing.promo_config WHERE issuer=p_issuer;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown billing issuer'; END IF;
 -- Original request/key lookup precedes live settings/grant/default policies.
 SELECT * INTO r FROM cloud_platform_billing.promo_requests WHERE request_id=p_request
  OR (issuer=p_issuer AND user_id=p_user AND idempotency_key=p_key) ORDER BY request_id LIMIT 1;
 IF FOUND THEN
  IF r.issuer<>p_issuer OR r.user_id<>p_user OR r.execution_sha256<>p_digest OR r.meter_version<>p_meter
     OR r.total_input_tokens<>p_tokens OR r.input_bytes<>p_bytes OR r.idempotency_key IS DISTINCT FROM p_key
     OR EXISTS(SELECT FROM cloud_platform_billing.promo_requests WHERE request_id=p_request AND request_id<>r.request_id) THEN
   RAISE EXCEPTION 'idempotent execution conflict';
  END IF;
  RETURN r;
 END IF;
 SELECT * INTO a FROM cloud_platform_billing.accounts WHERE issuer=p_issuer AND user_id=p_user FOR UPDATE;
 IF NOT FOUND OR a.lifecycle<>'open' OR a.auth_status<>'active' OR NOT a.email_verified
    OR a.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'account eligibility unavailable or denied'; END IF;
 SELECT * INTO s FROM cloud_platform_billing.lock_setting(p_issuer,p_user);
 SELECT * INTO g FROM cloud_platform_billing.grants WHERE issuer=p_issuer AND user_id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'grant initialization required'; END IF;
 at_time:=clock_timestamp();
 IF a.valid_until<=at_time THEN RAISE EXCEPTION 'account eligibility expired while awaiting admission locks'; END IF;
 IF g.remaining_micro_usd<=0 OR g.expires_at<=at_time THEN
  IF s.cash_fallback_enabled THEN RAISE EXCEPTION 'cash guarantee required; P1 cash capability is closed';
  ELSE RAISE EXCEPTION 'promo exhausted or expired; account cash fallback disabled'; END IF;
 END IF;
 IF p_tokens<0 OR p_tokens>c.max_input_tokens OR p_bytes<0 OR p_bytes>c.max_input_bytes THEN
  RAISE EXCEPTION 'input risk limit exceeded'; END IF;
 fee:=p_tokens/100;
 SELECT count(*),coalesce(sum(fee_cap_micro_usd),0) INTO n,exposure FROM cloud_platform_billing.promo_requests WHERE state='pending';
 IF n>=c.global_pending_limit OR exposure+fee>c.global_exposure_micro_usd THEN RAISE EXCEPTION 'global unsettled exposure limit'; END IF;
 SELECT count(*),coalesce(sum(fee_cap_micro_usd),0) INTO n,exposure FROM cloud_platform_billing.promo_requests WHERE state='pending' AND issuer=p_issuer AND user_id=p_user;
 IF n>=c.user_pending_limit OR exposure+fee>c.user_exposure_micro_usd THEN RAISE EXCEPTION 'user unsettled exposure limit'; END IF;
 SELECT count(*) INTO n FROM cloud_platform_billing.promo_requests WHERE admitted_at>=date_trunc('minute',at_time);
 IF n>=c.global_per_minute THEN RAISE EXCEPTION 'global request rate limit'; END IF;
 SELECT count(*) INTO n FROM cloud_platform_billing.promo_requests WHERE issuer=p_issuer AND user_id=p_user AND admitted_at>=date_trunc('minute',at_time);
 IF n>=c.user_per_minute THEN RAISE EXCEPTION 'user request rate limit'; END IF;
 INSERT INTO cloud_platform_billing.promo_requests(request_id,issuer,user_id,idempotency_key,execution_sha256,meter_version,total_input_tokens,input_bytes,fee_cap_micro_usd,setting_revision,admission_auth_version,admission_auth_valid_until,admission_grant_expires_at,admitted_at,execution_deadline)
  VALUES(p_request,p_issuer,p_user,p_key,p_digest,p_meter,p_tokens,p_bytes,fee,s.revision,a.auth_version,a.valid_until,g.expires_at,at_time,at_time+interval '600 seconds') RETURNING * INTO r;
 RETURN r;
END $$;

CREATE FUNCTION cloud_platform_billing.settle_promo(p_request text,p_tokens bigint,p_verdict text,p_evidence text)
RETURNS cloud_platform_billing.promo_settlements
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r cloud_platform_billing.promo_requests; g cloud_platform_billing.grants;
 done cloud_platform_billing.promo_settlements; at_time timestamptz; fee bigint; paid bigint; reason text;
BEGIN
 -- Risk lock always precedes user/state/settings/request/grant in new paths.
 PERFORM cloud_platform_billing.lock_risk();
 SELECT * INTO r FROM cloud_platform_billing.promo_requests WHERE request_id=p_request;
 IF NOT FOUND THEN RAISE EXCEPTION 'original promo request missing'; END IF;
 PERFORM cloud_platform_billing.lock_user(r.issuer,r.user_id);
 PERFORM cloud_platform_billing.lock_setting(r.issuer,r.user_id);
 SELECT * INTO r FROM cloud_platform_billing.promo_requests WHERE request_id=p_request FOR UPDATE;
 SELECT * INTO done FROM cloud_platform_billing.promo_settlements WHERE request_id=p_request;
 IF FOUND THEN
  IF done.qualified_input_tokens<>p_tokens OR done.verdict<>p_verdict OR done.evidence_sha256<>p_evidence THEN
   RAISE EXCEPTION 'settlement evidence conflict; never reprice a final request'; END IF;
  RETURN done;
 END IF;
 IF p_tokens<0 OR p_tokens>r.total_input_tokens THEN RAISE EXCEPTION 'qualified tokens outside original cap'; END IF;
 IF p_verdict='complete' AND p_tokens<>r.total_input_tokens THEN RAISE EXCEPTION 'complete request must use full frozen input'; END IF;
 SELECT * INTO g FROM cloud_platform_billing.grants WHERE issuer=r.issuer AND user_id=r.user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'original grant missing'; END IF;
 at_time:=clock_timestamp(); fee:=p_tokens/100;
 IF g.expires_at<=at_time THEN paid:=0; reason:='promo_expired';
 ELSE paid:=least(fee,g.remaining_micro_usd); reason:='promo_exhausted'; END IF;
 IF paid=fee THEN reason:='none'; END IF;
 UPDATE cloud_platform_billing.grants SET remaining_micro_usd=remaining_micro_usd-paid WHERE issuer=r.issuer AND user_id=r.user_id;
 INSERT INTO cloud_platform_billing.promo_settlements VALUES(p_request,p_tokens,p_verdict,p_evidence,fee,paid,0,fee-paid,reason,at_time) RETURNING * INTO done;
 INSERT INTO cloud_platform_billing.grant_events(issuer,user_id,kind,event_id,delta_micro_usd,request_id)
  VALUES(r.issuer,r.user_id,'consume',p_request,-paid,p_request);
 UPDATE cloud_platform_billing.promo_requests SET state='settled' WHERE request_id=p_request;
 RETURN done;
END $$;

CREATE FUNCTION cloud_platform_billing.correct_promo(p_request text,p_id text,p_restore bigint,p_reverse bigint,p_evidence text)
RETURNS cloud_platform_billing.promo_corrections
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r cloud_platform_billing.promo_requests; s cloud_platform_billing.promo_settlements;
 done cloud_platform_billing.promo_corrections; restored numeric; reversed numeric;
BEGIN
 SELECT * INTO r FROM cloud_platform_billing.promo_requests WHERE request_id=p_request;
 IF NOT FOUND THEN RAISE EXCEPTION 'original promo request missing'; END IF;
 PERFORM cloud_platform_billing.lock_user(r.issuer,r.user_id);
 PERFORM cloud_platform_billing.lock_setting(r.issuer,r.user_id);
 SELECT * INTO s FROM cloud_platform_billing.promo_settlements WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'original final receipt missing'; END IF;
 SELECT * INTO done FROM cloud_platform_billing.promo_corrections WHERE request_id=p_request AND correction_id=p_id;
 IF FOUND THEN
  IF done.promo_restore_micro_usd<>p_restore OR done.waiver_reverse_micro_usd<>p_reverse OR done.evidence_sha256<>p_evidence THEN RAISE EXCEPTION 'correction identity conflict'; END IF;
  RETURN done;
 END IF;
 SELECT coalesce(sum(promo_restore_micro_usd),0),coalesce(sum(waiver_reverse_micro_usd),0) INTO restored,reversed FROM cloud_platform_billing.promo_corrections WHERE request_id=p_request;
 IF p_restore<0 OR p_reverse<0 OR restored+p_restore>s.promo_micro_usd OR reversed+p_reverse>s.waiver_micro_usd THEN RAISE EXCEPTION 'correction exceeds original source'; END IF;
 UPDATE cloud_platform_billing.grants SET remaining_micro_usd=remaining_micro_usd+p_restore WHERE issuer=r.issuer AND user_id=r.user_id;
 INSERT INTO cloud_platform_billing.promo_corrections(request_id,correction_id,promo_restore_micro_usd,waiver_reverse_micro_usd,evidence_sha256)
  VALUES(p_request,p_id,p_restore,p_reverse,p_evidence) RETURNING * INTO done;
 INSERT INTO cloud_platform_billing.grant_events(issuer,user_id,kind,event_id,delta_micro_usd,request_id)
  VALUES(r.issuer,r.user_id,'restore',jsonb_build_array(p_request,p_id)::text,p_restore,p_request);
 RETURN done;
END $$;

CREATE FUNCTION cloud_platform_billing.close_account(p_issuer text,p_user text,p_final boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM cloud_platform_billing.lock_user(p_issuer,p_user);
 UPDATE cloud_platform_billing.accounts SET lifecycle=CASE WHEN p_final OR lifecycle='closed' THEN 'closed' ELSE 'closing' END WHERE issuer=p_issuer AND user_id=p_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'account missing'; END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA cloud_platform_billing FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cloud_platform_billing FROM PUBLIC;
UPDATE cloud_platform_billing.schema_version SET version=2;
COMMIT;
