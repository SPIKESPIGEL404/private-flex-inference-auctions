-- Controlled P2 extension; installed before the owning financial schema seal.
ALTER TABLE public.mpp_direct_tasks ADD COLUMN paused boolean NOT NULL DEFAULT false;
ALTER TABLE public.mpp_direct_tasks ADD COLUMN preference text NOT NULL DEFAULT 'balanced' CHECK(preference IN('save','balanced','fast'));
ALTER TABLE public.mpp_direct_tasks ADD COLUMN max_wait_ms bigint NOT NULL DEFAULT 60000 CHECK(max_wait_ms BETWEEN 1 AND 120000);
CREATE TABLE public.mpp_direct_p2_market(singleton boolean PRIMARY KEY CHECK(singleton),available boolean NOT NULL DEFAULT true,
 observed_ms bigint NOT NULL,usable_ms bigint NOT NULL CHECK(usable_ms>0),source text NOT NULL DEFAULT 'controlled-seller-synthetic-p95');
CREATE TABLE public.mpp_direct_p2_agent_limits(user_id text PRIMARY KEY REFERENCES public.mpp_direct_agents,
 budget_nano bigint NOT NULL CHECK(budget_nano>0),reserved_nano bigint NOT NULL DEFAULT 0 CHECK(reserved_nano>=0),
 spent_nano bigint NOT NULL DEFAULT 0 CHECK(spent_nano>=0),CHECK(reserved_nano+spent_nano<=budget_nano));
CREATE TABLE public.mpp_direct_p2_owners(token_hash text PRIMARY KEY,owner_id text NOT NULL);
ALTER TABLE public.mpp_direct_agents ADD COLUMN owner_id text;
CREATE TABLE public.mpp_direct_p2_sessions(id text PRIMARY KEY,user_id text NOT NULL REFERENCES public.mpp_direct_agents,
 task_id text NOT NULL UNIQUE REFERENCES public.mpp_direct_tasks,prompt text NOT NULL,
 state text NOT NULL DEFAULT 'ready' CHECK(state IN('ready','running','paused','complete','error')),
 generation bigint NOT NULL DEFAULT 0,writer_hash text,writer_until_ms bigint NOT NULL DEFAULT 0,
 head bigint NOT NULL DEFAULT 0,workspace_version bigint NOT NULL DEFAULT 0,workspace jsonb NOT NULL DEFAULT '{}'::jsonb,
 result jsonb,fx_started boolean NOT NULL DEFAULT false,model_step bigint NOT NULL DEFAULT 0,created_ms bigint NOT NULL);
CREATE TABLE public.mpp_direct_p2_journal(session_id text NOT NULL REFERENCES public.mpp_direct_p2_sessions,
 cursor bigint NOT NULL,operation text NOT NULL,digest text NOT NULL,data bytea NOT NULL,marks jsonb NOT NULL,
 PRIMARY KEY(session_id,cursor),UNIQUE(session_id,operation));
CREATE TABLE public.mpp_direct_p2_calls(id text PRIMARY KEY,user_id text NOT NULL REFERENCES public.mpp_direct_agents,
 session_id text NOT NULL REFERENCES public.mpp_direct_p2_sessions,task_id text NOT NULL REFERENCES public.mpp_direct_tasks,
 logical_key text NOT NULL,original_body text NOT NULL,body_hash text NOT NULL,started_ms bigint NOT NULL,
 deadline_ms bigint NOT NULL,max_wait_ms bigint NOT NULL,preference text NOT NULL,
 bid_nano bigint NOT NULL CHECK(bid_nano>0),revision bigint NOT NULL DEFAULT 0,manual boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'bidding' CHECK(state IN('bidding','quoted','executing','terminal','cancelled','stopped')),
 order_id text UNIQUE REFERENCES public.mpp_direct_orders,next_tick_ms bigint NOT NULL DEFAULT 0,decision jsonb,progress_version bigint NOT NULL DEFAULT 0,
 UNIQUE(user_id,logical_key),UNIQUE(session_id,body_hash));
ALTER TABLE public.mpp_direct_orders ADD COLUMN call_id text REFERENCES public.mpp_direct_p2_calls;
ALTER TABLE public.mpp_direct_orders ADD COLUMN bid_revision bigint;
CREATE TABLE public.mpp_direct_p2_revisions(call_id text NOT NULL REFERENCES public.mpp_direct_p2_calls,
 revision bigint NOT NULL,actor text NOT NULL,decision jsonb NOT NULL,at_ms bigint NOT NULL,PRIMARY KEY(call_id,revision));
