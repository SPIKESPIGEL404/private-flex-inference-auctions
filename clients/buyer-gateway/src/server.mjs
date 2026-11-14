import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { Auth } from './auth.mjs';
import { Onboarding } from './onboarding.mjs';
import { check, publicError } from './errors.mjs';

const cookieName = 'private_market_session', challengeName = 'private_market_challenge';
function cookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map(part => {
    const index = part.indexOf('='); return index < 0 ? [] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter(part => part.length === 2));
}
function cookie(name, value, origin, maxAge) {
  return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/buyer-api; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
async function jsonBody(request) {
  check(request.headers['content-type']?.split(';')[0].trim() === 'application/json', 'json_required', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; check(size <= 128 * 1024, 'request_too_large', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); check(value && typeof value === 'object' && !Array.isArray(value), 'invalid_json'); return value; }
  catch { check(false, 'invalid_json'); }
}
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

export function createGateway({ config, store, api, rpc, now = Date.now }) {
  const auth = new Auth(store, rpc, config.origin, now);
  const onboarding = new Onboarding({ store, api, rpc, config, now });
  const rates = new Map();
  function rate(request) {
    const at = now(), ip = request.socket.remoteAddress;
    for (const [key, record] of rates) if (record.until < at) rates.delete(key);
    check(rates.size < 2000 || rates.has(ip), 'rate_limited', 429);
    const record = rates.get(ip) ?? { until: at + 60_000, count: 0 };
    rates.set(ip, record);
    check(++record.count <= 180, 'rate_limited', 429);
  }
  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('content-security-policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    try {
      const url = new URL(request.url, config.origin);
      check(url.origin === config.origin, 'invalid_request_target');
      const path = url.pathname;
      if (!path.startsWith('/buyer-api/')) {
        check(request.method === 'GET' || request.method === 'HEAD', 'method_not_allowed', 405);
        const file = resolve(config.staticDir, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
        check(file.startsWith(config.staticDir + sep), 'not_found', 404);
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
        const type = types[extname(file)];
        check(type, 'not_found', 404);
        let data; try { data = await readFile(file); } catch { check(false, 'not_found', 404); }
        response.writeHead(200, { 'content-type': type, 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
        response.end(request.method === 'HEAD' ? undefined : data); return;
      }
      rate(request);
      check(['GET', 'POST'].includes(request.method), 'method_not_allowed', 405);
      if (request.method === 'POST') {
        check(request.headers.origin === config.origin, 'origin_denied', 403);
        check(!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(request.headers['sec-fetch-site']), 'origin_denied', 403);
      }
      if (path === '/buyer-api/config' && request.method === 'GET') {
        json(response, 200, { network: 'mainnet', configured: config.apiConfigured && !!config.merchantAccount && !!config.ownerTermsUrl,
          symbol: config.symbol, assetId: config.assetId, decimals: 6, maxBuyers: 8, maxTotal: '100',
          grantDays: 7, merchantAccount: config.merchantAccount ?? null, fundingEnabled: config.fundingEnabled,
          procurementReady: false, termsUrl: 'https://docs.agentsonintents.com/integration/agent-api/overview',
          ownerTermsUrl: config.ownerTermsUrl, outlayerTermsUrl: config.outlayerTermsUrl, acceptanceVersion: config.acceptanceVersion }); return;
      }
      const jar = cookies(request);
      if (path === '/buyer-api/auth/challenge' && request.method === 'POST') {
        const challenge = auth.challenge();
        response.setHeader('set-cookie', cookie(challengeName, challenge.token, config.origin, 300));
        json(response, 200, { ...challenge.payload, expiresAt: challenge.expiresAt }); return;
      }
      if (path === '/buyer-api/auth/verify' && request.method === 'POST') {
        const verified = await auth.verify(jar[challengeName], await jsonBody(request));
        // Rotate the existing authenticated cookie instead of leaving a usable session behind.
        auth.logout(jar[cookieName]);
        response.setHeader('set-cookie', [cookie(cookieName, verified.token, config.origin, 8 * 3600), cookie(challengeName, '', config.origin, 0)]);
        json(response, 200, { owner: verified.owner }); return;
      }
      if (path === '/buyer-api/auth/logout' && request.method === 'POST') {
        auth.logout(jar[cookieName]);
        response.setHeader('set-cookie', cookie(cookieName, '', config.origin, 0));
        json(response, 200, { loggedOut: true }); return;
      }
      if (path === '/buyer-api/session' && request.method === 'GET' && !jar[cookieName]) {
        json(response, 200, { owner: null, allocations: [] }); return;
      }
      const owner = auth.owner(jar[cookieName]);
      if (path === '/buyer-api/session' && request.method === 'GET') {
        json(response, 200, { owner, allocations: onboarding.list(owner) }); return;
      }
      if (path === '/buyer-api/allocations' && request.method === 'POST') {
        json(response, 200, await onboarding.create(owner, await jsonBody(request))); return;
      }
      const match = /^\/buyer-api\/allocations\/([0-9a-f-]{36})(?:\/(prepare|submit|recover|deposits|funding|funding-report))?$/.exec(path);
      if (match) {
        const [, id, action] = match;
        if (!action && request.method === 'GET') { json(response, 200, await onboarding.refresh(owner, id)); return; }
        check(request.method === 'POST', 'method_not_allowed', 405);
        const body = await jsonBody(request);
        const actions = { prepare: () => onboarding.prepare(owner, id), submit: () => onboarding.submit(owner, id, body),
          recover: () => onboarding.retrySubmitted(owner, id), deposits: () => onboarding.deposits(owner, id),
          funding: () => onboarding.beginFunding(owner, id, body.acceptance), 'funding-report': () => onboarding.reportFunding(owner, id, body) };
        check(actions[action], 'not_found', 404);
        json(response, 200, await actions[action]()); return;
      }
      if (path === '/buyer-api/inference' && request.method === 'POST') {
        const body = await jsonBody(request);
        check(body.ownerScope === `${owner.account_id}:${owner.public_key}`, 'owner_session_changed', 409);
        check(typeof body.buyerId === 'string' && onboarding.buyer(owner, body.buyerId), 'buyer_not_found', 404);
        await onboarding.modelCall(owner, body); return;
      }
      check(false, 'not_found', 404);
    } catch (error) {
      const safe = publicError(error);
      if (!response.headersSent) json(response, safe.status, { error: safe.code });
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, auth, onboarding };
}
