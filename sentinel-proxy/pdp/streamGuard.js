'use strict';

const { Transform } = require('stream');
const { evaluate } = require('./engine');
const { VERDICTS } = require('./types');

const DEFAULT_OVERLAP_CHARS = 256;
/** Hold back up to 6 chars — one less than legacy NHI length — so split tokens stay buffered. */
const STREAM_HOLDBACK_CHARS = 6;
const SSE_EVENT_DELIMITER = /\r?\n\r?\n/;

/**
 * Tracks trailing context so token patterns split across SSE chunks are still matched.
 */
class SlidingWindowContext {
  /**
   * @param {number} overlapChars
   */
  constructor(overlapChars = DEFAULT_OVERLAP_CHARS) {
    this.overlapChars = overlapChars;
    this.carry = '';
  }

  /**
   * @param {string} chunk
   * @returns {string}
   */
  append(chunk) {
    const combined = this.carry + chunk;
    this.carry = combined.slice(-this.overlapChars);
    return combined;
  }
}

/**
 * @param {string} payload
 * @returns {string}
 */
function extractStreamDeltaContent(payload) {
  try {
    const parsed = JSON.parse(payload);
    return parsed?.choices?.[0]?.delta?.content
      ?? parsed?.choices?.[0]?.message?.content
      ?? '';
  } catch {
    return '';
  }
}

/**
 * @param {string} sseChunk
 * @returns {{ events: string[], remainder: string }}
 */
function splitSseEvents(sseChunk) {
  const events = [];
  let buffer = sseChunk;

  while (true) {
    const match = buffer.match(SSE_EVENT_DELIMITER);
    if (!match || match.index === undefined) {
      break;
    }

    const eventBlock = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);
    if (eventBlock.trim()) {
      events.push(eventBlock);
    }
  }

  return { events, remainder: buffer };
}

/**
 * @param {string} eventBlock
 * @returns {{ raw: string, data: string | null, done: boolean }}
 */
function parseSseEventBlock(eventBlock) {
  const lines = eventBlock.split(/\r?\n/);
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return { raw: eventBlock, data: null, done: false };
  }

  const data = dataLines.join('\n');
  return {
    raw: eventBlock,
    data,
    done: data === '[DONE]',
  };
}

/**
 * @param {Transform} stream
 * @param {string} content
 */
function pushContentDelta(stream, content) {
  if (!content) {
    return;
  }

  const payload = {
    id: `sentinel-guard-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'sentinel-guard',
    choices: [{
      index: 0,
      delta: { content },
      finish_reason: null,
    }],
  };

  stream.push(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Creates a transform stream that inspects upstream SSE chunks through a sliding window.
 * @param {Object} options
 * @param {() => import('./types').PolicyLookup | null} options.getPolicyLookup
 * @param {import('./types').EvaluationContext} options.context
 * @param {(decision: import('./types').DecisionVerdict, meta: Object) => void} [options.onDecision]
 * @param {number} [options.overlapChars]
 * @param {number} [options.holdbackChars]
 * @returns {Transform}
 */
function createSseStreamGuard(options) {
  const window = new SlidingWindowContext(options.overlapChars ?? DEFAULT_OVERLAP_CHARS);
  const holdbackChars = options.holdbackChars ?? STREAM_HOLDBACK_CHARS;
  let sseBuffer = '';
  // Full accumulated stream text. Emission progress is tracked by committedLength,
  // not by slicing this buffer, so a character is never evaluated or emitted twice.
  let outboundHoldback = '';
  let committedLength = 0;
  let blocked = false;

  const getPolicyLookup = () => {
    const policyLookup = options.getPolicyLookup();
    if (!policyLookup) {
      throw new Error('Policy lookup is not available');
    }
    return policyLookup;
  };

  /**
   * @param {Transform} stream
   * @param {boolean} forceFlush
   */
  const releaseHeldText = (stream, forceFlush = false) => {
    const policyLookup = getPolicyLookup();

    while (committedLength < outboundHoldback.length) {
      const uncommitted = outboundHoldback.slice(committedLength);
      const decision = evaluate(uncommitted, options.context, policyLookup);
      options.onDecision?.(decision, { phase: 'release', buffer: uncommitted });

      if (decision.verdict === VERDICTS.BLOCK) {
        blocked = true;
        throw new Error('STREAM_BLOCKED');
      }

      if (decision.verdict === VERDICTS.MASK && decision.modified_payload) {
        pushContentDelta(stream, decision.modified_payload);
        committedLength = outboundHoldback.length;
        return;
      }

      if (forceFlush) {
        pushContentDelta(stream, uncommitted);
        committedLength = outboundHoldback.length;
        return;
      }

      if (uncommitted.length <= holdbackChars) {
        return;
      }

      const releasableLength = uncommitted.length - holdbackChars;
      const releasable = uncommitted.slice(0, releasableLength);
      const prefixDecision = evaluate(releasable, options.context, policyLookup);
      options.onDecision?.(prefixDecision, { phase: 'prefix', buffer: releasable });

      if (prefixDecision.verdict === VERDICTS.BLOCK) {
        blocked = true;
        throw new Error('STREAM_BLOCKED');
      }

      const emitText = prefixDecision.verdict === VERDICTS.MASK && prefixDecision.modified_payload
        ? prefixDecision.modified_payload
        : releasable;

      pushContentDelta(stream, emitText);
      committedLength += releasableLength;
    }
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      if (blocked) {
        callback();
        return;
      }

      sseBuffer += chunk.toString('utf8');
      const { events, remainder } = splitSseEvents(sseBuffer);
      sseBuffer = remainder;

      try {
        for (const eventBlock of events) {
          const parsedEvent = parseSseEventBlock(eventBlock);

          if (parsedEvent.done) {
            releaseHeldText(this, true);
            this.push(`${eventBlock}\n\n`);
            continue;
          }

          const delta = parsedEvent.data
            ? extractStreamDeltaContent(parsedEvent.data)
            : '';

          if (!parsedEvent.data || !delta) {
            this.push(`${eventBlock}\n\n`);
            continue;
          }

          const inspectText = window.append(delta);
          const windowDecision = evaluate(inspectText, options.context, getPolicyLookup());
          options.onDecision?.(windowDecision, { delta, inspectText });

          if (windowDecision.verdict === VERDICTS.BLOCK) {
            blocked = true;
            callback(new Error('STREAM_BLOCKED'));
            return;
          }

          outboundHoldback += delta;
          releaseHeldText(this, false);
        }

        callback();
      } catch (error) {
        callback(error);
      }
    },

    flush(callback) {
      try {
        if (!blocked) {
          releaseHeldText(this, true);
          if (sseBuffer) {
            this.push(sseBuffer);
          }
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

module.exports = {
  SlidingWindowContext,
  createSseStreamGuard,
  splitSseEvents,
  parseSseEventBlock,
  extractStreamDeltaContent,
  STREAM_HOLDBACK_CHARS,
};