CREATE TABLE public.mpp_direct_p2_operations(user_id text NOT NULL,operation text NOT NULL,resource text NOT NULL,
 digest text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(user_id,operation));
CREATE TABLE public.mpp_direct_p2_tools(session_id text NOT NULL REFERENCES public.mpp_direct_p2_sessions,
 execution_id text NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,workspace_version bigint NOT NULL,
 PRIMARY KEY(session_id,execution_id));
CREATE TABLE public.mpp_direct_p2_responses(call_id text PRIMARY KEY REFERENCES public.mpp_direct_p2_calls,
 body text NOT NULL,headers jsonb NOT NULL,created_ms bigint NOT NULL);
CREATE TABLE public.mpp_direct_p2_decisions(call_id text NOT NULL REFERENCES public.mpp_direct_p2_calls,
 sequence bigint GENERATED ALWAYS AS IDENTITY,revision bigint NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(call_id,sequence));
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_p2_journal FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_p2_tools FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_p2_revisions FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_p2_operations FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_p2_responses FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();
CREATE TRIGGER mpp_direct_keep BEFORE UPDATE OR DELETE ON public.mpp_direct_p2_decisions FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_immutable();

CREATE FUNCTION public.mpp_direct_p2_budget() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE l public.mpp_direct_p2_agent_limits;r bigint;s bigint;
BEGIN
 SELECT * INTO STRICT l FROM public.mpp_direct_p2_agent_limits WHERE user_id=NEW.user_id FOR UPDATE;
 SELECT coalesce(sum(reserved_nano),0),coalesce(sum(spent_nano),0) INTO r,s FROM public.mpp_direct_tasks WHERE user_id=NEW.user_id;
 IF r+s>l.budget_nano THEN RAISE EXCEPTION 'agent aggregate authorization exhausted';END IF;
 UPDATE public.mpp_direct_p2_agent_limits SET reserved_nano=r,spent_nano=s WHERE user_id=NEW.user_id;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_p2_task_budget AFTER INSERT OR UPDATE ON public.mpp_direct_tasks FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_p2_budget();

-- Original admission still runs its full purpose/cash/native fence. These extra
-- checks serialize the buyer's frozen revision with pause/cancel/manual control.
CREATE FUNCTION public.mpp_direct_p2_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o public.mpp_direct_orders;c public.mpp_direct_p2_calls;t public.mpp_direct_tasks;
BEGIN
 SELECT * INTO STRICT o FROM public.mpp_direct_orders WHERE native_id=NEW.request_id FOR UPDATE;
 SELECT * INTO STRICT c FROM public.mpp_direct_p2_calls WHERE id=o.call_id FOR UPDATE;
 SELECT * INTO STRICT t FROM public.mpp_direct_tasks WHERE id=o.task_id FOR SHARE;
 IF t.paused OR c.state<>'quoted' OR c.order_id IS DISTINCT FROM o.id OR c.revision IS DISTINCT FROM o.bid_revision
 THEN RAISE EXCEPTION 'buyer revision or pause fence failed';END IF;
 UPDATE public.mpp_direct_p2_calls SET state='executing' WHERE id=c.id;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_p2_admission BEFORE INSERT ON public.market_inference_requests FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_p2_admission();
CREATE FUNCTION public.mpp_direct_p2_release() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o public.mpp_direct_orders;
BEGIN
 IF NEW.receipt IS NULL OR OLD.receipt IS NOT NULL THEN RETURN NEW;END IF;
 SELECT * INTO STRICT o FROM public.mpp_direct_orders WHERE admitted_request=NEW.request_id;
 -- A settled original execution, never an HTTP disconnect, frees the one
 -- physical slot. The seller retains its per-order execution claim forever.
 UPDATE public.mpp_direct_capacity SET admissions=0 WHERE id=1;
 UPDATE public.mpp_direct_p2_calls SET state='terminal' WHERE id=o.call_id;
 RETURN NEW;
END $$;
CREATE TRIGGER mpp_direct_z_p2_release AFTER UPDATE ON public.market_inference_cash FOR EACH ROW EXECUTE FUNCTION public.mpp_direct_p2_release();
