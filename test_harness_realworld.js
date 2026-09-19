#!/usr/bin/env node
'use strict';

/**
 * Real-world evaluation harness for sentinel-gateway.
 *
 * Loads converted cases from data/processed/realworld_cases.json and reuses
 * the Chapter 4 classification / metrics functions verbatim.
 */

const fs = require('fs');
const path = require('path');

const PROXY_URL = process.env.PROXY_URL ?? 'http://localhost:8080/v1/chat/completions';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 15000);
const CASES_PATH = process.env.CASES_PATH
  ?? path.join(__dirname, 'data/processed/realworld_cases.json');
const RESULTS_PATH = path.join(__dirname, 'data/processed/realworld_results.json');

/**
 * @param {object} testCase
 * @returns {Promise<object>}
 */
async function invokeProxy(testCase) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Test-Case-Id': testCase.id,
      },
      body: JSON.stringify({
        model: testCase.model,
        stream: testCase.stream,
        messages: [{ role: 'user', content: testCase.content }],
      }),
      signal: controller.signal,
    });

    const blocked = response.status === 403;
    let bodyText = '';
    let parsedBody = null;

    if (testCase.stream && response.ok) {
      bodyText = await readSseBody(response);
    } else {
      bodyText = await response.text();
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = null;
      }
    }

    return {
      ...testCase,
      status: response.status,
      blocked,
      bodyText,
      parsedBody,
      observed: classifyOutcome(testCase, response.status, bodyText, parsedBody),
      error: null,
    };
  } catch (error) {
    return {
      ...testCase,
      status: 0,
      blocked: false,
      bodyText: '',
      parsedBody: null,
      observed: 'ERROR',
      error: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {import('node:http').IncomingMessage} response
 * @returns {Promise<string>}
 */
async function readSseBody(response) {
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assembled = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';

    for (const event of events) {
      assembled += extractSseDeltaContent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    assembled += extractSseDeltaContent(buffer);
  }

  return assembled;
}

/**
 * @param {string} eventBlock
 * @returns {string}
 */
function extractSseDeltaContent(eventBlock) {
  const dataLines = eventBlock
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0 || dataLines.join('') === '[DONE]') {
    return '';
  }

  try {
    const payload = JSON.parse(dataLines.join('\n'));
    return payload?.choices?.[0]?.delta?.content
      ?? payload?.choices?.[0]?.message?.content
      ?? '';
  } catch {
    return '';
  }
}

/**
 * @param {object} testCase
 * @param {number} status
 * @param {string} bodyText
 * @param {object | null} parsedBody
 * @returns {'ALLOW' | 'BLOCK' | 'MASK' | 'ERROR'}
 */
function classifyOutcome(testCase, status, bodyText, parsedBody) {
  if (status === 0) {
    return 'ERROR';
  }

  if (status === 403) {
    return 'BLOCK';
  }

  if (status >= 500) {
    return 'ERROR';
  }

  const redactionToken = '[NHI-REDACTED]';
  const hasRedaction = bodyText.includes(redactionToken);
  const leakedSecret = testCase.secrets.some((secret) => (
    secret.length >= 7 && bodyText.includes(secret)
  ));

  if (testCase.category === 'compliance') {
    if (hasRedaction || !leakedSecret) {
      return 'MASK';
    }
    return 'ALLOW';
  }

  if (parsedBody?.error === 'REQUEST_BLOCKED' || parsedBody?.error === 'STREAM_BLOCKED') {
    return 'BLOCK';
  }

  return 'ALLOW';
}

/**
 * @param {object} result
 * @returns {boolean}
 */
function isExpected(result) {
  return result.observed === result.expected;
}

/**
 * @param {object[]} results
 * @returns {object}
 */
function computeMetrics(results) {
  const benign = results.filter((result) => result.category === 'benign');
  const compliance = results.filter((result) => result.category === 'compliance');
  const adversarial = results.filter((result) => result.category === 'adversarial');

  const tpCompliance = compliance.filter((result) => result.observed === 'MASK').length;
  const fnCompliance = compliance.filter((result) => result.observed !== 'MASK' && result.observed !== 'ERROR').length;

  const tpAdversarial = adversarial.filter((result) => result.observed === 'BLOCK').length;
  const fnAdversarial = adversarial.filter((result) => result.observed !== 'BLOCK' && result.observed !== 'ERROR').length;

  const fp = benign.filter((result) => result.observed === 'BLOCK' || result.observed === 'MASK').length;
  const tn = benign.filter((result) => result.observed === 'ALLOW').length;

  const tp = tpCompliance + tpAdversarial;
  const fn = fnCompliance + fnAdversarial;
  const violations = compliance.length + adversarial.length;

  const pcr = violations === 0 ? 0 : tp / violations;
  const arr = adversarial.length === 0 ? 0 : tpAdversarial / adversarial.length;
  const recall = (tp + fn) === 0 ? 0 : tp / (tp + fn);
  const fdr = (fp + tp) === 0 ? 0 : fp / (fp + tp);

  return {
    totals: {
      cases: results.length,
      benign: benign.length,
      compliance: compliance.length,
      adversarial: adversarial.length,
      errors: results.filter((result) => result.observed === 'ERROR').length,
    },
    confusion: {
      tp_compliance: tpCompliance,
      fn_compliance: fnCompliance,
      tp_adversarial: tpAdversarial,
      fn_adversarial: fnAdversarial,
      fp_benign: fp,
      tn_benign: tn,
      tp_total: tp,
      fn_total: fn,
    },
    metrics: {
      PCR: pcr,
      ARR: arr,
      Recall: recall,
      FDR: fdr,
    },
    accuracy: {
      benign: benign.length === 0 ? 0 : tn / benign.length,
      compliance: compliance.length === 0 ? 0 : tpCompliance / compliance.length,
      adversarial: adversarial.length === 0 ? 0 : tpAdversarial / adversarial.length,
      overall: results.length === 0 ? 0 : results.filter(isExpected).length / results.length,
    },
  };
}

/**
 * @param {number} value
 * @returns {string}
 */
function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * @param {object} summary
 * @param {object[]} failures
 * @returns {string}
 */
function formatReport(summary, failures) {
  const lines = [
    '══════════════════════════════════════════════════════════════',
    ' Sentinel Gateway — Empirical Evaluation Report',
    '══════════════════════════════════════════════════════════════',
    `Target endpoint : ${PROXY_URL}`,
    `Total cases     : ${summary.totals.cases}`,
    `  Benign        : ${summary.totals.benign}`,
    `  Compliance    : ${summary.totals.compliance}`,
    `  Adversarial   : ${summary.totals.adversarial}`,
    `  Errors        : ${summary.totals.errors}`,
    '',
    '── Confusion Matrix ──────────────────────────────────────────',
    `  TP (compliance, MASK)    : ${summary.confusion.tp_compliance}`,
    `  FN (compliance, missed)  : ${summary.confusion.fn_compliance}`,
    `  TP (adversarial, BLOCK)  : ${summary.confusion.tp_adversarial}`,
    `  FN (adversarial, missed) : ${summary.confusion.fn_adversarial}`,
    `  FP (benign, flagged)     : ${summary.confusion.fp_benign}`,
    `  TN (benign, allowed)     : ${summary.confusion.tn_benign}`,
    '',
    '── Empirical Metrics ─────────────────────────────────────────',
    `  Policy Coverage Ratio (PCR)        : ${pct(summary.metrics.PCR)}`,
    '      Violation cases where expected policy action was enforced.',
    `  Adversarial Resilience Rate (ARR)  : ${pct(summary.metrics.ARR)}`,
    '      Adversarial payloads correctly blocked (HTTP 403).',
    `  Recall                             : ${pct(summary.metrics.Recall)}`,
    '      TP / (TP + FN) across all violation cases.',
    `  False Discovery Rate (FDR)         : ${pct(summary.metrics.FDR)}`,
    '      FP / (FP + TP); benign cases incorrectly flagged.',
    '',
    '── Per-Category Accuracy ─────────────────────────────────────',
    `  Benign pass-through : ${pct(summary.accuracy.benign)}`,
    `  Compliance masking  : ${pct(summary.accuracy.compliance)}`,
    `  Adversarial block   : ${pct(summary.accuracy.adversarial)}`,
    `  Overall correctness : ${pct(summary.accuracy.overall)}`,
  ];

  if (failures.length > 0) {
    lines.push('', '── Failed Cases ────────────────────────────────────────────────');
    for (const failure of failures.slice(0, 15)) {
      lines.push(
        `  ${failure.id} [${failure.category}] expected=${failure.expected} observed=${failure.observed} status=${failure.status}${failure.error ? ` error=${failure.error}` : ''}`,
      );
    }
    if (failures.length > 15) {
      lines.push(`  ... and ${failures.length - 15} more`);
    }
  }

  lines.push('══════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

async function main() {
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));

  if (!Array.isArray(cases)) {
    throw new Error(`Expected an array of cases in ${CASES_PATH}`);
  }

  console.log(`[realworld-harness] Running ${cases.length} real-world evaluation cases against ${PROXY_URL}`);
  console.log(`[realworld-harness] Cases file : ${CASES_PATH}`);

  /** @type {object[]} */
  const results = [];

  for (const testCase of cases) {
    const tierSuffix = testCase.tier ? `/${testCase.tier}` : '';
    process.stdout.write(`[realworld-harness] ${testCase.id} (${testCase.category}${tierSuffix}) ... `);
    const result = await invokeProxy(testCase);
    results.push(result);
    const marker = isExpected(result) ? 'OK' : 'FAIL';
    console.log(`${marker} status=${result.status} observed=${result.observed}`);
  }

  const summary = computeMetrics(results);
  const failures = results.filter((result) => !isExpected(result));
  console.log('\n' + formatReport(summary, failures));

  console.log('[realworld-harness] Warning: FDR is not meaningful for this dataset due to the missing benign category (FDR divides by fp + tp; fp is counted only from benign cases). Do not treat this as a 0% false positive rate.');

  fs.writeFileSync(RESULTS_PATH, JSON.stringify({ summary, results }, null, 2) + '\n');
  console.log(`[realworld-harness] Wrote results to ${RESULTS_PATH}`);

  if (summary.totals.errors > 0) {
    console.error('[realworld-harness] Warning: one or more cases errored — is the proxy stack running on :8080?');
    process.exitCode = 2;
  } else if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[realworld-harness] Fatal error:', error);
  process.exit(1);
});
