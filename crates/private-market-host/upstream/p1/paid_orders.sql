-- Installed inside the original Market schema transaction, before its catalog
-- fingerprint is sealed. This is an extension of the original money authority,
-- not a second cash balance. Controlled single-seller admission quota only.
CREATE TABLE public.mpp_direct_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), mode text NOT NULL CHECK(mode='controlled'),
 fingerprint text NOT NULL, configuration jsonb NOT NULL
);
CREATE TABLE public.mpp_direct_schema(singleton boolean PRIMARY KEY CHECK(singleton),fingerprint text NOT NULL);
CREATE TABLE public.mpp_direct_agents (
 user_id text PRIMARY KEY REFERENCES public.credit_accounts(user_id), token_hash text UNIQUE NOT NULL,
 agent_id text UNIQUE NOT NULL, payer text NOT NULL UNIQUE, binding_version text NOT NULL,
 active boolean NOT NULL DEFAULT true, native_balance jsonb NOT NULL
);
CREATE TABLE public.mpp_direct_tasks (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES public.mpp_direct_agents,
 budget_nano bigint NOT NULL CHECK(budget_nano>0), reserved_nano bigint NOT NULL DEFAULT 0 CHECK(reserved_nano>=0),
 spent_nano bigint NOT NULL DEFAULT 0 CHECK(spent_nano>=0), hard_bid_nano bigint NOT NULL CHECK(hard_bid_nano>0),
 call_cap_nano bigint NOT NULL CHECK(call_cap_nano>0), deadline_ms bigint NOT NULL,
 revision bigint NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
 CHECK(reserved_nano+spent_nano<=budget_nano)
);
CREATE TABLE public.mpp_direct_orders (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES public.mpp_direct_agents, task_id text NOT NULL REFERENCES public.mpp_direct_tasks,
 logical_key text NOT NULL, body_hash text NOT NULL, original_body text NOT NULL, internal_body jsonb NOT NULL,
 native_id text UNIQUE NOT NULL, dispatch_key text UNIQUE NOT NULL, terms_hash text NOT NULL,
 challenge jsonb NOT NULL, challenge_header text NOT NULL, revision bigint NOT NULL DEFAULT 0,
 task_revision bigint NOT NULL, binding_version text NOT NULL,
 expires_ms bigint NOT NULL, admission_before_ms bigint NOT NULL,
 provider_cap_micro bigint NOT NULL, service_micro bigint NOT NULL CHECK(service_micro>0),
 rate_nano_per_near numeric(39,0) NOT NULL CHECK(rate_nano_per_near>0),
 reserve_nano bigint NOT NULL CHECK(reserve_nano>0), project_estimate_yocto numeric(39,0) NOT NULL CHECK(project_estimate_yocto>0),
 payment_gas numeric(39,0),budget_charged_nano bigint NOT NULL DEFAULT 0,sponsor_operation text UNIQUE NOT NULL,
 expected_purchase jsonb NOT NULL,decision jsonb NOT NULL,
 p numeric(39,0) NOT NULL CHECK(p>0), c numeric(39,0) NOT NULL DEFAULT 0 CHECK(c>=0),
 h numeric(39,0) NOT NULL DEFAULT 0 CHECK(h>=0), w numeric(39,0) NOT NULL DEFAULT 0 CHECK(w>=0),
 r numeric(39,0) NOT NULL DEFAULT 0 CHECK(r>=0), received boolean NOT NULL DEFAULT false,
 escrow_micro bigint NOT NULL DEFAULT 0 CHECK(escrow_micro>=0), credit_ledger text UNIQUE,
 state text NOT NULL DEFAULT 'quoted' CHECK(state IN('quoted','payment_unknown','paid','admitted','refund_due','refunded','cancelled','exception','settled')),
 admitted_request text UNIQUE, financial jsonb, payment_receipt jsonb, created_ms bigint NOT NULL,
 UNIQUE(user_id,logical_key), CHECK((NOT received AND c+h+w+r=0) OR (received AND p=c+h+w+r))
);
CREATE TABLE public.mpp_direct_capacity (
 id integer PRIMARY KEY CHECK(id=1), max_admissions integer NOT NULL CHECK(max_admissions=1),
 admissions integer NOT NULL DEFAULT 0 CHECK(admissions BETWEEN 0 AND 1),
 lease_order text UNIQUE REFERENCES public.mpp_direct_orders, lease_until_ms bigint
);
INSERT INTO public.mpp_direct_capacity(id,max_admissions) VALUES(1,1);
CREATE TABLE public.mpp_direct_project_budget(id integer PRIMARY KEY CHECK(id=1),budget_yocto numeric(39,0) NOT NULL CHECK(budget_yocto>0),
 reserved_yocto numeric(39,0) NOT NULL DEFAULT 0 CHECK(reserved_yocto>=0),spent_yocto numeric(39,0) NOT NULL DEFAULT 0 CHECK(spent_yocto>=0),active boolean NOT NULL DEFAULT true);
