'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { buildPolicyLookup } = require('./engine');
const { loadPolicyDocuments } = require('./watcher');
const {
  createSseStreamGuard,
  extractStreamDeltaContent,
} = require('./streamGuard');

const policiesDir = path.resolve(__dirname, '../../policies');
const responseContext = { apply_to: 'response', direction: 'outbound' };

/**
 * @param {string} content
 * @returns {string}
 */
function sseEventFromContent(content) {
  const payload = {
    id: 'test-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };

  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * @returns {Promise<import('./types').PolicyLookup>}
 */
async function loadPrivacyLookup() {
  const documents = await loadPolicyDocuments(policiesDir);
  const privacyOnly = documents.filter((doc) => doc.policy_id === 'POL_NZ_PRIVACY_02');
  return buildPolicyLookup(privacyOnly);
}

/**
 * @param {string[]} deltaChunks
 * @param {Object} options
 * @param {{ omitDone?: boolean }} [runOptions]
 * @returns {Promise<{ output: string, chunks: string[], error: Error | null }>}
 */
async function runGuard(deltaChunks, options, runOptions = {}) {
  const guard = createSseStreamGuard(options);
  const outputChunks = [];

  guard.on('data', (chunk) => {
    outputChunks.push(chunk.toString());
  });

  const events = deltaChunks.map((delta) => sseEventFromContent(delta));
  if (!runOptions.omitDone) {
    events.push('data: [DONE]\n\n');
  }

  const input = Readable.from(events);

  let error = null;
  try {
    await pipeline(input, guard);
  } catch (err) {
    error = err;
  }

  const contentChunks = [];
  for (const chunk of outputChunks) {
    const eventsInChunk = chunk.split(/\r?\n\r?\n/).filter((block) => block.trim());
    for (const eventBlock of eventsInChunk) {
      const dataLines = eventBlock
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      const data = dataLines.join('\n');
      if (!data || data === '[DONE]') {
        continue;
      }
      contentChunks.push(extractStreamDeltaContent(data));
    }
  }

  return {
    output: contentChunks.join(''),
    chunks: contentChunks.filter(Boolean),
    error,
  };
}

test('real-world DeepSeek-style HEC4683 stream does not leak or duplicate', async () => {
  const lookup = await loadPrivacyLookup();
  // Token-by-token deltas reconstructed from the live SSE capture that produced
  // "...is HEC4683tional Health Index code is [NHI-REDACTED]".
  const deltas = [
    '\n\nT',
    'he pa',
    'tie',
    'nt',
    "'s",
    ' ',
    'N',
    'a',
    'tional',
    ' Health',
    ' Index',
    ' code',
    ' is',
    ' HEC',
    '468',
    '3',
    ',',
    ' confirming',
    ' the',
    ' accuracy',
    ' of',
    ' their',
    ' record',
    '.',
  ];

  const { output, error } = await runGuard(deltas, {
    getPolicyLookup: () => lookup,
    context: responseContext,
  });

  assert.equal(error, null);
  assert.equal(
    output,
    "\n\nThe patient's National Health Index code is [NHI-REDACTED], confirming the accuracy of their record.",
  );
  assert.equal(output.includes('HEC4683'), false);
  assert.equal((output.match(/\[NHI-REDACTED\]/g) ?? []).length, 1);
  assert.equal((output.match(/National Health Index code is/g) ?? []).length, 1);
});

test('single-character streaming of a 7-char token is masked without leak', async () => {
  const lookup = await loadPrivacyLookup();
  const source = 'The NHI is HEC4683.';
  const deltas = [...source];

  const { output, error } = await runGuard(deltas, {
    getPolicyLookup: () => lookup,
    context: responseContext,
  });

  assert.equal(error, null);
  assert.equal(output, 'The NHI is [NHI-REDACTED].');
  assert.equal(output.includes('HEC4683'), false);
});

test('Round 2 two-chunk NHI boundary (ZAA00 | 67) is still masked', async () => {
  const lookup = await loadPrivacyLookup();

  const { output, error } = await runGuard([
    'Verified registry lookup returned identifier ZAA00',
    '67 for the active care pathway.',
  ], {
    getPolicyLookup: () => lookup,
    context: responseContext,
  });

  assert.equal(error, null);
  assert.equal(output.includes('ZAA0067'), false);
  assert.equal(output.includes('ZAA00'), false);
  assert.ok(output.includes('[NHI-REDACTED]'));
  assert.equal(
    output,
    'Verified registry lookup returned identifier [NHI-REDACTED] for the active care pathway.',
  );
});

test('two distinct tokens in one stream are independently masked once each', async () => {
  const lookup = await loadPrivacyLookup();
  const source = 'First ZAA0067 then later HEC4683 end.';
  const deltas = [];
  for (let i = 0; i < source.length; i += 3) {
    deltas.push(source.slice(i, i + 3));
  }

  const { output, error } = await runGuard(deltas, {
    getPolicyLookup: () => lookup,
    context: responseContext,
  });

  assert.equal(error, null);
  assert.equal(output.includes('ZAA0067'), false);
  assert.equal(output.includes('HEC4683'), false);
  assert.equal(output, 'First [NHI-REDACTED] then later [NHI-REDACTED] end.');
  assert.equal((output.match(/\[NHI-REDACTED\]/g) ?? []).length, 2);
});

test('benign stream emits progressively exactly once with no duplication', async () => {
  const lookup = await loadPrivacyLookup();
  const chunk1 = 'Hello world, this is a benign streaming sentence about Auckland weather. ';
  const chunk2 = 'More harmless text follows without any regulated identifier present.';
  const expected = chunk1 + chunk2;

  const emittedBeforeDone = [];
  const guard = createSseStreamGuard({
    getPolicyLookup: () => lookup,
    context: responseContext,
  });

  guard.on('data', (chunk) => {
    emittedBeforeDone.push(chunk.toString());
  });

  const first = sseEventFromContent(chunk1);
  const second = sseEventFromContent(chunk2);

  guard.write(first);
  const afterFirst = emittedBeforeDone.join('');
  assert.ok(
    extractStreamDeltaContentFromRaw(afterFirst).length > 0,
    'benign text should be released before the stream ends',
  );

  guard.write(second);
  guard.write('data: [DONE]\n\n');
  guard.end();

  await new Promise((resolve, reject) => {
    guard.on('end', resolve);
    guard.on('error', reject);
  });

  const output = extractStreamDeltaContentFromRaw(emittedBeforeDone.join(''));
  assert.equal(output, expected);
  assert.equal(output.split(chunk1).length - 1, 1);
  assert.equal(output.split(chunk2).length - 1, 1);
});

/**
 * @param {string} raw
 * @returns {string}
 */
function extractStreamDeltaContentFromRaw(raw) {
  const events = raw.split(/\r?\n\r?\n/).filter((block) => block.trim());
  let assembled = '';
  for (const eventBlock of events) {
    const dataLines = eventBlock
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    const data = dataLines.join('\n');
    if (!data || data === '[DONE]') {
      continue;
    }
    assembled += extractStreamDeltaContent(data);
  }
  return assembled;
}
