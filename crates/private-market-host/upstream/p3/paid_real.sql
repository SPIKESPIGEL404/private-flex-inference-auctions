-- OutLayer P3, installed with the original paid schema before its seal.
-- These are authorization/effect journals, not an additional cash balance.
ALTER TABLE public.mpp_direct_configuration DROP CONSTRAINT mpp_direct_configuration_mode_check;
ALTER TABLE public.mpp_direct_configuration ADD CHECK(mode IN('controlled','bounded','qualification-test'));
CREATE TABLE public.mpp_direct_p3_wallets(
 id text PRIMARY KEY, owner_id text NOT NULL, user_id text UNIQUE REFERENCES public.mpp_direct_agents,
 request_hash text NOT NULL, state text NOT NULL, binding jsonb, policy jsonb, policy_send jsonb,
 created_ms bigint NOT NULL, last_error text, UNIQUE(owner_id,id));
CREATE TABLE public.mpp_direct_p3_operations(
 id text PRIMARY KEY, order_ref text NOT NULL REFERENCES public.mpp_direct_orders,
 kind text NOT NULL CHECK(kind IN('payment','refund')), user_id text NOT NULL REFERENCES public.mpp_direct_agents,
 task_id text NOT NULL REFERENCES public.mpp_direct_tasks, payer text NOT NULL,
 frozen jsonb NOT NULL, fingerprint text NOT NULL, state text NOT NULL,
 request_id uuid, tx_hash text, actual_gas_yocto numeric(39,0), document jsonb NOT NULL,
 UNIQUE(order_ref,kind));
CREATE UNIQUE INDEX mpp_direct_p3_one_unknown_sender ON public.mpp_direct_p3_operations(payer)
 WHERE state IN('sending','unknown','review');
CREATE FUNCTION public.mpp_direct_p3_operation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.id<>NEW.id OR OLD.frozen IS DISTINCT FROM NEW.frozen
 OR OLD.fingerprint<>NEW.fingerprint OR OLD.payer<>NEW.payer OR OLD.kind<>NEW.kind
 OR OLD.user_id<>NEW.user_id OR OLD.task_id<>NEW.task_id OR OLD.order_ref<>NEW.order_ref
 OR (OLD.request_id IS NOT NULL AND OLD.request_id IS DISTINCT FROM NEW.request_id)
 OR (OLD.tx_hash IS NOT NULL AND OLD.tx_hash IS DISTINCT FROM NEW.tx_hash)
 OR (OLD.actual_gas_yocto IS NOT NULL AND OLD.actual_gas_yocto IS DISTINCT FROM NEW.actual_gas_yocto)
 OR (OLD.state IN('final','cancelled') AND OLD.state<>NEW.state)
 THEN RAISE EXCEPTION 'original OutLayer operation is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_p3_operation_guard BEFORE UPDATE OR DELETE ON public.mpp_direct_p3_operations
 FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_p3_operation_guard();
CREATE TABLE public.mpp_direct_p3_runs(id text PRIMARY KEY,plan jsonb NOT NULL,created_ms bigint NOT NULL);
CREATE TRIGGER mpp_direct_p3_run_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_p3_runs
 FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TABLE public.mpp_direct_p3_challenges(id text PRIMARY KEY,kind text NOT NULL,payload jsonb NOT NULL,
 owner_id text,run_id text REFERENCES public.mpp_direct_p3_runs,expires_ms bigint NOT NULL,consumed boolean NOT NULL DEFAULT false);
CREATE TABLE public.mpp_direct_p3_sessions(token_hash text PRIMARY KEY,owner_id text NOT NULL,public_key text NOT NULL,
 expires_ms bigint NOT NULL,active boolean NOT NULL DEFAULT true);
CREATE TABLE public.mpp_direct_p3_grants(run_id text NOT NULL REFERENCES public.mpp_direct_p3_runs,
 owner_id text NOT NULL,role text NOT NULL CHECK(role IN('owner','project')),proof jsonb NOT NULL,
 expires_ms bigint NOT NULL,active boolean NOT NULL DEFAULT true,PRIMARY KEY(run_id,owner_id,role));
CREATE TABLE public.mpp_direct_p3_funding(id text PRIMARY KEY,run_id text NOT NULL REFERENCES public.mpp_direct_p3_runs,
 owner_id text NOT NULL,user_id text NOT NULL REFERENCES public.mpp_direct_agents,request jsonb NOT NULL,
 request_hash text NOT NULL,state text NOT NULL,quote jsonb,deposit_hash text,native_proof jsonb,
 movement text UNIQUE,last_error text,UNIQUE(run_id,user_id));
CREATE TABLE public.mpp_direct_p3_provider_ops(id text PRIMARY KEY,body_hash text NOT NULL,maximum_micro bigint NOT NULL,
 state text NOT NULL,response text,usage jsonb,actual_micro bigint,created_ms bigint NOT NULL);
