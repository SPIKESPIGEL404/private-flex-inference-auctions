// Separate entry and volume. Never selected by the existing P2 startup.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { launch } from "../services/mpp-near-direct/auction/live/runtime.mjs";
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const runtime =
    config.paymentMethod === "nearintents"
      ? await (
          await import("../services/mpp-nearintents/auction/runtime.mjs")
        ).launchNearintentsAuction(config)
      : await launch(config),
  root = resolve(config.staticDirectory ?? "clients/market-playground/dist");
const media = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const edge = http.createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      return res.end(
        JSON.stringify({
          ready: true,
          network: "mainnet",
          mode:
            config.paymentMethod === "nearintents"
              ? "bounded-nearintents-auction-v1"
              : runtime.plan.mode,
          planHash: runtime.planHash,
          realPayment: true,
        }),
      );
    }
    if (
      req.url.startsWith("/buyer-api/") ||
      req.url === "/v1/chat/completions"
    ) {
      const target = new URL(runtime.app.url);
      const proxy = http.request(
        {
          host: "127.0.0.1",
          port: target.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: target.host },
        },
        (upstream) => {
          res.writeHead(upstream.statusCode, upstream.headers);
          upstream.pipe(res);
        },
      );
      proxy.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(proxy);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      return res.end();
    }
    let path = resolve(
      root,
      "." + new URL(req.url, "http://loopback").pathname,
    );
    if (!path.startsWith(root + "/")) path = resolve(root, "index.html");
    try {
      if (!(await stat(path)).isFile()) path = resolve(root, "index.html");
    } catch {
      path = resolve(root, "index.html");
    }
    const raw = await readFile(path);
    res.writeHead(200, {
      "content-type": media[extname(path)] ?? "application/octet-stream",
      "cache-control":
        extname(path) === ".html" ? "no-store" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
    });
    res.end(req.method === "HEAD" ? undefined : raw);
  } catch {
    res.writeHead(500);
    res.end("unavailable");
  }
});
await new Promise((r) => edge.listen(config.port ?? 3000, "0.0.0.0", r));
console.log(
  JSON.stringify({
    ready: true,
    mode: runtime.plan.mode,
    network: "mainnet",
    planHash: runtime.planHash,
  }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    edge.closeAllConnections();
    edge.close(() => void runtime.close().then(() => process.exit(0)));
  });
