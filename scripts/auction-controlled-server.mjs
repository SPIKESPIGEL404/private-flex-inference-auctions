// Called by the isolated PG acceptance wrapper, never a real deployment entry.
import pg from "../services/mpp-near-direct/node_modules/pg/lib/index.js";
import { AuctionMarket } from "../services/mpp-near-direct/auction/market.mjs";
import {
  controlledAdapters,
  seedBrowserFixture,
} from "../services/mpp-near-direct/auction/test/controlled-adapters.mjs";
import { startAuctionServer } from "../services/mpp-near-direct/auction/server.mjs";
import { hash } from "../services/mpp-near-direct/contract.mjs";
if (!process.env.AUCTION_TEST_DATABASE_URL)
  throw Error("isolated_acceptance_database_required");
const pool = new pg.Pool({
  connectionString: process.env.AUCTION_TEST_DATABASE_URL,
});
const { secretHash, ...configuration } = (
  await pool.query("SELECT configuration FROM mpp_direct_auction_state")
).rows[0].configuration;
await seedBrowserFixture(pool);
const now = Date.now();
const market = new AuctionMarket({
  pool,
  config: {
    ...configuration,
    windowMs: 250,
    fx: { ...configuration.fx, observedAtMs: now, expiresAtMs: now + 600000 },
    secret: "controlled-only-secret-for-native-auction",
  },
});
await market.initialize();
const adapters = await controlledAdapters(pool);
await pool.query(
  "TRUNCATE fixture_auction_wallet_accounts,fixture_auction_wallet_ops,fixture_auction_provider_ops",
);
for (const id of ["a.testnet", "b.testnet", "merchant.testnet"])
  await pool.query(
    "INSERT INTO fixture_auction_wallet_accounts VALUES($1,1000000000000000000000000)",
    [id],
  );
const app = await startAuctionServer({
  market,
  ...adapters,
  ownerTokens: [{ tokenHash: hash("controlled-review"), ownerId: "owner-1" }],
  port: 4180,
  uiOrigin: "http://127.0.0.1:4517",
});
console.log(
  JSON.stringify({
    url: app.url,
    scope: "controlled",
    realChainPayments: false,
    realInference: false,
  }),
);
process.once(
  "SIGINT",
  () =>
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0)),
);