CREATE TABLE public.mpp_direct_sponsor_operations(id text PRIMARY KEY,order_id text NOT NULL REFERENCES public.mpp_direct_orders,
 kind text NOT NULL CHECK(kind IN('payment','refund')),fee_payer text NOT NULL,estimate_yocto numeric(39,0) NOT NULL CHECK(estimate_yocto>0),
 actual_yocto numeric(39,0),state text NOT NULL CHECK(state IN('authorized','unknown','final','never_sent')),evidence jsonb,UNIQUE(order_id,kind));
CREATE TABLE public.mpp_direct_presentations (
 order_id text NOT NULL REFERENCES public.mpp_direct_orders, credential_hash text NOT NULL,
 credential text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(order_id,credential_hash)
);
CREATE TABLE public.mpp_direct_timing(order_id text NOT NULL REFERENCES public.mpp_direct_orders,stage text NOT NULL,
 at_ms bigint NOT NULL DEFAULT floor(extract(epoch FROM clock_timestamp())*1000),clock_source text NOT NULL DEFAULT 'postgres_wall_clock',PRIMARY KEY(order_id,stage));
-- One consumption namespace for BOTH purchase and refund directions.
CREATE TABLE public.mpp_direct_movements (
 identity text PRIMARY KEY, order_id text NOT NULL REFERENCES public.mpp_direct_orders,
 purpose text NOT NULL CHECK(purpose IN('payment','refund','anomaly')), operation_id text UNIQUE NOT NULL,
 proof jsonb NOT NULL, UNIQUE(order_id,purpose)
);
CREATE TABLE public.mpp_direct_refunds (
 id text PRIMARY KEY, order_id text UNIQUE NOT NULL REFERENCES public.mpp_direct_orders,
 plan jsonb NOT NULL, plan_hash text NOT NULL, state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','unknown','confirmed')),
 original_send jsonb, movement text UNIQUE, cash_ledger text UNIQUE,last_error text
);
CREATE TABLE public.mpp_direct_anomalies (
 identity text PRIMARY KEY, order_id text NOT NULL REFERENCES public.mpp_direct_orders,
 reason text NOT NULL, evidence jsonb NOT NULL,amount numeric(39,0) NOT NULL,refunded boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Persisted fair rotation: completed/blocked old entries cannot monopolize a
-- bounded worker batch. Attempts advance before network operations begin.
CREATE TABLE public.mpp_direct_recovery_attempts(order_id text NOT NULL REFERENCES public.mpp_direct_orders,
 kind text NOT NULL CHECK(kind IN('payment','refund')),attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(order_id,kind));
CREATE FUNCTION public.mpp_direct_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'MPP direct evidence is immutable'; END $$;
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_movements FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_presentations FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_configuration FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_schema FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_timing FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE FUNCTION public.mpp_direct_binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(OLD)-ARRAY['revision','c','h','w','r','received','escrow_micro','credit_ledger','state','admitted_request','financial','payment_receipt','payment_gas','budget_charged_nano'])
  IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['revision','c','h','w','r','received','escrow_micro','credit_ledger','state','admitted_request','financial','payment_receipt','payment_gas','budget_charged_nano'])
  OR (OLD.admitted_request IS NOT NULL AND NEW.admitted_request IS DISTINCT FROM OLD.admitted_request)
  OR (OLD.financial IS NOT NULL AND NEW.financial IS DISTINCT FROM OLD.financial)
 THEN RAISE EXCEPTION 'MPP original order binding is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_binding BEFORE UPDATE OR DELETE ON public.mpp_direct_orders FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_binding_guard();

-- This trigger runs in the SAME original cash-reserve / kernel / outbox commit.
-- It binds the retained native bytes and controls before any submit can exist.
CREATE FUNCTION public.mpp_direct_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o public.mpp_direct_orders; t public.mpp_direct_tasks; a public.mpp_direct_agents;
 cap public.mpp_direct_capacity; hold public.market_inference_cash; body jsonb; ms bigint;
