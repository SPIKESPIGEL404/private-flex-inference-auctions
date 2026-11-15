-- Adapter metadata only. AuctionMarket allocations/movements/budgets remain the
-- only price, capacity and financial authority; no chat_calls or credit ledger.
CREATE TABLE nearintents_auction_configuration(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),fingerprint text NOT NULL,schema_fingerprint text NOT NULL,instance_id text NOT NULL);
CREATE TABLE nearintents_auction_store(key text PRIMARY KEY,value jsonb NOT NULL);
CREATE TABLE nearintents_auction_agents(agent_id text PRIMARY KEY REFERENCES mpp_direct_auction_agents,
 operation text NOT NULL,owner_id text NOT NULL,address text NOT NULL UNIQUE,created_ms bigint NOT NULL,UNIQUE(owner_id,operation));
CREATE TABLE nearintents_auction_credentials(allocation_id text PRIMARY KEY REFERENCES mpp_direct_auction_allocations,
 credential text NOT NULL,created_ms bigint NOT NULL);
CREATE TABLE nearintents_auction_funding(id text PRIMARY KEY,agent_id text NOT NULL REFERENCES mpp_direct_auction_agents,owner_id text NOT NULL,source_address text NOT NULL,
 kind text NOT NULL CHECK(kind IN('token','gas')),amount numeric(39,0) NOT NULL CHECK(amount>0),state text NOT NULL CHECK(state IN('pending','confirmed','failed','cancelled')),
 tx_hash text UNIQUE,evidence jsonb,created_ms bigint NOT NULL);
CREATE FUNCTION nearintents_funding_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(OLD)-ARRAY['state','tx_hash','evidence']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','tx_hash','evidence'])
 OR(OLD.tx_hash IS NOT NULL AND OLD.tx_hash IS DISTINCT FROM NEW.tx_hash) OR(OLD.evidence IS NOT NULL AND OLD.evidence IS DISTINCT FROM NEW.evidence)
 THEN RAISE EXCEPTION 'original source funding is immutable';END IF;RETURN NEW;END $$;
CREATE TRIGGER ni_funding_keep BEFORE UPDATE OR DELETE ON nearintents_auction_funding FOR EACH ROW EXECUTE FUNCTION nearintents_funding_guard();
CREATE TRIGGER ni_configuration_keep BEFORE UPDATE OR DELETE ON nearintents_auction_configuration FOR EACH ROW EXECUTE FUNCTION mpp_direct_immutable();
CREATE TRIGGER ni_agent_keep BEFORE UPDATE OR DELETE ON nearintents_auction_agents FOR EACH ROW EXECUTE FUNCTION mpp_direct_immutable();
CREATE TRIGGER ni_credential_keep BEFORE UPDATE OR DELETE ON nearintents_auction_credentials FOR EACH ROW EXECUTE FUNCTION mpp_direct_immutable();
