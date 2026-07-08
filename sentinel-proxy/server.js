'use strict';

const crypto = require('crypto');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { evaluate } = require('./pdp/engine');
const { startPolicyWatcher } = require('./pdp/watcher');
const { connectAuditStore, dispatchAuditTrail, closeAuditStore } = require('./pdp/audit');
const { createSseStreamGuard } = require('./pdp/streamGuard');
const { VERDICTS } = require('./pdp/types');

const PORT = Number(process.env.PORT ?? 8080);
const UPSTREAM_LLM_URL = process.env.UPSTREAM_LLM_URL ?? 'http://mock-llm-service:3000';
const POLICIES_DIR = process.env.POLICIES_DIR ?? '/etc/sentinel/policies';
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

/** @type {{ getLookup: () => import('./pdp/types').PolicyLookup | null } | null} */
let policyWatcher = null;

/**
 * @param {Buffer | string | object} body
 * @returns {object | null}
 */
function parseJsonBody(body) {
  if (!body) {
    return null;
  }

  if (Buffer.isBuffer(body)) {
    if (body.length === 0) {
      return null;
    }
    return JSON.parse(body.toString('utf8'));
  }

  if (typeof body === 'string') {
    return JSON.parse(body);
  }

  return body;
}

/**
 * @param {object} payload
 * @returns {string}
 */
