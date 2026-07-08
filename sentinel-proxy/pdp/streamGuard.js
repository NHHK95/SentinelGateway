'use strict';

const { Transform } = require('stream');
const { evaluate } = require('./engine');
const { VERDICTS } = require('./types');

const DEFAULT_OVERLAP_CHARS = 256;
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
 * Creates a transform stream that inspects upstream SSE chunks through a sliding window.
 * @param {Object} options
 * @param {() => import('./types').PolicyLookup | null} options.getPolicyLookup
 * @param {import('./types').EvaluationContext} options.context
 * @param {(decision: import('./types').DecisionVerdict, meta: Object) => void} [options.onDecision]
 * @param {number} [options.overlapChars]
 * @returns {Transform}
 */
function createSseStreamGuard(options) {
  const window = new SlidingWindowContext(options.overlapChars ?? DEFAULT_OVERLAP_CHARS);
  let sseBuffer = '';
  let blocked = false;

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
            this.push(`${eventBlock}\n\n`);
            continue;
          }

          if (!parsedEvent.data) {
            this.push(`${eventBlock}\n\n`);
            continue;
          }

          const delta = extractStreamDeltaContent(parsedEvent.data);
          if (delta) {
            const policyLookup = options.getPolicyLookup();
            if (!policyLookup) {
              callback(new Error('Policy lookup is not available'));
              return;
            }

            const inspectText = window.append(delta);
            const windowDecision = evaluate(inspectText, options.context, policyLookup);
            options.onDecision?.(windowDecision, { delta, inspectText });

            if (windowDecision.verdict === VERDICTS.BLOCK) {
              blocked = true;
              callback(new Error('STREAM_BLOCKED'));
              return;
            }

            if (windowDecision.verdict === VERDICTS.MASK) {
              const deltaDecision = evaluate(delta, options.context, policyLookup);
              const maskedDelta = deltaDecision.modified_payload ?? delta;

              try {
                const payload = JSON.parse(parsedEvent.data);
                if (payload?.choices?.[0]?.delta) {
                  payload.choices[0].delta.content = maskedDelta;
                } else if (payload?.choices?.[0]?.message) {
                  payload.choices[0].message.content = maskedDelta;
                }
                const rewritten = eventBlock.replace(
                  /^data: .*$/m,
                  `data: ${JSON.stringify(payload)}`,
                );
                this.push(`${rewritten}\n\n`);
                continue;
              } catch {
                // Fall through and emit the original event if rewrite fails.
              }
            }
          }

          this.push(`${eventBlock}\n\n`);
        }

        callback();
      } catch (error) {
        callback(error);
      }
    },

    flush(callback) {
      if (sseBuffer && !blocked) {
        this.push(sseBuffer);
      }
      callback();
    },
  });
}

module.exports = {
  SlidingWindowContext,
  createSseStreamGuard,
  splitSseEvents,
  parseSseEventBlock,
  extractStreamDeltaContent,
};
