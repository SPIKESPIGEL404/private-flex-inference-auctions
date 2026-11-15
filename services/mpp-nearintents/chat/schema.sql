CREATE TABLE chat_configuration(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), fingerprint text NOT NULL, configuration jsonb NOT NULL,
 provider_reserved numeric(39,0) NOT NULL DEFAULT 0 CHECK(provider_reserved>=0), calls integer NOT NULL DEFAULT 0 CHECK(calls>=0));
-- The SDK store is scoped to this dedicated authority. Quote pointers are
-- partitioned per call; deposit/hash replay keys remain global across agents.
CREATE TABLE mpp_nearintents_store(key text PRIMARY KEY,value jsonb NOT NULL);
CREATE TABLE chat_calls(id text PRIMARY KEY,agent_id text NOT NULL,logical_key text NOT NULL,request_hash text NOT NULL,body text NOT NULL,
 terms jsonb NOT NULL,challenge jsonb NOT NULL,challenge_header text NOT NULL,deposit_key text NOT NULL UNIQUE,expires_ms bigint NOT NULL,
 state text NOT NULL DEFAULT 'offered' CHECK(state IN('offered','paid','executing','complete','failed','unknown')),
 credential text,payment_key text UNIQUE,receipt jsonb,claim text UNIQUE,response text,response_type text,usage jsonb,last_error text,
 refund_due numeric(39,0) NOT NULL DEFAULT 0 CHECK(refund_due>=0),created_ms bigint NOT NULL,
 UNIQUE(agent_id,logical_key),CHECK((payment_key IS NULL)=(receipt IS NULL)),
 CHECK(state NOT IN('paid','executing','complete','failed','unknown') OR receipt IS NOT NULL),
 CHECK(state<>'complete' OR (response IS NOT NULL AND response_type IS NOT NULL)));
CREATE TABLE chat_payment_attempts(call_id text NOT NULL REFERENCES chat_calls,credential_hash text NOT NULL,credential text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(call_id,credential_hash));
CREATE TABLE chat_events(sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,call_id text REFERENCES chat_calls,kind text NOT NULL,value jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION chat_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable chat payment evidence'; END $$;
CREATE TRIGGER chat_immutable BEFORE UPDATE OR DELETE ON chat_payment_attempts FOR EACH ROW EXECUTE FUNCTION chat_immutable();
CREATE TRIGGER chat_immutable BEFORE UPDATE OR DELETE ON chat_events FOR EACH ROW EXECUTE FUNCTION chat_immutable();
CREATE FUNCTION chat_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(OLD)-ARRAY['state','credential','payment_key','receipt','claim','response','response_type','usage','last_error','refund_due'])
 IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','credential','payment_key','receipt','claim','response','response_type','usage','last_error','refund_due'])
 OR (OLD.credential IS NOT NULL AND NEW.credential IS DISTINCT FROM OLD.credential)
 OR (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt)
 OR (OLD.claim IS NOT NULL AND NEW.claim IS DISTINCT FROM OLD.claim)
 OR (OLD.response IS NOT NULL AND NEW.response IS DISTINCT FROM OLD.response)
 THEN RAISE EXCEPTION 'original request, payment and result are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER chat_binding BEFORE UPDATE OR DELETE ON chat_calls FOR EACH ROW EXECUTE FUNCTION chat_binding();
