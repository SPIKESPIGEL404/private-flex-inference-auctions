-- Bounded Mainnet effect journals. Auction tables remain the only cash/liability
-- authority. Fresh opt-in databases only; never adopt legacy paid-order state.
CREATE TABLE public.mpp_direct_live_plan(singleton boolean PRIMARY KEY CHECK(singleton),plan jsonb NOT NULL);
CREATE TRIGGER mpp_direct_live_plan_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_live_plan FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TABLE public.mpp_direct_p3_wallets(
 id text PRIMARY KEY,owner_id text NOT NULL,user_id text CHECK(user_id IS NULL),request_hash text NOT NULL,
 state text NOT NULL,binding jsonb,policy jsonb,policy_send jsonb,created_ms bigint NOT NULL,last_error text,UNIQUE(owner_id,id));
CREATE TABLE public.mpp_direct_live_wallet_agents(wallet_id text PRIMARY KEY REFERENCES public.mpp_direct_p3_wallets,
 agent_id text NOT NULL UNIQUE REFERENCES public.mpp_direct_auction_agents);
CREATE TABLE public.mpp_direct_p3_operations(
 id text PRIMARY KEY,order_ref text NOT NULL REFERENCES public.mpp_direct_auction_allocations(order_id),
 kind text NOT NULL CHECK(kind IN('payment','refund')),user_id text NOT NULL REFERENCES public.mpp_direct_auction_agents,
 task_id text NOT NULL REFERENCES public.mpp_direct_auction_budgets,payer text NOT NULL,frozen jsonb NOT NULL,
 fingerprint text NOT NULL,state text NOT NULL,request_id uuid,tx_hash text,actual_gas_yocto numeric(39,0),document jsonb NOT NULL,UNIQUE(order_ref,kind));
CREATE UNIQUE INDEX mpp_direct_live_one_unknown_sender ON public.mpp_direct_p3_operations(payer) WHERE state IN('sending','unknown','review');
CREATE FUNCTION public.mpp_direct_live_effect_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.id<>NEW.id OR OLD.frozen IS DISTINCT FROM NEW.frozen OR OLD.fingerprint<>NEW.fingerprint
 OR OLD.payer<>NEW.payer OR OLD.kind<>NEW.kind OR OLD.user_id<>NEW.user_id OR OLD.task_id<>NEW.task_id OR OLD.order_ref<>NEW.order_ref
 OR (OLD.request_id IS NOT NULL AND OLD.request_id IS DISTINCT FROM NEW.request_id)
 OR (OLD.tx_hash IS NOT NULL AND OLD.tx_hash IS DISTINCT FROM NEW.tx_hash)
 OR (OLD.actual_gas_yocto IS NOT NULL AND OLD.actual_gas_yocto IS DISTINCT FROM NEW.actual_gas_yocto)
 OR (OLD.state IN('final','cancelled') AND OLD.state<>NEW.state) THEN RAISE EXCEPTION 'original live effect is immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_live_effect_guard BEFORE UPDATE OR DELETE ON public.mpp_direct_p3_operations FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_live_effect_guard();
CREATE TABLE public.mpp_direct_live_provider_budget(singleton boolean PRIMARY KEY CHECK(singleton),maximum_micro bigint NOT NULL,
 maximum_calls integer NOT NULL,reserved_micro bigint NOT NULL DEFAULT 0,spent_micro bigint NOT NULL DEFAULT 0,calls integer NOT NULL DEFAULT 0,
 CHECK(reserved_micro>=0 AND spent_micro>=0 AND calls<=maximum_calls));
CREATE TABLE public.mpp_direct_live_provider_ops(id text PRIMARY KEY REFERENCES public.mpp_direct_auction_operations,
 body_hash text NOT NULL,maximum_micro bigint NOT NULL,tariff jsonb,state text NOT NULL CHECK(state IN('sending','never_sent','captured','verified')),raw_response text,response_id text,
 verification jsonb,usage jsonb,actual_micro bigint,created_ms bigint NOT NULL);
CREATE TABLE public.mpp_direct_live_fx(id text PRIMARY KEY,observation jsonb NOT NULL,observed_ms bigint NOT NULL,expires_ms bigint NOT NULL);
CREATE TRIGGER mpp_direct_live_fx_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_live_fx FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();

