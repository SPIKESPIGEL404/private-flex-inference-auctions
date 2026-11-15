import http from "node:http";
import { Pool } from "pg";
import { check, configuration } from "./config.mjs";
import { ChatAuthority } from "./authority.mjs";

export async function chatPool(databaseUrl, schema) {
  check(/^[a-z][a-z0-9_]{0,47}$/.test(schema), "dedicated_schema_required");
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await admin.end();
  }
  return new Pool({
    connectionString: databaseUrl,
    max: 8,
    options: `-c search_path=${schema}`,
    application_name: "nearintents-paid-chat",
  });
}
export async function startChatServer({
  pool,
  config,
  secret,
  jwt,
  provider,
  port = 0,
  enableLive,
  fault,
}) {
  const { fingerprint } = configuration(config, secret);
  check(
    config.mode !== "live" || enableLive === fingerprint,
    "reviewed_live_chat_plan_required",
  );
  const authority = new ChatAuthority({
    pool,
    config,
    secret,
    jwt,
    provider,
    fault,
  });
  await authority.initialize();
  let stopping = false;
  const jobs = new Set();
  const server = http.createServer(async (req, res) => {
    let finish;
    const job = new Promise((resolve) => {
      finish = resolve;
    });
    jobs.add(job);
    const send = ({ status, data, raw, headers = {} }) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...headers,
      });
      res.end(raw ?? JSON.stringify(data));
    };
    try {
      check(!stopping, "server_stopping");
      if (req.url === "/healthz" && req.method === "GET")
        return send({
          status: 200,
          data: {
            ready: true,
            method: "nearintents",
            mode: config.mode,
            billing: "fixed-request-v1",
            planHash: fingerprint,
          },
        });
      const agent = authority.agent(
        req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1],
      );
      if (!agent)
        return send({
          status: 401,
          data: { error: { code: "agent_authentication_required" } },
        });
      if (req.url !== "/v1/chat/completions" || req.method !== "POST")
        return send({ status: 404, data: { error: { code: "not_found" } } });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return send({
          status: 415,
          data: { error: { code: "json_body_required" } },
        });
      check(
        req.headers["content-encoding"] === undefined,
        "encoded_body_forbidden",
      );
      let size = 0;
      const chunks = [];
      for await (const part of req) {
        size += part.length;
        check(size <= 128 * 1024, "request_too_large");
        chunks.push(part);
      }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      return send(
        await authority.chat({
          agent,
          logicalKey: req.headers["idempotency-key"],
          raw,
          credential: req.headers["payment-authorization"],
        }),
      );
    } catch (e) {
      const code = /^[a-z][a-z0-9_]+$/.test(e.message)
        ? e.message
        : "original_operation_requires_reconciliation";
      return send({
        status: /conflict|changed|unresolved|closed|reconciliation/.test(code)
          ? 409
          : /exhausted/.test(code)
            ? 429
            : /required|invalid|unsupported|limit|above|unavailable|large|forbidden/.test(
                  code,
                )
              ? 400
              : 503,
        data: { error: { code } },
      });
    } finally {
      finish();
      jobs.delete(job);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    authority,
    url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    async close() {
      stopping = true;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...jobs]);
    },
  };
}
