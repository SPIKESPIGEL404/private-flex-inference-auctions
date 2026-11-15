-- Optional native-auction authority, installed inside the owning Market schema
-- transaction and included in its financial fingerprint. No task sessions.
-- Enable only on a fresh controlled market: legacy procurement is fenced below.
DO $$ BEGIN
 IF EXISTS(SELECT FROM public.mpp_direct_orders) THEN RAISE EXCEPTION 'auction enable requires no legacy order liability';END IF;
END $$;
CREATE TABLE public.mpp_direct_auction_state(singleton boolean PRIMARY KEY CHECK(singleton),configuration jsonb NOT NULL,
 next_cutoff_ms bigint NOT NULL,sequence bigint NOT NULL DEFAULT 0,capacity_allocation text);
CREATE TABLE public.mpp_direct_auction_budgets(id text PRIMARY KEY,kind text NOT NULL CHECK(kind IN('owner','agent','task')),
 owner_id text NOT NULL,agent_id text,cap_nano bigint NOT NULL CHECK(cap_nano>0),reserved_nano bigint NOT NULL DEFAULT 0 CHECK(reserved_nano>=0),
 spent_nano bigint NOT NULL DEFAULT 0 CHECK(spent_nano>=0),overrun_nano bigint NOT NULL DEFAULT 0 CHECK(overrun_nano>=0),revision bigint NOT NULL DEFAULT 0,active boolean NOT NULL DEFAULT true,
 deadline_ms bigint NOT NULL,CHECK(reserved_nano+spent_nano<=cap_nano+overrun_nano));
CREATE TABLE public.mpp_direct_auction_agents(id text PRIMARY KEY,owner_id text NOT NULL,credential_hash text UNIQUE NOT NULL,
 payer text UNIQUE NOT NULL,binding_version text NOT NULL,owner_budget text NOT NULL REFERENCES public.mpp_direct_auction_budgets,
 agent_budget text NOT NULL REFERENCES public.mpp_direct_auction_budgets,balance jsonb NOT NULL,
 active boolean NOT NULL DEFAULT true,native_reserved numeric(39,0) NOT NULL DEFAULT 0 CHECK(native_reserved>=0));
CREATE TABLE public.mpp_direct_auction_grants(id text PRIMARY KEY,agent_id text NOT NULL REFERENCES public.mpp_direct_auction_agents,
 task_budget text NOT NULL UNIQUE REFERENCES public.mpp_direct_auction_budgets,call_cap_micro bigint NOT NULL CHECK(call_cap_micro>0),
 gas_cap_yocto numeric(39,0) NOT NULL CHECK(gas_cap_yocto>=0),deadline_ms bigint NOT NULL,revision bigint NOT NULL DEFAULT 0,active boolean NOT NULL DEFAULT true);
CREATE TABLE public.mpp_direct_auction_bids(id text PRIMARY KEY,agent_id text NOT NULL REFERENCES public.mpp_direct_auction_agents,
 grant_id text NOT NULL REFERENCES public.mpp_direct_auction_grants,logical_call text NOT NULL,request_hash text NOT NULL,body text NOT NULL,
 service_version text NOT NULL,bid_multiplier bigint NOT NULL CHECK(bid_multiplier>0),max_total_micro bigint NOT NULL CHECK(max_total_micro>0),
 expiry_ms bigint NOT NULL,revision bigint NOT NULL DEFAULT 0,accepted_sequence bigint NOT NULL UNIQUE,accepted_ms bigint NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN('active','withdrawn','expired','allocated')),UNIQUE(agent_id,logical_call));
CREATE TABLE public.mpp_direct_auction_commands(agent_id text NOT NULL,operation text NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(agent_id,operation));
CREATE TABLE public.mpp_direct_auction_revisions(bid_id text NOT NULL REFERENCES public.mpp_direct_auction_bids,
 revision bigint NOT NULL,value jsonb NOT NULL,PRIMARY KEY(bid_id,revision));
CREATE TABLE public.mpp_direct_auction_rounds(id text PRIMARY KEY,cutoff_ms bigint NOT NULL UNIQUE,cleared_ms bigint NOT NULL,
 inputs jsonb NOT NULL,result jsonb NOT NULL,digest text NOT NULL);
CREATE TABLE public.mpp_direct_auction_allocations(id text PRIMARY KEY,round_id text NOT NULL REFERENCES public.mpp_direct_auction_rounds,
 bid_id text NOT NULL UNIQUE REFERENCES public.mpp_direct_auction_bids,bid_revision bigint NOT NULL,agent_id text NOT NULL REFERENCES public.mpp_direct_auction_agents,
 grant_id text NOT NULL REFERENCES public.mpp_direct_auction_grants,grant_revision bigint NOT NULL,contract jsonb NOT NULL,challenge jsonb NOT NULL,
 order_id text NOT NULL UNIQUE,execution_id text NOT NULL UNIQUE,payment_operation text NOT NULL UNIQUE,refund_operation text NOT NULL UNIQUE,
 execution text NOT NULL DEFAULT 'reserved' CHECK(execution IN('reserved','ready','executing','result_available','failed','unknown','fenced')),
 payment text NOT NULL DEFAULT 'not_started' CHECK(payment IN('not_started','pending','confirmed','unknown','proven_not_sent')),
 settlement text NOT NULL DEFAULT 'usage_pending' CHECK(settlement IN('usage_pending','settled','refund_pending','refund_confirmed','unknown')),
 generation bigint NOT NULL DEFAULT 0,dispatch_claim text UNIQUE,result jsonb,usage jsonb,financial jsonb,
 principal numeric(39,0) NOT NULL CHECK(principal>0),charged numeric(39,0) NOT NULL DEFAULT 0 CHECK(charged>=0),
 refundable numeric(39,0) NOT NULL DEFAULT 0 CHECK(refundable>=0),refunded numeric(39,0) NOT NULL DEFAULT 0 CHECK(refunded>=0),
 gas_actual numeric(39,0),reserve_nano bigint NOT NULL CHECK(reserve_nano>0),budget_finalized boolean NOT NULL DEFAULT false,wallet_reflected boolean NOT NULL DEFAULT false,
 CHECK(charged+refundable+refunded<=principal));
