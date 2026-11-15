import http from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { digest } from "../chat/config.mjs";
import { chatPool, startChatServer } from "../chat/server.mjs";
import { httpProvider } from "../chat/provider.mjs";
import { FileJournal } from "../chat/journal.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ORIGIN =
  "eip155:42161/erc20:0x1111111111111111111111111111111111111111";
export const DESTINATION = "near:mainnet/nep141:usdc.test.near";
export const REFUND = "0x2222222222222222222222222222222222222222";
export const TOKEN = "test-agent-token-".repeat(4);
export const BODY = JSON.stringify({
  model: "test/qwen",
  messages: [{ role: "user", content: "2 + 3?" }],
  max_tokens: 128,
});
export const jsonResult = (body) =>
  JSON.stringify({
    id: "completion-original",
    model: body.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "5" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  });
export function config(url, provider) {
  return {
    mode: "controlled",
    schema: "chat_test_" + randomUUID().replaceAll("-", ""),
    realm: "paid-chat-test",
    billing: "fixed-request-v1",
    destinationAsset: DESTINATION,
    destinationRecipient: "merchant.test.near",
    oneClickBaseUrl: url,
    expiresWindow: 300,
    settlementTimeout: 1,
    pollInterval: 5,
    providerTimeoutMs: 1000,
    maximumCalls: 20,
    maximumOpenQuotes: 4,
    maximumProviderMicro: "20000",
    deadlineMs: Date.now() + 600000,
    agents: [
      {
        id: "agent-a",
        tokenHash: digest(TOKEN),
        originAsset: ORIGIN,
        refundTo: REFUND,
        maximumAmountIn: "2000",
        maximumTotalAmountIn: "20000",
      },
    ],
    offers: [
      {
        model: "test/qwen",
        version: "offer-v1",
        amountOut: "1000",
        providerReserveMicro: "100",
        maxInputTokens: 32000,
        maxOutputTokens: 512,
      },
    ],
    provider: { kind: "openai-http-v1", url: provider },
  };
}
export const policy = () => ({
  allowedOriginNetworks: ["eip155:42161"],
  allowedCurrencies: [ORIGIN],
  maxAmountIn: { [ORIGIN]: "2000" },
  expectedDestination: {
    destinationAsset: DESTINATION,
    destinationRecipient: "merchant.test.near",
  },
  expectedRefundTo: REFUND,
  maximumAmountOut: "1000",
  maximumTotalAmountIn: "20000",
  maximumSettlementSeconds: 60,
});
export async function fixture(
  t,
  {
    change = () => {},
    fault,
    providerReply,
    quoteTimeEstimate = 0,
    quoteAmountIn,
  } = {},
) {
  const quotes = new Map(),
    counters = { quotes: 0, deposits: 0, inference: 0, submit: 0 };
  let providerStatus = 200,
    swapStatus = "SUCCESS",
    providerDelay = 0;
  const server = http.createServer(async (req, res) => {
    let value;
    if (req.method === "POST") {
      const chunks = [];
      for await (const part of req) chunks.push(part);
      value = JSON.parse(Buffer.concat(chunks).toString());
    }
    const send = (status, value, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof value === "string" ? value : JSON.stringify(value));
    };
    const url = new URL(req.url, "http://fixture");
    if (url.pathname === "/v0/tokens")
      return send(200, [
        {
          assetId: "origin-usdc",
          blockchain: "arb",
          decimals: 6,
          symbol: "USDC",
          contractAddress: "0x1111111111111111111111111111111111111111",
        },
        {
          assetId: "destination-usdc",
          blockchain: "near",
          decimals: 6,
          symbol: "USDC",
          contractAddress: "usdc.test.near",
        },
        {
          assetId: "wrapped-near",
          blockchain: "near",
          decimals: 24,
          symbol: "wNEAR",
          contractAddress: "wrap.near",
        },
      ]);
    if (url.pathname === "/v0/quote") {
      const address = "0x" + String(++counters.quotes).padStart(40, "0");
      const quote = {
        depositAddress: address,
        amountIn: quoteAmountIn ?? String(BigInt(value.amount) + 100n),
        minAmountIn: quoteAmountIn
          ? String(BigInt(quoteAmountIn) - 1n)
          : String(BigInt(value.amount) + 99n),
        deadline: value.deadline,
        timeEstimate: quoteTimeEstimate,
      };
      quotes.set(address, { quote, request: value, sourceHash: null });
      return send(200, { quote, quoteRequest: value });
    }
    if (url.pathname === "/v0/deposit/submit") {
      counters.submit++;
      return send(200, {});
    }
    if (url.pathname === "/v0/status") {
      const q = quotes.get(url.searchParams.get("depositAddress"));
      return send(
        200,
        q?.sourceHash
          ? {
              status: swapStatus,
              swapDetails: {
                originChainTxHashes: [{ hash: q.sourceHash }],
                destinationChainTxHashes: [
                  { hash: "destination-" + q.quote.depositAddress.slice(-8) },
                ],
              },
            }
          : { status: "PENDING_DEPOSIT" },
      );
    }
    if (url.pathname === "/v1/chat/completions") {
      counters.inference++;
      if (providerDelay) await new Promise((r) => setTimeout(r, providerDelay));
      if (providerStatus !== 200)
        return send(providerStatus, { error: "controlled_failure" });
      if (providerReply) {
        const reply = providerReply(value, counters.inference);
        return send(200, reply.raw, reply.contentType);
      }
      if (value.stream) {
        const usage = {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 11,
        };
        const chunk = {
          id: "completion-original",
          model: value.model,
          choices: [
            { index: 0, delta: { content: "5" }, finish_reason: "stop" },
          ],
          usage,
        };
        return send(
          200,
          "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n",
          "text/event-stream",
        );
      }
      return send(200, jsonResult(value));
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cfg = config(base, base + "/v1/chat/completions");
  change(cfg);
  const databaseUrl = process.env.CHAT_TEST_DATABASE_URL;
  const pool = await chatPool(databaseUrl, cfg.schema);
  const secret = "test-payment-secret-".repeat(3);
  const provider = httpProvider({ config: cfg });
  let app = await startChatServer({
    pool,
    config: cfg,
    secret,
    provider,
    fault,
  });
  const directory = await mkdtemp(join(tmpdir(), "paid-chat-test-"));
  const journal = new FileJournal(directory);
  await journal.initialize();
  const effects = new Map();
  const payer = {
    durableOriginalOperations: true,
    async payOriginal({ operationId, request }) {
      let hash = effects.get(operationId);
      if (!hash) {
        hash = "0x" + String(++counters.deposits).padStart(64, "0");
        effects.set(operationId, hash);
        quotes.get(request.recipient).sourceHash = hash;
      }
      return hash;
    },
  };
  t.after(async () => {
    await app.close();
    await pool.end();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(directory, { recursive: true, force: true });
    const admin = new Pool({ connectionString: databaseUrl });
    try {
      await admin.query(`DROP SCHEMA "${cfg.schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  return {
    cfg,
    pool,
    secret,
    provider,
    quotes,
    counters,
    payer,
    journal,
    get app() {
      return app;
    },
    set providerStatus(n) {
      providerStatus = n;
    },
    set swapStatus(s) {
      swapStatus = s;
    },
    set providerDelay(n) {
      providerDelay = n;
    },
    async restart() {
      const port = new URL(app.url).port;
      await app.close();
      app = await startChatServer({
        pool,
        config: cfg,
        secret,
        provider,
        port: Number(port),
      });
      return app;
    },
    post(key, body = BODY, credential, token = TOKEN) {
      return fetch(app.url, {
        method: "POST",
        body,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
          ...(credential ? { "payment-authorization": credential } : {}),
        },
      });
    },
  };
}
