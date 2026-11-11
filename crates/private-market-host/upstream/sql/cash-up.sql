-- Offline, quiesced P3 adapter. Cash is held in the existing ledger/account;
-- this table is an immutable allocation of that cash, never a second wallet.
BEGIN;
DO $$ BEGIN
 IF (SELECT version FROM cloud_platform_billing.schema_version)<>3 THEN RAISE EXCEPTION 'P3 requires installed P2'; END IF;
 IF EXISTS(SELECT FROM cloud_platform_billing.inference_requests WHERE phase<>'settled') THEN RAISE EXCEPTION 'quiesce and settle P2 before P3'; END IF;
END $$;
ALTER TABLE cloud_platform_billing.schema_version DROP CONSTRAINT schema_version_version_check;
ALTER TABLE cloud_platform_billing.schema_version ADD CHECK(version IN(1,2,3,4));
ALTER TABLE cloud_platform_billing.inference_requests DROP CONSTRAINT inference_requests_mode_check;
ALTER TABLE cloud_platform_billing.inference_requests ADD CHECK(mode IN('shadow','promo','cash'));
ALTER TABLE cloud_platform_billing.inference_requests ADD COLUMN setting_revision bigint;
ALTER TABLE cloud_platform_billing.inference_receipts DROP CONSTRAINT inference_receipts_mode_check;
ALTER TABLE cloud_platform_billing.inference_receipts DROP CONSTRAINT inference_receipts_check;
ALTER TABLE cloud_platform_billing.inference_receipts ADD COLUMN cash_micro_usd bigint NOT NULL DEFAULT 0 CHECK(cash_micro_usd>=0);
ALTER TABLE cloud_platform_billing.inference_receipts ADD CHECK(mode IN('shadow','promo','cash'));
ALTER TABLE cloud_platform_billing.inference_receipts ADD CHECK(fee_micro_usd=promo_micro_usd+waiver_micro_usd+cash_micro_usd);
CREATE TABLE cloud_platform_billing.cash_holds (
 request_id text PRIMARY KEY REFERENCES cloud_platform_billing.inference_requests,
 nonce uuid NOT NULL UNIQUE,user_id text NOT NULL,
 cap_micro_usd bigint NOT NULL CHECK(cap_micro_usd BETWEEN 0 AND 1310),
 state text NOT NULL CHECK(state IN('reserved','held','settled')),
 fee_micro_usd bigint CHECK(fee_micro_usd BETWEEN 0 AND cap_micro_usd),
 reserve_ledger_id text UNIQUE,release_ledger_id text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),settled_at timestamptz,
 CHECK((state='settled')=(fee_micro_usd IS NOT NULL AND settled_at IS NOT NULL)),
 CHECK((cap_micro_usd=0)=(reserve_ledger_id IS NULL))
);
CREATE INDEX cash_holds_user ON cloud_platform_billing.cash_holds(user_id);
CREATE INDEX inference_account_receipts ON cloud_platform_billing.inference_requests(issuer,user_id,created_at DESC,request_id DESC) WHERE mode<>'shadow';
CREATE FUNCTION cloud_platform_billing.guard_cash_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'cash allocation evidence cannot be deleted';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'reserved' OR NEW.fee_micro_usd IS NOT NULL OR NEW.release_ledger_id IS NOT NULL OR NEW.settled_at IS NOT NULL
  OR NOT EXISTS(SELECT FROM cloud_platform_billing.inference_requests r WHERE r.request_id=NEW.request_id AND r.nonce=NEW.nonce AND r.user_id=NEW.user_id AND r.mode='cash' AND r.phase='preparing' AND (r.snapshot->>'total_input_tokens')::bigint/100=NEW.cap_micro_usd)
  THEN RAISE EXCEPTION 'invalid initial cash allocation';END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.request_id,NEW.nonce,NEW.user_id,NEW.cap_micro_usd,NEW.reserve_ledger_id,NEW.created_at)
    IS DISTINCT FROM (OLD.request_id,OLD.nonce,OLD.user_id,OLD.cap_micro_usd,OLD.reserve_ledger_id,OLD.created_at)
  OR OLD.state='settled' OR (OLD.state='held' AND NEW.state NOT IN('held','settled'))
  OR (NEW.state<>'settled' AND (NEW.fee_micro_usd IS NOT NULL OR NEW.release_ledger_id IS NOT NULL OR NEW.settled_at IS NOT NULL))
  THEN RAISE EXCEPTION 'cash allocation identity or lifecycle conflict'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cash_hold_identity BEFORE INSERT OR UPDATE OR DELETE ON cloud_platform_billing.cash_holds FOR EACH ROW EXECUTE FUNCTION cloud_platform_billing.guard_cash_hold();
CREATE TRIGGER cash_hold_no_truncate BEFORE TRUNCATE ON cloud_platform_billing.cash_holds FOR EACH STATEMENT EXECUTE FUNCTION cloud_platform_billing.guard_cash_hold();

