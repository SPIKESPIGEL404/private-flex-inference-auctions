// Owned loopback-only UI acceptance. Never imported by the production runtime.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import {
  fixture,
  FUNDER,
} from "../services/mpp-nearintents/auction/test/fixture.mjs";
if (
  !process.env.AUCTION_TEST_DATABASE_URL ||
  process.env.NEARINTENTS_AUCTION_TEST !== "1"
)
  throw Error("isolated_acceptance_database_required");
const origin = "http://127.0.0.1:4518",
  f = await fixture({
    databaseUrl: process.env.AUCTION_TEST_DATABASE_URL,
    origin,
    autoOwner: true,
  }),
  root = resolve("clients/market-playground/dist");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
const edge = http.createServer(async (req, res) => {
  try {
    if (req.url === "/fixture/fund" && req.method === "POST") {
      const chunks = [];
      for await (const b of req) chunks.push(b);
      const tx = JSON.parse(Buffer.concat(chunks).toString());
      if (tx.from.toLowerCase() !== FUNDER.toLowerCase())
        throw Error("fixture_funder_mismatch");
      const token = !!tx.data,
        to = token ? "0x" + tx.data.slice(34, 74) : tx.to,
        amount = String(BigInt(token ? "0x" + tx.data.slice(-64) : tx.value));
      if (token && tx.to.toLowerCase() !== f.plan.originAsset.split(":").at(-1))
        throw Error("fixture_token_mismatch");
      const hash = f.fund(to, token ? "token" : "gas", amount);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ hash }));
    }
    if (req.url === "/fixture/state") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          counters: f.counters,
          providerCalls: Number(
            (
              await f.pool.query(
                "SELECT count(*) FROM fixture_auction_provider_ops",
              )
            ).rows[0].count,
          ),
        }),
      );
    }
    if (
      req.url.startsWith("/buyer-api/") ||
      req.url.startsWith("/market-api/") ||
      req.url === "/v1/chat/completions"
    ) {
      const target = new URL(f.app.url),
        p = http.request(
          {
            host: "127.0.0.1",
            port: target.port,
            path: req.url,
            method: req.method,
            headers: { ...req.headers, host: target.host },
          },
          (up) => {
            res.writeHead(up.statusCode, up.headers);
            up.pipe(res);
          },
        );
      p.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(p);
      return;
    }
    let path = resolve(root, "." + new URL(req.url, origin).pathname);
    if (!path.startsWith(root + "/")) path = resolve(root, "index.html");
    try {
      if (!(await stat(path)).isFile()) path = resolve(root, "index.html");
    } catch {
      path = resolve(root, "index.html");
    }
    res.writeHead(200, {
      "content-type": mime[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(await readFile(path));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "controlled_fixture_error" }));
  }
});
await new Promise((r) => edge.listen(4518, "127.0.0.1", r));
console.log(
  JSON.stringify({
    url: origin,
    scope: "controlled-nearintents-auction",
    realBroadcasts: 0,
    realInference: false,
  }),
);
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  edge.closeAllConnections();
  await new Promise((r) => edge.close(r));
  await f.close();
}
process.once("SIGINT", () => void close().then(() => process.exit(0)));
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