CREATE TABLE public.mpp_direct_p3_provider_budget(singleton boolean PRIMARY KEY CHECK(singleton),maximum_micro bigint NOT NULL,
 maximum_calls integer NOT NULL,reserved_micro bigint NOT NULL DEFAULT 0,spent_micro bigint NOT NULL DEFAULT 0,calls integer NOT NULL DEFAULT 0,
 CHECK(reserved_micro>=0 AND spent_micro>=0 AND reserved_micro+spent_micro<=maximum_micro AND calls<=maximum_calls));

-- Checks occur in the original admission transaction; API success alone cannot
-- bypass owner authorization or the bounded upstream-call allowance.
CREATE FUNCTION public.mpp_direct_p3_admission_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o public.mpp_direct_orders;owner text;run text;g public.mpp_direct_p3_grants;b public.mpp_direct_p3_provider_budget;
BEGIN
 SELECT * INTO STRICT o FROM public.mpp_direct_orders WHERE native_id=NEW.request_id FOR UPDATE;
 SELECT a.owner_id INTO STRICT owner FROM public.mpp_direct_agents a WHERE a.user_id=o.user_id;
 SELECT r.id INTO STRICT run FROM public.mpp_direct_p3_runs r JOIN public.mpp_direct_configuration c ON c.configuration=r.plan;
 SELECT * INTO g FROM public.mpp_direct_p3_grants WHERE run_id=run AND owner_id=owner AND role='owner';
 IF NOT coalesce(g.active,false) OR g.expires_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
 THEN RAISE EXCEPTION 'current owner run authorization required';END IF;
 SELECT * INTO g FROM public.mpp_direct_p3_grants WHERE run_id=run AND owner_id=(SELECT plan->>'projectAccount' FROM public.mpp_direct_p3_runs WHERE id=run) AND role='project';
 IF NOT coalesce(g.active,false) OR g.expires_ms<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint
 THEN RAISE EXCEPTION 'current project upstream authorization required';END IF;
 SELECT * INTO STRICT b FROM public.mpp_direct_p3_provider_budget WHERE singleton FOR UPDATE;
 IF b.calls>=b.maximum_calls OR b.reserved_micro+b.spent_micro+o.service_micro>b.maximum_micro
 THEN RAISE EXCEPTION 'bounded provider allowance exhausted';END IF;
 INSERT INTO public.mpp_direct_p3_provider_ops VALUES(o.id,o.body_hash,o.service_micro,'sending',NULL,NULL,NULL,
 floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
 UPDATE public.mpp_direct_p3_provider_budget SET calls=calls+1,reserved_micro=reserved_micro+o.service_micro WHERE singleton;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_ab_p3_admission BEFORE INSERT ON public.market_inference_requests
 FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_p3_admission_guard();
CREATE FUNCTION public.mpp_direct_p3_provider_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o public.mpp_direct_orders;p public.mpp_direct_p3_provider_ops;actual bigint;
BEGIN
 IF NEW.receipt IS NULL OR OLD.receipt IS NOT NULL THEN RETURN NEW;END IF;
 SELECT * INTO STRICT o FROM public.mpp_direct_orders WHERE admitted_request=NEW.request_id;
 SELECT * INTO STRICT p FROM public.mpp_direct_p3_provider_ops WHERE id=o.id FOR UPDATE;
 actual:=(NEW.receipt->>'cash_micro_usd')::bigint;
 IF actual<0 OR actual>p.maximum_micro THEN RAISE EXCEPTION 'provider spend exceeds original reservation';END IF;
 UPDATE public.mpp_direct_p3_provider_ops SET state='final',actual_micro=actual,usage=NEW.receipt WHERE id=o.id;
 UPDATE public.mpp_direct_p3_provider_budget SET reserved_micro=reserved_micro-p.maximum_micro,spent_micro=spent_micro+actual WHERE singleton;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_y_p3_provider_settlement AFTER UPDATE ON public.market_inference_cash
 FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_p3_provider_settlement();
CREATE TABLE public.mpp_direct_p3_profiles(id text PRIMARY KEY,body_hash text NOT NULL,registration jsonb NOT NULL,
 state text NOT NULL CHECK(state IN('queued','registering','registered','calibrating','unknown','qualified')),
 directory text NOT NULL,quote jsonb,measurement jsonb,created_ms bigint NOT NULL,last_error text);
ALTER TABLE public.mpp_direct_p3_profiles ADD COLUMN slot bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE public.mpp_direct_p3_profiles ADD COLUMN call_id text NOT NULL REFERENCES public.mpp_direct_p2_calls;
CREATE TABLE public.mpp_direct_p3_native_slot(singleton boolean PRIMARY KEY CHECK(singleton),profile_id text REFERENCES public.mpp_direct_p3_profiles);
INSERT INTO public.mpp_direct_p3_native_slot VALUES(true,NULL);