-- Exact new ledger envelope, including original fee identity and allocation.
-- Called by BOTH original mutation and deferred ledger guards below.
CREATE FUNCTION cloud_platform_billing.check_cash_ledger(p_id text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE l public.credit_ledger_entries;h cloud_platform_billing.cash_holds;u text;r cloud_platform_billing.inference_requests;d bigint;
BEGIN
 SELECT * INTO l FROM public.credit_ledger_entries WHERE id=p_id;
 SELECT * INTO h FROM cloud_platform_billing.cash_holds WHERE reserve_ledger_id=p_id OR release_ledger_id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'cash ledger has no original hold'; END IF;
 SELECT * INTO r FROM cloud_platform_billing.inference_requests WHERE request_id=h.request_id;
 SELECT user_id INTO u FROM public.credit_accounts WHERE id=l.credit_account_id AND currency='USD';
 IF l.entry_type='platform_reserve' THEN
  d:=-h.cap_micro_usd;
  IF h.reserve_ledger_id IS DISTINCT FROM p_id OR l.idempotency_key IS DISTINCT FROM ('platform_reserve:'||h.nonce::text) THEN RAISE EXCEPTION 'cash reserve identity conflict'; END IF;
 ELSIF l.entry_type='platform_release' THEN
  d:=h.cap_micro_usd-h.fee_micro_usd;
  IF h.state<>'settled' OR h.release_ledger_id IS DISTINCT FROM p_id OR l.idempotency_key IS DISTINCT FROM ('platform_release:'||h.nonce::text) THEN RAISE EXCEPTION 'cash release identity conflict'; END IF;
 ELSE RAISE EXCEPTION 'unsupported cash ledger type';END IF;
 IF d IS NULL OR d=0 OR l.amount_micro_usd IS DISTINCT FROM d OR l.currency IS DISTINCT FROM 'USD'
 OR u IS DISTINCT FROM h.user_id OR r.mode IS DISTINCT FROM 'cash' OR r.user_id IS DISTINCT FROM u
 OR r.nonce IS DISTINCT FROM h.nonce OR l.request_id IS NOT NULL
 OR l.metadata IS DISTINCT FROM jsonb_build_object('fee_kind','byok_platform_fee','nonce',h.nonce::text,'cash_policy','micro_escrow_v1','request_id',h.request_id) THEN RAISE EXCEPTION 'cash ledger envelope conflict'; END IF;
 RETURN d;
END $$;

-- Strict PG side of reserve. Caller owns the original request/user money fence
-- and has just checked Redis under that fence. All prepared debts are counted
-- conservatively, including unacknowledged external debits; never just balance.
CREATE FUNCTION cloud_platform_billing.reserve_cash(p_request text,p_available bigint)
RETURNS cloud_platform_billing.cash_holds
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r cloud_platform_billing.inference_requests;h cloud_platform_billing.cash_holds;
 a public.credit_accounts;available numeric;cap bigint;lid text;
BEGIN
 SELECT * INTO r FROM cloud_platform_billing.inference_requests WHERE request_id=p_request;
 IF NOT FOUND OR r.mode<>'cash' OR r.phase<>'preparing' THEN RAISE EXCEPTION 'cash original not preparing'; END IF;
 PERFORM pg_advisory_xact_lock(public.request_identity_advisory_key(p_request));
 PERFORM pg_advisory_xact_lock(public.balance_cache_advisory_key(r.user_id));
 PERFORM cloud_platform_billing.lock_user(r.issuer,r.user_id);
 PERFORM cloud_platform_billing.lock_setting(r.issuer,r.user_id);
 SELECT * INTO r FROM cloud_platform_billing.inference_requests WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND OR r.mode<>'cash' OR r.phase<>'preparing' OR clock_timestamp()>=r.execution_deadline THEN RAISE EXCEPTION 'cash original closed while waiting';END IF;
 SELECT * INTO h FROM cloud_platform_billing.cash_holds WHERE request_id=p_request;
 IF FOUND THEN RETURN h; END IF;
 IF clock_timestamp()>=r.execution_deadline THEN RAISE EXCEPTION 'cash admission deadline';END IF;
 IF NOT EXISTS(SELECT FROM cloud_platform_billing.account_settings s WHERE s.issuer=r.issuer AND s.user_id=r.user_id AND s.cash_fallback_enabled AND s.revision=r.setting_revision) THEN RAISE EXCEPTION 'cash_fallback_disabled';END IF;
 IF NOT EXISTS(SELECT FROM public.requests WHERE request_id=p_request AND user_id=r.user_id AND status='pending') THEN RAISE EXCEPTION 'original cash public request is unavailable';END IF;
 cap:=(r.snapshot->>'total_input_tokens')::bigint/100;
 IF EXISTS(SELECT FROM public.redis_balance_mutations WHERE user_id=r.user_id AND state IN('pending','manual_review'))
 OR EXISTS(SELECT FROM public.request_billing_collections WHERE user_id=r.user_id AND state='manual_review')
 OR (SELECT count(*) FROM public.request_billing_collections WHERE user_id=r.user_id AND state='prepared')>1024
 THEN RAISE EXCEPTION 'cash dependency requires recovery';END IF;
 SELECT * INTO a FROM public.credit_accounts WHERE user_id=r.user_id FOR UPDATE;
 available:=coalesce(a.balance_micro_usd,0)::numeric
 -coalesce((SELECT sum(amount_micro_usd::numeric) FROM public.pending_debits WHERE user_id=r.user_id),0)
 -coalesce((SELECT sum(c.amount_micro_usd::numeric) FROM public.request_billing_collections c WHERE c.user_id=r.user_id AND c.state='prepared'),0);
 IF p_available IS NULL OR p_available<cap OR available<cap THEN RAISE EXCEPTION 'cash_insufficient';END IF;
 IF a.id IS NOT NULL AND a.currency<>'USD' THEN RAISE EXCEPTION 'original cash account is not USD';END IF;
 IF cap>0 AND a.id IS NULL THEN RAISE EXCEPTION 'cash_insufficient';END IF;
 lid:=CASE WHEN cap>0 THEN 'pfr_'||r.nonce::text END;
 INSERT INTO cloud_platform_billing.cash_holds(request_id,nonce,user_id,cap_micro_usd,state,reserve_ledger_id)
 VALUES(p_request,r.nonce,r.user_id,cap,'reserved',lid) RETURNING * INTO h;
 IF cap>0 THEN
  UPDATE public.credit_accounts SET balance_micro_usd=balance_micro_usd-cap WHERE id=a.id;
  INSERT INTO public.credit_ledger_entries(id,credit_account_id,entry_type,amount_micro_usd,currency,request_id,idempotency_key,metadata)
  VALUES(lid,a.id,'platform_reserve',-cap,'USD',NULL,'platform_reserve:'||r.nonce::text,jsonb_build_object('fee_kind','byok_platform_fee','nonce',r.nonce::text,'cash_policy','micro_escrow_v1','request_id',p_request));
 END IF;
 RETURN h;
END $$;

CREATE FUNCTION cloud_platform_billing.ack_cash(p_request text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h cloud_platform_billing.cash_holds;
BEGIN
 SELECT * INTO h FROM cloud_platform_billing.cash_holds WHERE request_id=p_request;
 IF NOT FOUND THEN RAISE EXCEPTION 'cash hold missing';END IF;
 PERFORM pg_advisory_xact_lock(public.balance_cache_advisory_key(h.user_id));
 SELECT * INTO h FROM cloud_platform_billing.cash_holds WHERE request_id=p_request FOR UPDATE;
 IF h.state='settled' THEN RAISE EXCEPTION 'cash hold already closed';END IF;
 IF h.cap_micro_usd>0 AND NOT EXISTS(SELECT FROM public.redis_balance_mutations WHERE ledger_entry_id=h.reserve_ledger_id AND user_id=h.user_id AND signed_delta_micro_usd=-h.cap_micro_usd AND state='applied') THEN RAISE EXCEPTION 'cash reserve acknowledgement unknown';END IF;
 UPDATE cloud_platform_billing.cash_holds SET state='held' WHERE request_id=p_request;
END $$;

CREATE FUNCTION cloud_platform_billing.settle_cash(p_request text,p_fee bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h cloud_platform_billing.cash_holds;a public.credit_accounts;lid text;unused bigint;
BEGIN
 SELECT * INTO h FROM cloud_platform_billing.cash_holds WHERE request_id=p_request FOR UPDATE;
 IF NOT FOUND THEN IF p_fee=0 THEN RETURN;ELSE RAISE EXCEPTION 'positive fee lacks cash hold';END IF;END IF;
 IF h.state='settled' THEN IF h.fee_micro_usd<>p_fee THEN RAISE EXCEPTION 'cash fee conflict';END IF;RETURN;END IF;
 IF p_fee<0 OR p_fee>h.cap_micro_usd OR(p_fee>0 AND h.state<>'held') THEN RAISE EXCEPTION 'cash fee outside original hold';END IF;
 SELECT * INTO a FROM public.credit_accounts WHERE user_id=h.user_id FOR UPDATE;
 unused:=h.cap_micro_usd-p_fee;
 lid:=CASE WHEN unused>0 THEN 'pfu_'||h.nonce::text END;
 UPDATE cloud_platform_billing.cash_holds SET state='settled',fee_micro_usd=p_fee,release_ledger_id=lid,settled_at=clock_timestamp() WHERE request_id=p_request;
 IF unused>0 THEN
  IF a.id IS NULL OR a.currency<>'USD' THEN RAISE EXCEPTION 'original cash account is unavailable';END IF;
  UPDATE public.credit_accounts SET balance_micro_usd=balance_micro_usd+unused WHERE id=a.id;
  INSERT INTO public.credit_ledger_entries(id,credit_account_id,entry_type,amount_micro_usd,currency,request_id,idempotency_key,metadata)
  VALUES(lid,a.id,'platform_release',unused,'USD',NULL,'platform_release:'||h.nonce::text,jsonb_build_object('fee_kind','byok_platform_fee','nonce',h.nonce::text,'cash_policy','micro_escrow_v1','request_id',p_request));
 END IF;
END $$;

CREATE FUNCTION cloud_platform_billing.check_hold_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE h cloud_platform_billing.cash_holds;unused bigint;
BEGIN
 SELECT * INTO h FROM cloud_platform_billing.cash_holds WHERE request_id=NEW.request_id;
 IF h.cap_micro_usd>0 THEN
  IF cloud_platform_billing.check_cash_ledger(h.reserve_ledger_id)<>-h.cap_micro_usd
   OR NOT EXISTS(SELECT FROM public.redis_balance_mutations m WHERE m.ledger_entry_id=h.reserve_ledger_id AND m.user_id=h.user_id AND m.signed_delta_micro_usd=-h.cap_micro_usd AND(h.state<>'held' OR m.state='applied')) THEN RAISE EXCEPTION 'cash allocation lacks exact reserve evidence';END IF;
 END IF;
 IF h.state='settled' THEN
  IF NOT EXISTS(SELECT FROM cloud_platform_billing.inference_receipts r WHERE r.request_id=h.request_id AND r.mode='cash' AND r.cash_micro_usd=h.fee_micro_usd AND r.promo_micro_usd=0 AND r.waiver_micro_usd=0) THEN RAISE EXCEPTION 'cash allocation lacks exact fee receipt';END IF;
  unused:=h.cap_micro_usd-h.fee_micro_usd;
  IF unused>0 THEN
   IF cloud_platform_billing.check_cash_ledger(h.release_ledger_id)<>unused
    OR NOT EXISTS(SELECT FROM public.redis_balance_mutations m WHERE m.ledger_entry_id=h.release_ledger_id AND m.user_id=h.user_id AND m.signed_delta_micro_usd=unused) THEN RAISE EXCEPTION 'cash allocation lacks exact release evidence';END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER cash_hold_evidence AFTER INSERT OR UPDATE ON cloud_platform_billing.cash_holds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cloud_platform_billing.check_hold_evidence();

-- Every new escrow ledger automatically creates the ORIGINAL mutation outbox
-- in the same transaction; no runtime writer can omit the durable recovery job.
CREATE FUNCTION cloud_platform_billing.cash_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE u text;d bigint;mid text;
BEGIN
 IF NEW.entry_type NOT IN('platform_reserve','platform_release') THEN RETURN NEW;END IF;
 d:=cloud_platform_billing.check_cash_ledger(NEW.id);
 SELECT user_id INTO u FROM public.credit_accounts WHERE id=NEW.credit_account_id;
 -- PostgreSQL's SHA256 has the same domain and NUL separator as the Rust owner.
 mid:='rbm_v2_'||encode(sha256(convert_to('bitrouter:redis-balance-mutation:v2','UTF8')||decode('00','hex')||convert_to(NEW.id,'UTF8')),'hex');
 INSERT INTO public.redis_balance_mutations(mutation_id,user_id,ledger_entry_id,signed_delta_micro_usd) VALUES(mid,u,NEW.id,d);
 RETURN NEW;
END $$;
CREATE TRIGGER trg_credit_ledger_entries_platform_cash_outbox AFTER INSERT ON public.credit_ledger_entries
FOR EACH ROW EXECUTE FUNCTION cloud_platform_billing.cash_outbox();

REVOKE ALL ON ALL TABLES IN SCHEMA cloud_platform_billing FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cloud_platform_billing FROM PUBLIC;
-- P3 extends the frozen P2 request contract without changing its function signatures.

CREATE OR REPLACE FUNCTION cloud_platform_billing.begin_inference(
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
 IF p_mode IS NULL OR p_mode NOT IN('shadow','promo','auto','auto_free') THEN RAISE EXCEPTION 'unsupported funding selection';END IF;
 IF p_mode IN('auto','auto_free') THEN
  PERFORM cloud_platform_billing.lock_setting(p_issuer,p_user);
  IF NOT EXISTS(SELECT FROM cloud_platform_billing.accounts a WHERE a.issuer=p_issuer AND a.user_id=p_user AND a.lifecycle='open' AND a.auth_status='active' AND a.email_verified AND a.valid_until>clock_timestamp()) THEN RAISE EXCEPTION 'billing_eligibility_unavailable';END IF;
  IF EXISTS(SELECT FROM cloud_platform_billing.grants g WHERE g.issuer=p_issuer AND g.user_id=p_user AND g.remaining_micro_usd>0 AND g.expires_at>clock_timestamp()) THEN p_mode:='promo';
  ELSE
   IF p_mode='auto_free' THEN RAISE EXCEPTION 'cash_capability_disabled';END IF;
   IF NOT (SELECT cash_fallback_enabled FROM cloud_platform_billing.account_settings WHERE issuer=p_issuer AND user_id=p_user) THEN RAISE EXCEPTION 'cash_fallback_disabled';END IF;
   p_mode:='cash';
  END IF;
 END IF;
 IF p_mode='cash' THEN
  IF (p_snapshot->>'total_input_tokens')::bigint NOT BETWEEN 0 AND 131072 OR (p_snapshot->>'input_bytes')::bigint NOT BETWEEN 0 AND 1048576 THEN RAISE EXCEPTION 'input risk limit';END IF;
 ELSIF p_mode='promo' THEN
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
 IF p_mode='cash' THEN UPDATE cloud_platform_billing.inference_requests SET setting_revision=(SELECT revision FROM cloud_platform_billing.account_settings WHERE issuer=p_issuer AND user_id=p_user) WHERE inference_requests.request_id=p_request;END IF;
 RETURN QUERY SELECT p_request,p_nonce,p_mode,true;
END $$;
CREATE OR REPLACE FUNCTION cloud_platform_billing.claim_inference(p_request text,p_nonce uuid,p_user text,p_processed text,p_snapshot text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r cloud_platform_billing.inference_requests;a cloud_platform_billing.accounts;
BEGIN
 SELECT * INTO r FROM cloud_platform_billing.inference_requests WHERE request_id=p_request;
 IF NOT FOUND OR r.nonce<>p_nonce OR r.user_id<>p_user OR r.phase<>'preparing' OR clock_timestamp()>=r.execution_deadline THEN RAISE EXCEPTION 'original billing dispatch owner closed or mismatched'; END IF;
 IF r.mode='cash' THEN PERFORM pg_advisory_xact_lock(public.request_identity_advisory_key(p_request));PERFORM pg_advisory_xact_lock(public.balance_cache_advisory_key(p_user));END IF;
 PERFORM cloud_platform_billing.lock_user(r.issuer,r.user_id);
 SELECT * INTO r FROM cloud_platform_billing.inference_requests WHERE request_id=p_request FOR UPDATE;
 IF r.nonce<>p_nonce OR r.user_id<>p_user OR r.phase<>'preparing' OR clock_timestamp()>=r.execution_deadline THEN RAISE EXCEPTION 'billing owner changed while waiting';END IF;
 IF r.mode IN('promo','cash') THEN
  SELECT * INTO a FROM cloud_platform_billing.accounts WHERE issuer=r.issuer AND user_id=r.user_id FOR UPDATE;
  IF NOT FOUND OR a.lifecycle<>'open' OR a.auth_status<>'active' OR NOT a.email_verified OR a.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'final billing eligibility denied'; END IF;
  PERFORM cloud_platform_billing.lock_setting(r.issuer,r.user_id);
  IF a.valid_until<=clock_timestamp() THEN RAISE EXCEPTION 'final eligibility expired while waiting for settings'; END IF;
 END IF;
 IF r.mode='cash' THEN
  IF NOT EXISTS(SELECT FROM cloud_platform_billing.account_settings s WHERE s.issuer=r.issuer AND s.user_id=r.user_id AND s.cash_fallback_enabled AND s.revision=r.setting_revision) THEN RAISE EXCEPTION 'cash authorization changed before admission';END IF;
  IF NOT EXISTS(SELECT FROM cloud_platform_billing.cash_holds h WHERE h.request_id=p_request AND h.nonce=p_nonce AND h.user_id=p_user AND h.state='held' AND h.cap_micro_usd=(r.snapshot->>'total_input_tokens')::bigint/100 AND CASE WHEN h.cap_micro_usd=0 THEN true ELSE cloud_platform_billing.check_cash_ledger(h.reserve_ledger_id)=-h.cap_micro_usd AND EXISTS(SELECT FROM public.redis_balance_mutations m WHERE m.ledger_entry_id=h.reserve_ledger_id AND m.user_id=p_user AND m.signed_delta_micro_usd=-h.cap_micro_usd AND m.state='applied') END) THEN RAISE EXCEPTION 'cash guarantee missing';END IF;
  IF EXISTS(SELECT FROM public.redis_balance_mutations WHERE user_id=p_user AND signed_delta_micro_usd<0 AND state IN('pending','manual_review')) THEN RAISE EXCEPTION 'cash funds recovery not ready';END IF;
 END IF;
 UPDATE cloud_platform_billing.inference_requests SET phase='claimed' ,processed_sha256=p_processed,core_snapshot_sha256=p_snapshot,claimed_at=clock_timestamp() WHERE request_id=p_request AND phase='preparing' AND clock_timestamp()<execution_deadline;
 IF NOT FOUND THEN RAISE EXCEPTION 'billing claim lost'; END IF;
END $$;
CREATE OR REPLACE FUNCTION cloud_platform_billing.finish_inference(p_request text,p_tokens bigint,p_verdict text,p_evidence text)
RETURNS cloud_platform_billing.inference_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r cloud_platform_billing.inference_requests; receipt cloud_platform_billing.inference_receipts;
 actual cloud_platform_billing.promo_settlements;s cloud_platform_billing.shadow_accounts;f bigint;p bigint;
BEGIN
 SELECT * INTO r FROM cloud_platform_billing.inference_requests WHERE request_id=p_request;
 IF r.mode='cash' THEN PERFORM pg_advisory_xact_lock(public.request_identity_advisory_key(p_request));PERFORM pg_advisory_xact_lock(public.balance_cache_advisory_key(r.user_id));END IF;
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
 ELSIF r.mode='cash' THEN
  f:=p_tokens/100;p:=0;PERFORM cloud_platform_billing.settle_cash(p_request,f);
 ELSE
  SELECT * INTO s FROM cloud_platform_billing.shadow_accounts WHERE issuer=r.issuer AND user_id=r.user_id FOR UPDATE;
  f:=p_tokens/100;p:=CASE WHEN s.expires_at>clock_timestamp() THEN least(f,s.remaining_micro_usd) ELSE 0 END;
  UPDATE cloud_platform_billing.shadow_accounts SET remaining_micro_usd=remaining_micro_usd-p WHERE issuer=r.issuer AND user_id=r.user_id;
 END IF;
 INSERT INTO cloud_platform_billing.inference_receipts(request_id,mode,verdict,fee_micro_usd,promo_micro_usd,waiver_micro_usd,evidence_sha256,cash_micro_usd)
 VALUES(p_request,r.mode,p_verdict,f,p,CASE WHEN r.mode='cash' THEN 0 ELSE f-p END,p_evidence,CASE WHEN r.mode='cash' THEN f ELSE 0 END) RETURNING * INTO receipt;
 UPDATE cloud_platform_billing.inference_requests SET phase='settled' WHERE request_id=p_request;
 RETURN receipt;
END $$;
CREATE OR REPLACE FUNCTION public.enforce_redis_balance_mutation_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    ledger_user_id text;
    ledger_amount_micro_usd bigint;
    ledger_entry_type text;
    ledger_currency text;
    maximum_next_attempt bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Redis balance mutations cannot be deleted';
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.created_at := clock_timestamp();
        IF NEW.state <> 'pending'
            OR NEW.applied_at IS NOT NULL
            OR NEW.marker_expiry_set_at IS NOT NULL
            OR NEW.manual_reviewed_at IS NOT NULL
            OR NEW.attempt_count <> 0
            OR NEW.last_error_class IS NOT NULL
            OR NEW.resolution_generation <> 0
        THEN
            RAISE EXCEPTION 'Redis balance mutation must begin in a clean pending state';
        END IF;

        SELECT account.user_id,
            ledger.amount_micro_usd,
            ledger.entry_type,
            ledger.currency
        INTO ledger_user_id,
            ledger_amount_micro_usd,
            ledger_entry_type,
            ledger_currency
        FROM public.credit_ledger_entries AS ledger
        JOIN public.credit_accounts AS account
          ON account.id = ledger.credit_account_id
        WHERE ledger.id = NEW.ledger_entry_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Redis balance mutation lacks durable ledger evidence';
        END IF;
        IF NEW.user_id IS DISTINCT FROM ledger_user_id THEN
            RAISE EXCEPTION 'Redis balance mutation user does not match its ledger owner';
        END IF;
        IF ledger_entry_type IN ('platform_reserve','platform_release') THEN
            IF NEW.signed_delta_micro_usd IS DISTINCT FROM cloud_platform_billing.check_cash_ledger(NEW.ledger_entry_id) THEN
                RAISE EXCEPTION 'cash mutation amount mismatch';
            END IF;
            RETURN NEW;
        END IF;
        IF ledger_entry_type NOT IN ('purchase', 'refund', 'dispute_lost') THEN
            RAISE EXCEPTION 'Redis balance mutation requires a cache-changing ledger type';
        END IF;
        IF ledger_currency IS DISTINCT FROM 'USD' THEN
            RAISE EXCEPTION 'Redis balance mutation requires a USD ledger';
        END IF;
        IF (ledger_entry_type = 'purchase' AND ledger_amount_micro_usd <= 0)
            OR (
                ledger_entry_type IN ('refund', 'dispute_lost')
                AND ledger_amount_micro_usd >= 0
            )
        THEN
            RAISE EXCEPTION 'Redis balance mutation ledger amount contradicts its entry type';
        END IF;
        IF ledger_entry_type = 'purchase'
            AND NEW.signed_delta_micro_usd
                IS DISTINCT FROM ledger_amount_micro_usd
        THEN
            RAISE EXCEPTION 'Redis balance purchase mutation delta must equal its ledger amount';
        END IF;
        IF NEW.signed_delta_micro_usd <> 0
            AND NOT (
                (
                    NEW.signed_delta_micro_usd > 0
                    AND ledger_amount_micro_usd > 0
                )
                OR (
                    NEW.signed_delta_micro_usd < 0
                    AND ledger_amount_micro_usd < 0
                )
            )
        THEN
            RAISE EXCEPTION 'Redis balance mutation delta has the wrong ledger amount sign';
        END IF;
        IF pg_catalog.abs(NEW.signed_delta_micro_usd::numeric)
            > pg_catalog.abs(ledger_amount_micro_usd::numeric)
        THEN
            RAISE EXCEPTION 'Redis balance mutation delta exceeds its ledger amount';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.mutation_id IS DISTINCT FROM OLD.mutation_id
        OR NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id
        OR NEW.signed_delta_micro_usd IS DISTINCT FROM OLD.signed_delta_micro_usd
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'Redis balance mutation identity and delta are immutable';
    END IF;

    IF OLD.state = 'manual_review' AND NEW.state = 'pending' THEN
        IF OLD.resolution_generation = 9223372036854775807 THEN
            RAISE EXCEPTION 'Redis balance mutation resolution generation is exhausted';
        END IF;
        IF NEW.resolution_generation
                IS DISTINCT FROM OLD.resolution_generation + 1
            OR NEW.applied_at IS NOT NULL
            OR NEW.marker_expiry_set_at IS NOT NULL
            OR NEW.manual_reviewed_at IS NOT NULL
            OR NEW.attempt_count <> 0
            OR NEW.last_error_class IS NOT NULL
        THEN
            RAISE EXCEPTION 'manual-review Redis balance mutation requires an exact pending resolution';
        END IF;
        IF NOT EXISTS (
            SELECT 1
            FROM public.redis_balance_mutation_resolutions AS resolution
            WHERE resolution.mutation_id = OLD.mutation_id
              AND resolution.resolution_generation = NEW.resolution_generation
              AND resolution.user_id = OLD.user_id
              AND resolution.ledger_entry_id = OLD.ledger_entry_id
              AND resolution.prior_attempt_count = OLD.attempt_count
              AND resolution.prior_error_class = OLD.last_error_class
              AND resolution.prior_applied_at IS NOT DISTINCT FROM OLD.applied_at
              AND resolution.prior_marker_expiry_set_at
                    IS NOT DISTINCT FROM OLD.marker_expiry_set_at
              AND resolution.prior_manual_reviewed_at
                    IS NOT DISTINCT FROM OLD.manual_reviewed_at
        ) THEN
            RAISE EXCEPTION 'manual-review Redis balance mutation lacks exact resolution evidence';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.resolution_generation
        IS DISTINCT FROM OLD.resolution_generation
    THEN
        RAISE EXCEPTION 'Redis balance mutation resolution generation is immutable outside manual review resolution';
    END IF;

    maximum_next_attempt := CASE
        WHEN OLD.attempt_count = 9223372036854775807
            THEN OLD.attempt_count
        ELSE OLD.attempt_count + 1
    END;
    IF NEW.attempt_count < OLD.attempt_count
        OR NEW.attempt_count > maximum_next_attempt
    THEN
        RAISE EXCEPTION 'Redis balance mutation attempt count must advance by at most one and saturate';
    END IF;

    IF OLD.marker_expiry_set_at IS NOT NULL
        AND NEW.marker_expiry_set_at
            IS DISTINCT FROM OLD.marker_expiry_set_at
    THEN
        RAISE EXCEPTION 'Redis balance mutation marker expiry timestamp is immutable';
    END IF;

    IF NEW.state = OLD.state THEN
        IF NEW.applied_at IS DISTINCT FROM OLD.applied_at
            OR NEW.manual_reviewed_at IS DISTINCT FROM OLD.manual_reviewed_at
        THEN
            RAISE EXCEPTION 'Redis balance mutation lifecycle timestamps are immutable without a state transition';
        END IF;

        IF OLD.state = 'pending' THEN
            IF NEW.marker_expiry_set_at IS NOT NULL THEN
                RAISE EXCEPTION 'pending Redis balance mutation cannot acknowledge marker expiry';
            END IF;
            RETURN NEW;
        END IF;

        IF OLD.state = 'applied'
            AND OLD.marker_expiry_set_at IS NULL
        THEN
            IF NEW.marker_expiry_set_at IS NOT NULL THEN
                NEW.marker_expiry_set_at := clock_timestamp();
                IF NEW.marker_expiry_set_at < OLD.applied_at THEN
                    RAISE EXCEPTION 'Redis balance mutation marker expiry timestamp is not chronological';
                END IF;
                NEW.last_error_class := NULL;
            END IF;
            RETURN NEW;
        END IF;

        IF NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
            OR NEW.last_error_class IS DISTINCT FROM OLD.last_error_class
        THEN
            RAISE EXCEPTION 'terminal Redis balance mutation is immutable';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.state = 'pending' AND NEW.state = 'applied' THEN
        IF NEW.applied_at IS NOT NULL
            OR NEW.marker_expiry_set_at IS NOT NULL
            OR NEW.manual_reviewed_at IS NOT NULL
        THEN
            RAISE EXCEPTION 'pending-to-applied Redis balance mutation has impossible timestamps';
        END IF;
        NEW.applied_at := clock_timestamp();
        IF NEW.applied_at < OLD.created_at THEN
            RAISE EXCEPTION 'pending-to-applied Redis balance mutation is not chronological';
        END IF;
        NEW.last_error_class := NULL;
        RETURN NEW;
    END IF;

    IF OLD.state = 'pending' AND NEW.state = 'manual_review' THEN
        IF NEW.applied_at IS NOT NULL
            OR NEW.marker_expiry_set_at IS NOT NULL
            OR NEW.manual_reviewed_at IS NOT NULL
            OR NEW.last_error_class IS NULL
        THEN
            RAISE EXCEPTION 'pending-to-manual-review Redis balance mutation requires a sanitized error class';
        END IF;
        NEW.manual_reviewed_at := pg_catalog.clock_timestamp();
        IF NEW.manual_reviewed_at < OLD.created_at THEN
            RAISE EXCEPTION 'pending-to-manual-review Redis balance mutation is not chronological';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.state = 'applied'
        AND OLD.marker_expiry_set_at IS NULL
        AND NEW.state = 'manual_review'
    THEN
        IF NEW.applied_at IS DISTINCT FROM OLD.applied_at
            OR NEW.marker_expiry_set_at IS NOT NULL
            OR NEW.manual_reviewed_at IS NOT NULL
            OR NEW.last_error_class IS NULL
        THEN
            RAISE EXCEPTION 'applied-to-manual-review Redis balance mutation requires an unexpired marker conflict';
        END IF;
        NEW.manual_reviewed_at := pg_catalog.clock_timestamp();
        IF NEW.manual_reviewed_at < OLD.applied_at THEN
            RAISE EXCEPTION 'applied-to-manual-review Redis balance mutation is not chronological';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'illegal Redis balance mutation transition: % -> %',
        OLD.state, NEW.state;
END;
$$;
CREATE OR REPLACE FUNCTION public.require_redis_balance_mutation_outbox_for_ledger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    protocol_generation bigint;
    protocol_mode text;
    current_user_id text;
    current_entry_type text;
    current_amount_micro_usd bigint;
    current_currency text;
    mutation_exists boolean;
BEGIN
    -- Read the transaction's final ledger/account identity when the deferred
    -- trigger fires. If a row was inserted and deleted within one transaction,
    -- no durable cache-changing ledger remains and no outbox is required.
    SELECT account.user_id,
        ledger.entry_type,
        ledger.amount_micro_usd,
        ledger.currency
    INTO current_user_id,
        current_entry_type,
        current_amount_micro_usd,
        current_currency
    FROM public.credit_ledger_entries AS ledger
    JOIN public.credit_accounts AS account
      ON account.id = ledger.credit_account_id
    WHERE ledger.id = NEW.id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.redis_balance_mutations AS mutation
        WHERE mutation.ledger_entry_id = NEW.id
    )
    INTO mutation_exists;

    -- Once durable Redis mutation evidence refers to a ledger row, its
    -- cache-changing nominal envelope is audit identity. In particular a
    -- zero-delta refund/dispute mutation does not encode the nominal amount,
    -- so re-validating only against signed_delta_micro_usd is insufficient.
    IF current_entry_type IN ('platform_reserve','platform_release') THEN
        IF NOT EXISTS(SELECT FROM public.redis_balance_mutations m WHERE m.ledger_entry_id=NEW.id AND m.user_id=current_user_id AND m.signed_delta_micro_usd=cloud_platform_billing.check_cash_ledger(NEW.id)) THEN
            RAISE EXCEPTION 'cash ledger missing exact original mutation outbox';
        END IF;
        RETURN NEW;
    END IF;
    IF mutation_exists THEN
        IF TG_OP = 'UPDATE'
            AND (
                NEW.credit_account_id
                    IS DISTINCT FROM OLD.credit_account_id
                OR NEW.entry_type IS DISTINCT FROM OLD.entry_type
                OR NEW.amount_micro_usd
                    IS DISTINCT FROM OLD.amount_micro_usd
                OR NEW.currency IS DISTINCT FROM OLD.currency
            )
        THEN
            RAISE EXCEPTION 'Redis balance mutation ledger envelope is immutable';
        END IF;

        IF current_entry_type NOT IN (
                'purchase', 'refund', 'dispute_lost'
            )
            OR current_currency IS DISTINCT FROM 'USD'
            OR (
                current_entry_type = 'purchase'
                AND current_amount_micro_usd <= 0
            )
            OR (
                current_entry_type IN ('refund', 'dispute_lost')
                AND current_amount_micro_usd >= 0
            )
            OR NOT EXISTS (
                SELECT 1
                FROM public.redis_balance_mutations AS mutation
                WHERE mutation.ledger_entry_id = NEW.id
                  AND mutation.user_id = current_user_id
                  AND (
                        (
                            current_entry_type = 'purchase'
                            AND mutation.signed_delta_micro_usd
                                = current_amount_micro_usd
                        )
                        OR (
                            current_entry_type IN (
                                'refund', 'dispute_lost'
                            )
                            AND mutation.signed_delta_micro_usd <= 0
                        )
                  )
                  AND pg_catalog.abs(
                        mutation.signed_delta_micro_usd::numeric
                      ) <= pg_catalog.abs(
                        current_amount_micro_usd::numeric
                      )
            )
        THEN
            RAISE EXCEPTION 'Redis balance mutation ledger envelope is detached from its exact outbox';
        END IF;
        RETURN NEW;
    END IF;

    SELECT protocol.generation, protocol.mode
    INTO protocol_generation, protocol_mode
    FROM public.redis_balance_protocol_state AS protocol
    WHERE protocol.singleton_id
    -- The cutover changes non-key columns and therefore holds NO KEY UPDATE.
    -- KEY SHARE would not conflict with it; SHARE is the weakest row lock
    -- that actually serializes this deferred commit check with that UPDATE.
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Redis balance protocol singleton is missing';
    END IF;
    IF protocol_generation = 1 AND protocol_mode = 'compatibility' THEN
        RETURN NEW;
    END IF;
    IF protocol_generation <> 2 OR protocol_mode <> 'authoritative' THEN
        RAISE EXCEPTION 'Redis balance protocol singleton has an invalid lifecycle';
    END IF;
    IF current_entry_type NOT IN ('purchase', 'refund', 'dispute_lost') THEN
        RETURN NEW;
    END IF;

    IF current_currency IS DISTINCT FROM 'USD'
        OR (current_entry_type = 'purchase' AND current_amount_micro_usd <= 0)
        OR (
            current_entry_type IN ('refund', 'dispute_lost')
            AND current_amount_micro_usd >= 0
        )
        OR NOT EXISTS (
            SELECT 1
            FROM public.redis_balance_mutations AS mutation
            WHERE mutation.ledger_entry_id = NEW.id
              AND mutation.user_id = current_user_id
              AND (
                    (
                        current_entry_type = 'purchase'
                        AND mutation.signed_delta_micro_usd
                            = current_amount_micro_usd
                    )
                    OR (
                        current_entry_type IN ('refund', 'dispute_lost')
                        AND mutation.signed_delta_micro_usd <= 0
                    )
              )
              AND pg_catalog.abs(
                    mutation.signed_delta_micro_usd::numeric
                  ) <= pg_catalog.abs(current_amount_micro_usd::numeric)
        )
    THEN
        RAISE EXCEPTION 'authoritative cache-changing ledger lacks an exact Redis balance mutation outbox';
    END IF;

    RETURN NEW;
END;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cloud_platform_billing FROM PUBLIC;
UPDATE cloud_platform_billing.schema_version SET version=4;
COMMIT;