ALTER TABLE public.mpp_direct_auction_state ADD CONSTRAINT auction_capacity_allocation_fk FOREIGN KEY(capacity_allocation) REFERENCES public.mpp_direct_auction_allocations;
CREATE TABLE public.mpp_direct_auction_operations(id text PRIMARY KEY,allocation_id text NOT NULL REFERENCES public.mpp_direct_auction_allocations,
 kind text NOT NULL CHECK(kind IN('payment','execute','refund')),state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','started','unknown','confirmed','proven_not_sent')),
 binding jsonb NOT NULL,result jsonb,UNIQUE(allocation_id,kind));
CREATE TABLE public.mpp_direct_auction_movements(identity text PRIMARY KEY,allocation_id text NOT NULL REFERENCES public.mpp_direct_auction_allocations,
 kind text NOT NULL CHECK(kind IN('payment','refund')),evidence jsonb NOT NULL,UNIQUE(allocation_id,kind));
CREATE TABLE public.mpp_direct_auction_presentations(allocation_id text NOT NULL REFERENCES public.mpp_direct_auction_allocations,
 fingerprint text NOT NULL,credential text NOT NULL,PRIMARY KEY(allocation_id,fingerprint));
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_presentations FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TABLE public.mpp_direct_auction_events(sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 allocation_id text,kind text NOT NULL,at_ms bigint NOT NULL,value jsonb NOT NULL);
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_rounds FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_revisions FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_commands FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_movements FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_events FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE FUNCTION public.mpp_direct_auction_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(OLD)-ARRAY['execution','payment','settlement','generation','dispatch_claim','result','usage','financial','charged','refundable','refunded','gas_actual','budget_finalized','wallet_reflected'])
  IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['execution','payment','settlement','generation','dispatch_claim','result','usage','financial','charged','refundable','refunded','gas_actual','budget_finalized','wallet_reflected'])
  OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
  OR (OLD.financial IS NOT NULL AND NEW.financial IS DISTINCT FROM OLD.financial)
 THEN RAISE EXCEPTION 'auction contract and original result are immutable';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_auction_binding BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_allocations FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_auction_binding();
-- A legacy quote cannot compete for this unpartitioned single GPU. Existing
-- kernels also require an original legacy paid order, so direct bypass fails.
CREATE FUNCTION public.mpp_direct_auction_no_legacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'legacy procurement disabled while auction owns the capacity pool';END $$;
CREATE TRIGGER mpp_direct_auction_no_legacy BEFORE INSERT ON public.mpp_direct_orders FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_auction_no_legacy();
CREATE FUNCTION public.mpp_direct_auction_capacity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.lease_order IS NOT NULL OR NEW.admissions<>0 THEN RAISE EXCEPTION 'auction pool cannot be leased through legacy procurement';END IF;RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_auction_capacity_guard BEFORE UPDATE ON public.mpp_direct_capacity FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_auction_capacity_guard();
CREATE FUNCTION public.mpp_direct_auction_actor_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE ignored text[];
BEGIN
 ignored:=CASE TG_TABLE_NAME
  WHEN 'mpp_direct_auction_agents' THEN ARRAY['active','balance','native_reserved']
  WHEN 'mpp_direct_auction_grants' THEN ARRAY['active','revision']
  WHEN 'mpp_direct_auction_budgets' THEN ARRAY['active','revision','cap_nano','reserved_nano','spent_nano','overrun_nano']
  WHEN 'mpp_direct_auction_bids' THEN ARRAY['state','revision','bid_multiplier','accepted_sequence','accepted_ms']
  ELSE ARRAY['state','result'] END;
 IF TG_OP='DELETE' OR (to_jsonb(OLD)-ignored) IS DISTINCT FROM (to_jsonb(NEW)-ignored)
 THEN RAISE EXCEPTION 'auction principal and operation binding are immutable';END IF;
 IF TG_TABLE_NAME='mpp_direct_auction_operations' THEN
  IF OLD.state IN('confirmed','proven_not_sent') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'auction finalized operation is immutable';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_auction_actor_binding BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_agents FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_auction_actor_binding();
CREATE TRIGGER mpp_direct_auction_actor_binding BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_grants FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_auction_actor_binding();
CREATE TRIGGER mpp_direct_auction_actor_binding BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_budgets FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_auction_actor_binding();
CREATE TRIGGER mpp_direct_auction_actor_binding BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_bids FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_auction_actor_binding();
CREATE TRIGGER mpp_direct_auction_actor_binding BEFORE UPDATE OR DELETE ON public.mpp_direct_auction_operations FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_auction_actor_binding();
