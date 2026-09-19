'use strict';

const express = require('express');

const PORT = Number(process.env.PORT ?? 3000);
const CHUNK_DELAY_MS = Number(process.env.CHUNK_DELAY_MS ?? 120);

/** Dedicated model id that triggers the NHI chunk-boundary fragmentation test. */
const NHI_BOUNDARY_MODEL = 'mock/nhi-boundary-test';

/**
 * Exact chunk-boundary split requested for sliding-window validation.
 * Chunk 1 ends with 'ABC-'; chunk 2 starts with '1234'.
 * Concatenated token in the proxy carry buffer: "ABC-1234".
 */
const NHI_BOUNDARY_CHUNK_ONE = 'Clinical summary generated. The patient National Health Index is ABC-';
const NHI_BOUNDARY_CHUNK_TWO = '1234 appears on the referral form and must remain confidential.';

/**
 * Checksum-valid legacy NHI (ZAA0067) split across the same boundary pattern
 * for end-to-end MASK policy validation (ZAA00 | 67).
 */
const NHI_VALID_BOUNDARY_MODEL = 'mock/nhi-boundary-valid';
const NHI_VALID_CHUNK_ONE = 'Verified registry lookup returned identifier ZAA00';
const NHI_VALID_CHUNK_TWO = '67 for the active care pathway.';

/** Echoes the inbound user message so leak/mask checks are non-vacuous. */
const ECHO_MODEL = 'mock/echo-request';

/**
 * @param {string} content
 * @returns {string}
 */
function sseChunk(content, finishReason = null) {
  const payload = {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-llm',
    choices: [{
      index: 0,
      delta: content === null ? {} : { content },
      finish_reason: finishReason,
    }],
  };

  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * @param {string} role
 * @returns {string}
 */
function sseRoleChunk(role) {
  const payload = {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-llm',
    choices: [{
      index: 0,
      delta: { role },
      finish_reason: null,
    }],
  };

  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * @param {import('express').Response} res
 * @param {string[]} deltas
 * @returns {Promise<void>}
 */
async function streamDeltas(res, deltas) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(sseRoleChunk('assistant'));

  for (const delta of deltas) {
    await delay(CHUNK_DELAY_MS);
    res.write(sseChunk(delta));
  }

  await delay(CHUNK_DELAY_MS);
  res.write(sseChunk(null, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {object} body
 * @returns {string}
 */
function extractUserMessage(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const userMessages = messages.filter((message) => message.role === 'user');
  const last = userMessages[userMessages.length - 1];

  if (!last) {
    return '';
  }

  if (typeof last.content === 'string') {
    return last.content;
  }

  if (Array.isArray(last.content)) {
    return last.content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
  }

  return '';
}

/**
 * @param {object} body
 * @returns {string[]}
 */
function resolveEchoDeltas(body) {
  return [extractUserMessage(body)];
}

/**
 * @param {object} body
 * @returns {string[]}
 */
function resolveStreamingDeltas(body) {
  const model = body?.model ?? '';
  const userMessage = extractUserMessage(body);

  if (body?.model === ECHO_MODEL) {
    return resolveEchoDeltas(body);
  }

  if (model === NHI_BOUNDARY_MODEL || userMessage.includes('__NHI_BOUNDARY_TEST__')) {
    return [
      NHI_BOUNDARY_CHUNK_ONE,
      NHI_BOUNDARY_CHUNK_TWO,
      ' End of mock boundary response.',
    ];
  }

  if (model === NHI_VALID_BOUNDARY_MODEL || userMessage.includes('__NHI_VALID_BOUNDARY_TEST__')) {
    return [
      NHI_VALID_CHUNK_ONE,
      NHI_VALID_CHUNK_TWO,
      ' End of checksum-valid boundary response.',
    ];
  }

  return [
    'Mock LLM provider response chunk one. ',
    'Mock LLM provider response chunk two. ',
    'Streaming complete.',
  ];
}

/**
 * @param {object} body
 * @returns {object}
 */
function buildNonStreamingCompletion(body) {
  const deltas = resolveStreamingDeltas(body);
  const content = deltas.join('');

  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? 'mock-llm',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: content.length,
      total_tokens: content.length,
    },
  };
}

/**
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'mock-llm-service' });
  });

  app.get('/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [
        { id: 'mock-llm', object: 'model', owned_by: 'sentinel-gateway' },
        { id: NHI_BOUNDARY_MODEL, object: 'model', owned_by: 'sentinel-gateway' },
        { id: NHI_VALID_BOUNDARY_MODEL, object: 'model', owned_by: 'sentinel-gateway' },
        { id: ECHO_MODEL, object: 'model', owned_by: 'sentinel-gateway' },
      ],
    });
  });

  app.post('/v1/chat/completions', async (req, res) => {
    const body = req.body ?? {};
    const stream = Boolean(body.stream);

    if (stream) {
      try {
        await streamDeltas(res, resolveStreamingDeltas(body));
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).json({ error: { message: error.message } });
        } else {
          res.end();
        }
      }
      return;
    }

    res.json(buildNonStreamingCompletion(body));
  });

  return app;
}

async function startServer() {
  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`[mock-llm] listening on :${PORT}`);
    console.log(`[mock-llm] NHI boundary test model: ${NHI_BOUNDARY_MODEL}`);
    console.log(`[mock-llm] chunk 1 suffix: "${NHI_BOUNDARY_CHUNK_ONE.slice(-4)}"`);
    console.log(`[mock-llm] chunk 2 prefix: "${NHI_BOUNDARY_CHUNK_TWO.slice(0, 4)}"`);
  });

  const shutdown = (signal) => {
    console.log(`[mock-llm] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('[mock-llm] failed to start:', error);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  startServer,
  NHI_BOUNDARY_MODEL,
  NHI_BOUNDARY_CHUNK_ONE,
  NHI_BOUNDARY_CHUNK_TWO,
  NHI_VALID_BOUNDARY_MODEL,
  resolveStreamingDeltas,
};