BEGIN
 SELECT * INTO o FROM public.mpp_direct_orders WHERE native_id=NEW.request_id FOR UPDATE;
 IF NOT FOUND OR o.user_id<>NEW.user_id OR o.dispatch_key<>NEW.idempotency_key OR o.state<>'paid' THEN
  RAISE EXCEPTION 'original paid order required'; END IF;
 SELECT * INTO STRICT a FROM public.mpp_direct_agents WHERE user_id=NEW.user_id FOR SHARE;
 SELECT * INTO STRICT t FROM public.mpp_direct_tasks WHERE id=o.task_id FOR UPDATE;
 SELECT * INTO STRICT cap FROM public.mpp_direct_capacity WHERE id=1 FOR UPDATE;
 SELECT * INTO STRICT hold FROM public.market_inference_cash WHERE request_id=NEW.request_id;
 ms:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
 body:=convert_from(NEW.state,'UTF8')::jsonb;
 IF NOT a.active OR NOT t.active OR t.user_id<>o.user_id OR t.revision<>o.task_revision
  OR a.binding_version<>o.binding_version OR ms>=t.deadline_ms OR ms>=o.admission_before_ms
  OR cap.lease_order IS DISTINCT FROM o.id OR ms>=cap.lease_until_ms OR cap.admissions>=cap.max_admissions
  OR hold.cap_micro_usd<>o.service_micro
  OR body->'original'->'body' IS DISTINCT FROM o.internal_body
  OR body->'original'->'purchase' IS DISTINCT FROM o.expected_purchase
  OR NOT EXISTS(SELECT FROM public.redis_balance_mutations WHERE ledger_entry_id=o.credit_ledger AND state='applied')
 THEN RAISE EXCEPTION 'paid admission fence failed'; END IF;
 UPDATE public.mpp_direct_orders SET state='admitted',admitted_request=NEW.request_id,escrow_micro=0 WHERE id=o.id;
 UPDATE public.mpp_direct_capacity SET admissions=admissions+1 WHERE id=1;
 INSERT INTO public.mpp_direct_timing(order_id,stage) VALUES(o.id,'admission_committed') ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_admission AFTER INSERT ON public.market_inference_requests FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_admission();

-- Every debit path must leave other orders' earmarked money untouched. Deferred
-- to let the original reserve and its immutable request commit as one unit.
CREATE FUNCTION public.mpp_direct_check_purpose() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE u text; bal numeric; protected numeric;
BEGIN
 u:=CASE WHEN TG_TABLE_NAME='credit_accounts' THEN NEW.user_id ELSE NEW.user_id END;
 SELECT balance_micro_usd INTO STRICT bal FROM public.credit_accounts WHERE user_id=u AND currency='USD';
 SELECT coalesce(sum(escrow_micro),0) INTO protected FROM public.mpp_direct_orders WHERE user_id=u;
 IF bal<protected THEN RAISE EXCEPTION 'order-purpose funds are not general cash'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER mpp_direct_credit_purpose AFTER UPDATE ON public.credit_accounts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_check_purpose();
CREATE CONSTRAINT TRIGGER mpp_direct_order_purpose AFTER INSERT OR UPDATE ON public.mpp_direct_orders
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_check_purpose();

-- Derive principal settlement ONLY from the original cash receipt. Release is
-- earmarked for native refund, never available to fund another purchase.
CREATE FUNCTION public.mpp_direct_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o public.mpp_direct_orders; charged numeric; charged_nano bigint;
BEGIN
 IF NEW.receipt IS NULL OR OLD.receipt IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT o FROM public.mpp_direct_orders WHERE admitted_request=NEW.request_id FOR UPDATE;
 charged:=div((NEW.receipt->>'cash_micro_usd')::numeric*1000*1000000000000000000000000+o.rate_nano_per_near-1,o.rate_nano_per_near);
 charged_nano:=div(charged*o.rate_nano_per_near+1000000000000000000000000-1,1000000000000000000000000)::bigint;
 IF charged<0 OR charged>o.p THEN RAISE EXCEPTION 'native charge exceeds original principal'; END IF;
 UPDATE public.mpp_direct_orders SET c=charged,h=0,w=p-charged,
  escrow_micro=NEW.cap_micro_usd-(NEW.receipt->>'cash_micro_usd')::bigint,
  financial=NEW.receipt,budget_charged_nano=charged_nano,state=CASE WHEN p>charged THEN 'refund_due' ELSE 'settled' END WHERE id=o.id;
 UPDATE public.mpp_direct_tasks SET reserved_nano=reserved_nano-charged_nano,spent_nano=spent_nano+charged_nano WHERE id=o.task_id;
 UPDATE public.mpp_direct_capacity SET lease_order=NULL,lease_until_ms=NULL WHERE lease_order=o.id;
 INSERT INTO public.mpp_direct_timing(order_id,stage) VALUES(o.id,'financial_committed') ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_settlement AFTER UPDATE ON public.market_inference_cash FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_settlement();