CREATE TABLE public.mpp_direct_live_refund_plans(id text PRIMARY KEY REFERENCES public.mpp_direct_auction_operations,plan jsonb NOT NULL);
CREATE TRIGGER mpp_direct_live_refund_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_live_refund_plans FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TABLE public.mpp_direct_live_funding(id text PRIMARY KEY,wallet_id text NOT NULL REFERENCES public.mpp_direct_p3_wallets,
 owner_id text NOT NULL,amount numeric(39,0) NOT NULL,tx_hash text UNIQUE,state text NOT NULL,created_ms bigint NOT NULL,evidence jsonb);
CREATE UNIQUE INDEX mpp_direct_live_one_unknown_funding ON public.mpp_direct_live_funding(wallet_id) WHERE state='pending';
CREATE TABLE public.mpp_direct_live_supply(singleton boolean PRIMARY KEY CHECK(singleton),ready boolean NOT NULL,observed_ms bigint NOT NULL,expires_ms bigint NOT NULL,evidence jsonb NOT NULL);
CREATE TABLE public.mpp_direct_live_payment_budget(singleton boolean PRIMARY KEY CHECK(singleton),maximum_calls integer NOT NULL,calls integer NOT NULL DEFAULT 0 CHECK(calls>=0 AND calls<=maximum_calls));

CREATE FUNCTION public.mpp_direct_live_provider_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.id<>NEW.id OR OLD.body_hash<>NEW.body_hash OR OLD.maximum_micro<>NEW.maximum_micro
 OR OLD.tariff IS DISTINCT FROM NEW.tariff OR OLD.created_ms<>NEW.created_ms
 OR (OLD.raw_response IS NOT NULL AND OLD.raw_response IS DISTINCT FROM NEW.raw_response)
 OR (OLD.response_id IS NOT NULL AND OLD.response_id IS DISTINCT FROM NEW.response_id)
 OR (OLD.verification IS NOT NULL AND OLD.verification IS DISTINCT FROM NEW.verification)
 OR (OLD.usage IS NOT NULL AND OLD.usage IS DISTINCT FROM NEW.usage)
 OR (OLD.actual_micro IS NOT NULL AND OLD.actual_micro IS DISTINCT FROM NEW.actual_micro)
 OR (OLD.state IN('never_sent','verified') AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW))
 THEN RAISE EXCEPTION 'original provider operation is immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_live_provider_guard BEFORE UPDATE OR DELETE ON public.mpp_direct_live_provider_ops FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_live_provider_guard();
CREATE TABLE public.mpp_direct_live_withdrawals(id text PRIMARY KEY,wallet_id text NOT NULL REFERENCES public.mpp_direct_p3_wallets,
 owner_id text NOT NULL,plan jsonb NOT NULL,policy jsonb,binding jsonb,policy_tx jsonb,
 state text NOT NULL CHECK(state IN('policy','prepared','sending','unknown','review','final','cancelled')),request_id uuid,tx_hash text UNIQUE,evidence jsonb);
CREATE FUNCTION public.mpp_direct_live_withdraw_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.id<>NEW.id OR OLD.wallet_id<>NEW.wallet_id OR OLD.owner_id<>NEW.owner_id OR OLD.plan IS DISTINCT FROM NEW.plan
 OR (OLD.policy IS NOT NULL AND OLD.policy IS DISTINCT FROM NEW.policy)
 OR (OLD.binding IS NOT NULL AND OLD.binding IS DISTINCT FROM NEW.binding)
 OR (OLD.policy_tx IS NOT NULL AND OLD.policy_tx IS DISTINCT FROM NEW.policy_tx)
 OR (OLD.request_id IS NOT NULL AND OLD.request_id IS DISTINCT FROM NEW.request_id)
 OR (OLD.tx_hash IS NOT NULL AND OLD.tx_hash IS DISTINCT FROM NEW.tx_hash)
 OR (OLD.evidence IS NOT NULL AND OLD.evidence IS DISTINCT FROM NEW.evidence)
 OR (OLD.state IN('final','cancelled') AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW))
 THEN RAISE EXCEPTION 'original owner withdrawal is immutable';END IF;RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_live_withdraw_guard BEFORE UPDATE OR DELETE ON public.mpp_direct_live_withdrawals FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_live_withdraw_guard();

CREATE UNIQUE INDEX mpp_direct_live_one_pending_exit ON public.mpp_direct_live_withdrawals(wallet_id) WHERE state NOT IN('final','cancelled');