function extractChatTextContext(payload) {
  if (!payload || !Array.isArray(payload.messages)) {
    return '';
  }

  return payload.messages
    .map((message) => {
      if (typeof message.content === 'string') {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        return message.content
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .join('\n');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {object} payload
 * @param {string} maskedText
 * @returns {object}
 */
function applyMaskedChatContext(payload, maskedText) {
  const clone = JSON.parse(JSON.stringify(payload));
  if (!Array.isArray(clone.messages) || clone.messages.length === 0) {
    return clone;
  }

  const lastIndex = clone.messages.length - 1;
  clone.messages[lastIndex].content = maskedText;
  return clone;
}

/**
 * @param {import('./pdp/types').DecisionVerdict} decision
 * @param {import('./pdp/types').PolicyLookup | null} policyLookup
 * @param {Object} meta
 * @returns {import('express').Response | null}
 */
function handleBlockedDecision(decision, policyLookup, meta, res) {
  dispatchAuditTrail({
    decision,
    policyLookup,
    phase: meta.phase,
    path: meta.path,
    requestId: meta.requestId,
    streaming: meta.streaming ?? false,
  });

  const blockRule = decision.triggered_rules.find((rule) => rule.action === VERDICTS.BLOCK);
  const policy = blockRule
    ? policyLookup?.policies.get(blockRule.policy_id)?.document
    : null;
  const blockConfig = policy?.enforcement?.block_config;

  return res.status(blockConfig?.http_status ?? 403).json(
    blockConfig?.response_body ?? {
      error: 'REQUEST_BLOCKED',
      message: 'Request blocked by sentinel policy engine.',
      verdict: decision.verdict,
      frameworks: decision.frameworks,
    },
  );
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function interceptChatCompletions(req, res, next) {
  const requestId = req.headers['x-request-id']?.toString() ?? crypto.randomUUID();
  req.sentinel = { requestId, path: CHAT_COMPLETIONS_PATH };

  const policyLookup = policyWatcher?.getLookup() ?? null;
  if (!policyLookup) {
    return res.status(503).json({
      error: 'POLICY_UNAVAILABLE',
      message: 'Policy lookup is not loaded.',
    });
  }

  let payload;
  try {
    payload = parseJsonBody(req.body);
  } catch {
    return res.status(400).json({
      error: 'INVALID_JSON',
      message: 'Request body must be valid JSON.',
    });
  }

  if (!payload) {
    return res.status(400).json({
      error: 'EMPTY_BODY',
      message: 'Request body is required.',
    });
  }

  const textContext = extractChatTextContext(payload);
  const decision = evaluate(
    textContext,
    { apply_to: 'request', direction: 'inbound' },
    policyLookup,
  );

  req.sentinel.requestDecision = decision;
  req.sentinel.isStreaming = Boolean(payload.stream);

  if (decision.triggered_rules.length > 0) {
    dispatchAuditTrail({
      decision,
      policyLookup,
      phase: 'request',
      path: CHAT_COMPLETIONS_PATH,
      requestId,
      streaming: req.sentinel.isStreaming,
    });
  }

  if (decision.verdict === VERDICTS.BLOCK) {
    return handleBlockedDecision(decision, policyLookup, {
      phase: 'request',
      path: CHAT_COMPLETIONS_PATH,
      requestId,
    }, res);
  }

  if (decision.verdict === VERDICTS.MASK && decision.modified_payload) {
    payload = applyMaskedChatContext(payload, decision.modified_payload);
  }

  req.sentinel.proxyBody = Buffer.from(JSON.stringify(payload), 'utf8');
  return next();
}

/**
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => {
    const lookup = policyWatcher?.getLookup();
    res.status(lookup ? 200 : 503).json({
      status: lookup ? 'ok' : 'starting',
      policies_loaded: lookup?.policy_count ?? 0,
      policy_revision: lookup?.revision ?? null,
    });
  });

  app.post(
    CHAT_COMPLETIONS_PATH,
    express.raw({ type: '*/*', limit: '10mb' }),
    interceptChatCompletions,
  );

  const proxy = createProxyMiddleware({
    target: UPSTREAM_LLM_URL,
    changeOrigin: true,
    selfHandleResponse: true,
    on: {
      proxyReq: (proxyReq, req) => {
        if (req.sentinel?.proxyBody) {
          proxyReq.setHeader('content-length', req.sentinel.proxyBody.length);
          proxyReq.write(req.sentinel.proxyBody);
          proxyReq.end();
          return;
        }

        if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
          proxyReq.setHeader('content-length', req.body.length);
          proxyReq.write(req.body);
          proxyReq.end();
        }
      },
      proxyRes: (proxyRes, req, res) => {
        const policyLookup = policyWatcher?.getLookup() ?? null;
        const contentType = proxyRes.headers['content-type'] ?? '';
        const isEventStream = contentType.includes('text/event-stream')
          || req.sentinel?.isStreaming;

        res.status(proxyRes.statusCode ?? 200);
        Object.entries(proxyRes.headers).forEach(([key, value]) => {
          if (value !== undefined && key.toLowerCase() !== 'transfer-encoding') {
            res.setHeader(key, value);
          }
        });

        if (!req.sentinel || proxyRes.statusCode >= 400) {
          proxyRes.pipe(res);
          return;
        }

        if (isEventStream) {
          const guard = createSseStreamGuard({
            getPolicyLookup: () => policyWatcher?.getLookup() ?? null,
            context: { apply_to: 'response', direction: 'outbound' },
            onDecision: (decision) => {
              if (decision.triggered_rules.length === 0) {
                return;
              }

              dispatchAuditTrail({
                decision,
                policyLookup,
                phase: 'stream',
                path: CHAT_COMPLETIONS_PATH,
                requestId: req.sentinel.requestId,
                streaming: true,
              });
            },
          });

          guard.on('error', (error) => {
            if (error.message === 'STREAM_BLOCKED') {
              if (!res.headersSent) {
                res.status(403).json({
                  error: 'STREAM_BLOCKED',
                  message: 'Streaming response blocked by sentinel policy engine.',
                  request_id: req.sentinel.requestId,
                });
                return;
              }
              res.end();
              return;
            }

            console.error('[stream-guard]', error.message);
            if (!res.headersSent) {
              res.status(502).json({ error: 'STREAM_GUARD_FAILURE' });
            } else {
              res.end();
            }
          });

          proxyRes.pipe(guard).pipe(res);
          return;
        }

        const chunks = [];
        proxyRes.on('data', (chunk) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          let responsePayload = bodyBuffer.toString('utf8');

          try {
            const parsed = JSON.parse(responsePayload);
            const responseText = parsed?.choices?.[0]?.message?.content ?? responsePayload;
            const decision = evaluate(
              responseText,
              { apply_to: 'response', direction: 'outbound' },
              policyLookup,
            );

            if (decision.triggered_rules.length > 0) {
              dispatchAuditTrail({
                decision,
                policyLookup,
                phase: 'response',
                path: CHAT_COMPLETIONS_PATH,
                requestId: req.sentinel.requestId,
                streaming: false,
              });
            }

            if (decision.verdict === VERDICTS.BLOCK) {
              handleBlockedDecision(decision, policyLookup, {
                phase: 'response',
                path: CHAT_COMPLETIONS_PATH,
                requestId: req.sentinel.requestId,
              }, res);
              return;
            }

            if (decision.verdict === VERDICTS.MASK && decision.modified_payload) {
              if (parsed?.choices?.[0]?.message) {
                parsed.choices[0].message.content = decision.modified_payload;
                responsePayload = JSON.stringify(parsed);
              } else {
                responsePayload = decision.modified_payload;
              }
            }
          } catch {
            // Non-JSON responses pass through unchanged.
          }

          res.send(responsePayload);
        });
      },
    },
  });

  app.use(express.raw({ type: '*/*', limit: '10mb' }), proxy);

  return app;
}

async function startServer() {
  await connectAuditStore();

  policyWatcher = await startPolicyWatcher({
    policiesDir: POLICIES_DIR,
    onReload: (lookup) => {
      console.log(`[pdp] loaded ${lookup.policy_count} policies (revision ${lookup.revision})`);
    },
    onError: (error) => {
      console.error('[pdp] policy watcher error:', error.message);
    },
  });

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`[sentinel-proxy] listening on :${PORT}, upstream=${UPSTREAM_LLM_URL}`);
  });

  const shutdown = async (signal) => {
    console.log(`[sentinel-proxy] received ${signal}, shutting down`);
    server.close();
    await policyWatcher?.stop();
    await closeAuditStore();
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('[sentinel-proxy] failed to start:', error);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  extractChatTextContext,
  startServer,
};
