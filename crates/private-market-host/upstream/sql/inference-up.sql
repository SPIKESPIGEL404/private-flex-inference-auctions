-- Explicit offline P2 installation; never installed by a request or startup.
BEGIN;
DO $$ BEGIN IF (SELECT version FROM cloud_platform_billing.schema_version)<>2 THEN RAISE EXCEPTION 'P2 requires installed P1'; END IF; END $$;
ALTER TABLE cloud_platform_billing.schema_version DROP CONSTRAINT schema_version_version_check;
ALTER TABLE cloud_platform_billing.schema_version ADD CONSTRAINT schema_version_version_check CHECK(version IN(1,2,3));
CREATE TABLE cloud_platform_billing.inference_requests (
 request_id text PRIMARY KEY,issuer text NOT NULL,user_id text NOT NULL,idempotency_key text,
 nonce uuid NOT NULL UNIQUE,direct_final_hop boolean NOT NULL,mode text NOT NULL CHECK(mode IN('shadow','promo')),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=16384),
 execution_sha256 text NOT NULL CHECK(execution_sha256 ~ '^[0-9a-f]{64}$'),
 phase text NOT NULL DEFAULT 'preparing' CHECK(phase IN('preparing','claimed','settled')),
 processed_sha256 text CHECK(processed_sha256 ~ '^[0-9a-f]{64}$'),
 core_snapshot_sha256 text CHECK(core_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
 last_checked_at timestamptz NOT NULL DEFAULT '-infinity',
 claimed_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 execution_deadline timestamptz NOT NULL DEFAULT clock_timestamp()+interval '600 seconds',
 review_deadline timestamptz NOT NULL DEFAULT clock_timestamp()+interval '660 seconds',
 CHECK((phase<>'claimed') OR (processed_sha256 IS NOT NULL AND core_snapshot_sha256 IS NOT NULL AND claimed_at IS NOT NULL))
);
CREATE UNIQUE INDEX inference_key ON cloud_platform_billing.inference_requests(issuer,user_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX inference_pending ON cloud_platform_billing.inference_requests(last_checked_at,created_at,request_id) WHERE phase<>'settled';
CREATE TABLE cloud_platform_billing.inference_facts (
 nonce uuid NOT NULL REFERENCES cloud_platform_billing.inference_requests(nonce),
 fact_sha256 text NOT NULL CHECK(fact_sha256 ~ '^[0-9a-f]{64}$'),
 fact jsonb NOT NULL CHECK(octet_length(fact::text)<=16384),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(nonce,fact_sha256)
);
CREATE TABLE cloud_platform_billing.inference_receipts (
 request_id text PRIMARY KEY REFERENCES cloud_platform_billing.inference_requests,
 mode text NOT NULL CHECK(mode IN('shadow','promo')),verdict text NOT NULL,
 fee_micro_usd bigint NOT NULL CHECK(fee_micro_usd>=0),
 promo_micro_usd bigint NOT NULL CHECK(promo_micro_usd>=0),
 waiver_micro_usd bigint NOT NULL CHECK(waiver_micro_usd>=0),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(fee_micro_usd=promo_micro_usd+waiver_micro_usd)
);
CREATE TABLE cloud_platform_billing.shadow_accounts (
 issuer text NOT NULL,user_id text NOT NULL,remaining_micro_usd bigint NOT NULL DEFAULT 10000000 CHECK(remaining_micro_usd>=0),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '720 hours',PRIMARY KEY(issuer,user_id)
);
CREATE FUNCTION cloud_platform_billing.begin_inference(
 p_issuer text,p_user text,p_request text,p_key text,p_nonce uuid,p_mode text,p_snapshot jsonb,p_digest text,p_direct boolean,p_deadline timestamptz)
RETURNS TABLE(request_id text,nonce uuid,mode text,owned boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing cloud_platform_billing.inference_requests; admission cloud_platform_billing.promo_requests;
 at_time timestamptz;n bigint; shadow cloud_platform_billing.shadow_accounts;
BEGIN
 PERFORM cloud_platform_billing.lock_risk();PERFORM cloud_platform_billing.lock_user(p_issuer,p_user);
 SELECT r.* INTO existing FROM cloud_platform_billing.inference_requests r WHERE r.request_id=p_request
 OR(r.issuer=p_issuer AND r.user_id=p_user AND r.idempotency_key=p_key) LIMIT 1;
 IF FOUND THEN
  IF existing.issuer<>p_issuer OR existing.user_id<>p_user OR existing.execution_sha256<>p_digest THEN RAISE EXCEPTION 'inference idempotency conflict'; END IF;
  RETURN QUERY SELECT existing.request_id,existing.nonce,existing.mode,false;RETURN;
 END IF;
 IF p_request IS NULL OR length(p_request) NOT BETWEEN 1 AND 256 OR p_user IS NULL OR length(p_user) NOT BETWEEN 1 AND 256
 OR p_issuer IS NULL OR length(p_issuer) NOT BETWEEN 1 AND 256 OR (p_key IS NOT NULL AND length(p_key) NOT BETWEEN 1 AND 256)
 OR p_deadline IS NULL OR p_deadline<=clock_timestamp() THEN RAISE EXCEPTION 'invalid inference identity or deadline'; END IF;
 IF p_snapshot->>'vocab_sha256' IS DISTINCT FROM '223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7' OR p_snapshot->>'version' IS DISTINCT FROM 'cl100k_0_7_text_tools_micro_v3' OR p_snapshot->>'normalization' IS DISTINCT FROM 'cloud_text_tools_json_micro_v3'
 OR (p_snapshot->>'reused_input_tokens')::bigint IS DISTINCT FROM 0 OR p_snapshot->>'total_input_tokens' IS NULL OR p_snapshot->>'input_bytes' IS NULL
 OR (p_snapshot->>'total_input_tokens')::bigint<>(p_snapshot->>'billable_input_tokens')::bigint THEN RAISE EXCEPTION 'unsupported meter snapshot'; END IF;
 IF EXISTS(SELECT FROM cloud_platform_billing.promo_requests a WHERE a.request_id=p_request OR(a.issuer=p_issuer AND a.user_id=p_user AND a.idempotency_key=p_key)) THEN RAISE EXCEPTION 'sidecar-less original exists; recovery only, never dispatch'; END IF;
 IF (SELECT count(*) FROM cloud_platform_billing.inference_requests r WHERE r.phase<>'settled')>=1024
 OR (SELECT count(*) FROM cloud_platform_billing.inference_requests r WHERE r.phase<>'settled' AND r.issuer=p_issuer AND r.user_id=p_user)>=32 THEN RAISE EXCEPTION 'shared inference exposure limit'; END IF;
 IF (SELECT count(*) FROM cloud_platform_billing.inference_requests r WHERE r.created_at>=date_trunc('minute',clock_timestamp()))>=12000
 OR (SELECT count(*) FROM cloud_platform_billing.inference_requests r WHERE r.issuer=p_issuer AND r.user_id=p_user AND r.created_at>=date_trunc('minute',clock_timestamp()))>=120 THEN RAISE EXCEPTION 'shared inference request rate limit'; END IF;
 IF p_mode='promo' THEN
  SELECT * INTO admission FROM cloud_platform_billing.admit_promo(p_issuer,p_user,p_request,p_key,p_digest,p_snapshot->>'version',(p_snapshot->>'total_input_tokens')::bigint,(p_snapshot->>'input_bytes')::bigint);
  IF admission.request_id<>p_request THEN RAISE EXCEPTION 'original fee row has no inference owner; do not adopt'; END IF;
 ELSE
  IF p_mode<>'shadow' OR (p_snapshot->>'total_input_tokens')::bigint NOT BETWEEN 0 AND 131072 OR (p_snapshot->>'input_bytes')::bigint NOT BETWEEN 0 AND 1048576 THEN RAISE EXCEPTION 'invalid shadow admission'; END IF;
  IF (SELECT count(*) FROM cloud_platform_billing.inference_requests r WHERE r.phase<>'settled')>=1024
  OR (SELECT count(*) FROM cloud_platform_billing.inference_requests r WHERE r.phase<>'settled' AND r.issuer=p_issuer AND r.user_id=p_user)>=32 THEN RAISE EXCEPTION 'shadow exposure limit'; END IF;
  SELECT count(*) INTO n FROM cloud_platform_billing.inference_requests r WHERE r.mode='shadow' AND r.created_at>=date_trunc('minute',clock_timestamp());
  IF n>=12000 THEN RAISE EXCEPTION 'shadow global rate limit'; END IF;
  SELECT count(*) INTO n FROM cloud_platform_billing.inference_requests r WHERE r.mode='shadow' AND r.issuer=p_issuer AND r.user_id=p_user AND r.created_at>=date_trunc('minute',clock_timestamp());
  IF n>=120 THEN RAISE EXCEPTION 'shadow user rate limit'; END IF;
  INSERT INTO cloud_platform_billing.shadow_accounts(issuer,user_id) VALUES(p_issuer,p_user) ON CONFLICT DO NOTHING;
  SELECT * INTO shadow FROM cloud_platform_billing.shadow_accounts WHERE issuer=p_issuer AND user_id=p_user FOR UPDATE;
  IF shadow.remaining_micro_usd<=0 OR shadow.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'hypothetical promo admission exhausted or expired';END IF;
 END IF;
 at_time:=clock_timestamp();
 INSERT INTO cloud_platform_billing.inference_requests(request_id,issuer,user_id,idempotency_key,nonce,mode,direct_final_hop,snapshot,execution_sha256,created_at,execution_deadline,review_deadline)
 VALUES(p_request,p_issuer,p_user,p_key,p_nonce,p_mode,p_direct,p_snapshot,p_digest,at_time,least(p_deadline,at_time+interval '600 seconds'),least(p_deadline,at_time+interval '600 seconds')+interval '60 seconds');
 RETURN QUERY SELECT p_request,p_nonce,p_mode,true;
END $$;
CREATE FUNCTION cloud_platform_billing.retain_inference_fact(p_nonce uuid,p_fact jsonb,p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF jsonb_typeof(p_fact) IS DISTINCT FROM 'object' OR p_fact->>'nonce' IS DISTINCT FROM p_nonce::text OR p_fact->>'kind' IS NULL OR p_fact->>'kind' NOT IN('semantic','wire','failure','core_delivery','execution') THEN RAISE EXCEPTION 'invalid inference fact identity'; END IF;
 PERFORM 1 FROM cloud_platform_billing.inference_requests WHERE nonce=p_nonce FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'original inference nonce missing';END IF;
 IF NOT EXISTS(SELECT FROM cloud_platform_billing.inference_facts WHERE nonce=p_nonce AND fact_sha256=p_hash)
 AND (SELECT count(*) FROM cloud_platform_billing.inference_facts WHERE nonce=p_nonce)>=32 THEN RAISE EXCEPTION 'inference fact budget exceeded';END IF;
 INSERT INTO cloud_platform_billing.inference_facts(nonce,fact_sha256,fact) VALUES(p_nonce,p_hash,p_fact) ON CONFLICT DO NOTHING;
 RETURN EXISTS(SELECT FROM cloud_platform_billing.inference_facts f JOIN cloud_platform_billing.inference_requests r USING(nonce) WHERE f.nonce=p_nonce AND f.fact_sha256=p_hash AND f.recorded_at<=r.review_deadline);
END $$;
CREATE FUNCTION cloud_platform_billing.claim_inference(p_request text,p_nonce uuid,p_user text,p_processed text,p_snapshot text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r cloud_platform_billing.inference_requests;a cloud_platform_billing.accounts;
BEGIN
 SELECT * INTO r FROM cloud_platform_billing.inference_requests WHERE request_id=p_request;
 IF NOT FOUND OR r.nonce<>p_nonce OR r.user_id<>p_user OR r.phase<>'preparing' OR clock_timestamp()>=r.execution_deadline THEN RAISE EXCEPTION 'original billing dispatch owner closed or mismatched'; END IF;
 PERFORM cloud_platform_billing.lock_user(r.issuer,r.user_id);
 SELECT * INTO r FROM cloud_platform_billing.inference_requests WHERE request_id=p_request FOR UPDATE;
 IF r.nonce<>p_nonce OR r.user_id<>p_user OR r.phase<>'preparing' OR clock_timestamp()>=r.execution_deadline THEN RAISE EXCEPTION 'billing owner changed while waiting';END IF;
 IF r.mode='promo' THEN
  SELECT * INTO a FROM cloud_platform_billing.accounts WHERE issuer=r.issuer AND user_id=r.user_id FOR UPDATE;
  IF NOT FOUND OR a.lifecycle<>'open' OR a.auth_status<>'active' OR NOT a.email_verified OR a.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'final billing eligibility denied'; END IF;
  PERFORM cloud_platform_billing.lock_setting(r.issuer,r.user_id);
  IF a.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'final eligibility expired while waiting for settings'; END IF;
 END IF;
 UPDATE cloud_platform_billing.inference_requests SET phase='claimed',processed_sha256=p_processed,core_snapshot_sha256=p_snapshot,claimed_at=clock_timestamp() WHERE request_id=p_request AND phase='preparing' AND clock_timestamp()<execution_deadline;
 IF NOT FOUND THEN RAISE EXCEPTION 'billing claim lost'; END IF;
END $$;
CREATE FUNCTION cloud_platform_billing.finish_inference(p_request text,p_tokens bigint,p_verdict text,p_evidence text)
RETURNS cloud_platform_billing.inference_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r cloud_platform_billing.inference_requests; receipt cloud_platform_billing.inference_receipts;
 actual cloud_platform_billing.promo_settlements;s cloud_platform_billing.shadow_accounts;f bigint;p bigint;
BEGIN
 PERFORM cloud_platform_billing.lock_risk();
 SELECT * INTO r FROM cloud_platform_billing.inference_requests WHERE request_id=p_request;
 IF NOT FOUND THEN RAISE EXCEPTION 'original inference missing'; END IF;
 PERFORM cloud_platform_billing.lock_user(r.issuer,r.user_id);
 SELECT * INTO r FROM cloud_platform_billing.inference_requests WHERE request_id=p_request FOR UPDATE;
 SELECT * INTO receipt FROM cloud_platform_billing.inference_receipts WHERE request_id=p_request;
 IF FOUND THEN RETURN receipt; END IF;
 -- A final original P1 settlement wins even when its commit ACK was lost.
 -- Never invent a new verdict/waiver or re-run monetary mutation in that case.
 IF r.mode='promo' THEN
  IF NOT EXISTS(SELECT FROM cloud_platform_billing.promo_requests a WHERE a.request_id=p_request AND a.issuer=r.issuer AND a.user_id=r.user_id AND a.execution_sha256=r.execution_sha256) THEN RAISE EXCEPTION 'original promo identity mismatch'; END IF;
  SELECT * INTO actual FROM cloud_platform_billing.promo_settlements WHERE request_id=p_request;
  IF FOUND THEN
   INSERT INTO cloud_platform_billing.inference_receipts(request_id,mode,verdict,fee_micro_usd,promo_micro_usd,waiver_micro_usd,evidence_sha256)
   VALUES(p_request,r.mode,actual.verdict,actual.fee_micro_usd,actual.promo_micro_usd,actual.waiver_micro_usd,actual.evidence_sha256) RETURNING * INTO receipt;
   UPDATE cloud_platform_billing.inference_requests SET phase='settled' WHERE request_id=p_request;RETURN receipt;
  END IF;
 END IF;
 IF p_verdict NOT IN('complete','qualified_stop','failed','closed_unproven') OR (p_verdict IN('complete','qualified_stop') AND p_tokens<>(r.snapshot->>'total_input_tokens')::bigint) THEN RAISE EXCEPTION 'invalid fee verdict'; END IF;
 IF p_tokens<0 OR p_tokens>(r.snapshot->>'total_input_tokens')::bigint OR (p_verdict IN('failed','closed_unproven') AND p_tokens<>0) THEN RAISE EXCEPTION 'invalid fee decision'; END IF;
 IF p_tokens>0 AND EXISTS(SELECT FROM cloud_platform_billing.inference_facts f WHERE f.nonce=r.nonce AND f.recorded_at<=r.review_deadline AND (f.fact->>'kind'='failure' OR(f.fact->>'kind'='semantic' AND f.fact->'result'->>'failed'='true') OR(f.fact->>'kind'='execution' AND f.fact->>'outcome'='failed'))) THEN RETURN NULL;END IF;
 IF p_tokens>0 AND (r.processed_sha256 IS NULL OR r.core_snapshot_sha256 IS NULL) THEN RAISE EXCEPTION 'unprocessed input cannot be charged'; END IF;
 IF p_verdict='closed_unproven' AND clock_timestamp()<r.review_deadline THEN RAISE EXCEPTION 'charging review window still open'; END IF;
 IF r.mode='promo' THEN
  SELECT * INTO actual FROM cloud_platform_billing.settle_promo(p_request,p_tokens,p_verdict,p_evidence);f:=actual.fee_micro_usd;p:=actual.promo_micro_usd;
 ELSE
  SELECT * INTO s FROM cloud_platform_billing.shadow_accounts WHERE issuer=r.issuer AND user_id=r.user_id FOR UPDATE;
  f:=p_tokens/100;p:=CASE WHEN s.expires_at>clock_timestamp() THEN least(f,s.remaining_micro_usd) ELSE 0 END;
  UPDATE cloud_platform_billing.shadow_accounts SET remaining_micro_usd=remaining_micro_usd-p WHERE issuer=r.issuer AND user_id=r.user_id;
 END IF;
 INSERT INTO cloud_platform_billing.inference_receipts(request_id,mode,verdict,fee_micro_usd,promo_micro_usd,waiver_micro_usd,evidence_sha256)
 VALUES(p_request,r.mode,p_verdict,f,p,f-p,p_evidence) RETURNING * INTO receipt;
 UPDATE cloud_platform_billing.inference_requests SET phase='settled' WHERE request_id=p_request;
 RETURN receipt;
END $$;
CREATE FUNCTION cloud_platform_billing.touch_inference(p_request text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 UPDATE cloud_platform_billing.inference_requests SET last_checked_at=clock_timestamp() WHERE request_id=p_request AND phase<>'settled';
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA cloud_platform_billing FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cloud_platform_billing FROM PUBLIC;
UPDATE cloud_platform_billing.schema_version SET version=3;
COMMIT;
