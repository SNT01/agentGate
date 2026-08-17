'use strict';
/**
 * HTTP surface for the Token Broker. Dependency-free (Node's built-in
 * `http`), so it runs with no install step.
 *
 * Endpoints:
 *   GET  /health         — liveness + broker public key (unauthenticated)
 *   POST /token          — request a scoped, short-lived token
 *   GET  /audit          — full audit log            (admin token required)
 *   GET  /audit/verify   — chain integrity check     (admin token required)
 *
 * Production notes:
 *  - Terminate TLS in front of this (reverse proxy or `https.createServer`).
 *    Token requests carry signatures; they must not cross the network in clear.
 *  - Admin endpoints require `Authorization: Bearer $AGENTGATE_ADMIN_TOKEN`
 *    and are disabled entirely when that variable is unset (fail closed).
 *  - Request bodies are capped at `config.maxBodyBytes`.
 *  - Binds to 127.0.0.1 by default; set AGENTGATE_BROKER_HOST to expose it.
 */
const http = require('http');
const crypto = require('crypto');
const { TokenBroker } = require('./broker');
const { config } = require('../shared/config');
const log = require('../shared/logger');

/** Constant-time compare so admin-token checks leak no timing information. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorizedAdmin(req) {
  if (!config.adminToken) return false; // fail closed when unconfigured
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return safeEqual(match[1], config.adminToken);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer(broker = new TokenBroker()) {
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      const payload = JSON.stringify(obj, null, 2);
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(payload);
    };

    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /health') {
        return send(200, { status: 'ok', brokerPublicKey: broker.publicKey });
      }

      if (route === 'POST /token') {
        const raw = await readBody(req, config.maxBodyBytes);
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch (_e) {
          return send(400, { granted: false, reason: 'invalid JSON body' });
        }
        const result = broker.requestToken(body);
        return send(result.granted ? 200 : 403, result);
      }

      if (route === 'GET /audit' || route === 'GET /audit/verify') {
        if (!isAuthorizedAdmin(req)) {
          log.warn('unauthorized admin request', { route, ip: req.socket.remoteAddress });
          return send(401, {
            error: config.adminToken
              ? 'unauthorized — send Authorization: Bearer <AGENTGATE_ADMIN_TOKEN>'
              : 'admin endpoints are disabled — set AGENTGATE_ADMIN_TOKEN to enable them',
          });
        }
        if (route === 'GET /audit') {
          const limit = Number(url.searchParams.get('limit')) || 0;
          return send(200, { entries: limit > 0 ? broker.audit.recent(limit) : broker.audit.all() });
        }
        return send(200, broker.audit.verifyChain(broker.publicKey));
      }

      return send(404, { error: 'not found' });
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) log.error('request failed', { error: err.message });
      return send(status, { error: status >= 500 ? 'internal error' : err.message });
    }
  });

  // Bound header/body wait times so slow-loris style connections cannot pile up.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  return server;
}

function start() {
  const { assertProductionSafe } = require('../shared/config');
  if (config.isProduction) assertProductionSafe();

  const broker = new TokenBroker();
  const server = createServer(broker);

  server.listen(config.port, config.host, () => {
    log.info('broker listening', {
      host: config.host,
      port: config.port,
      env: config.env,
      tokenTtlMs: config.tokenTtlMs,
      adminEndpoints: config.adminToken ? 'enabled' : 'disabled (AGENTGATE_ADMIN_TOKEN unset)',
    });
  });

  const shutdown = (signal) => {
    log.info('shutting down', { signal });
    server.close(() => process.exit(0));
    // Don't hang forever on lingering keep-alive connections.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) start();

module.exports = { createServer, start };
