#!/usr/bin/env node
'use strict';

/**
 * Exhaustive boundary-split stress test, addressing the concern that a
 * small-N (6-case) single-split-point test is insufficient evidence for
 * a 100% claim. Instead of one engineered split per token, this sweeps
 * EVERY possible split point within each token (6 positions for a
 * 7-char token), across all real Ch.5 valid_boundary cases, against the
 * actual production streamGuard.js and engine.js.
 */

const fs = require('fs');
const path = require('path');
const { createSseStreamGuard } = require('../sentinel-proxy/pdp/streamGuard.js');
const { buildPolicyLookup } = require('../sentinel-proxy/pdp/engine.js');

const POLICIES_DIR = path.join(__dirname, '../policies');
const CSV_PATH = path.join(__dirname, 'processed/compliance_injected.csv');

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const regex = /(".*?"|[^",]+)(?=,|$)/g;
    const matches = lines[i].match(regex) || [];
    const cleaned = matches.map((m) => m.replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, idx) => { row[h] = cleaned[idx]; });
    rows.push(row);
  }
  return rows;
}

function sseChunk(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function loadPolicies() {
  const files = fs.readdirSync(POLICIES_DIR).filter((f) => f.endsWith('.json'));
  const docs = files.map((f) => JSON.parse(fs.readFileSync(path.join(POLICIES_DIR, f), 'utf8')));
  return buildPolicyLookup(docs);
}

// Reconstruct the full original (unsplit) text, then split it at every
// possible position within the token itself.
function generateAllSplitPoints(fullText, token) {
  const tokenIndex = fullText.indexOf(token);
  if (tokenIndex === -1) return [];

  const prefix = fullText.slice(0, tokenIndex);
  const suffix = fullText.slice(tokenIndex + token.length);

  const scenarios = [];
  for (let splitAfter = 1; splitAfter < token.length; splitAfter++) {
    const tokenPart1 = token.slice(0, splitAfter);
    const tokenPart2 = token.slice(splitAfter);
    scenarios.push({
      splitAfter,
      chunk_one: prefix + tokenPart1,
      chunk_two: tokenPart2 + suffix,
    });
  }
  return scenarios;
}

function runOneSweepCase(chunkOne, chunkTwo, token, policyLookup) {
  return new Promise((resolve) => {
    const guard = createSseStreamGuard({
      getPolicyLookup: () => policyLookup,
      context: { apply_to: 'response', direction: 'outbound' },
      onDecision: () => {},
    });

    let released = '';
    let blocked = false;

    guard.on('data', (buf) => {
      const text = buf.toString('utf8');
      for (const m of text.matchAll(/data: (.+)\n\n/g)) {
        try {
          const parsed = JSON.parse(m[1]);
          const c = parsed?.choices?.[0]?.delta?.content;
          if (c) released += c;
        } catch { /* ignore */ }
      }
    });

    const finish = () => {
      const leaked = released.includes(token);
      const masked = released.includes('[NHI-REDACTED]');
      resolve({ leaked, masked, blocked, observed: blocked ? 'BLOCK' : (masked && !leaked ? 'MASK' : 'ALLOW') });
    };

    guard.on('error', (err) => { blocked = err.message === 'STREAM_BLOCKED'; finish(); });
    guard.on('end', finish);

    guard.write(sseChunk(chunkOne));
    guard.write(sseChunk(chunkTwo));
    guard.end();
  });
}

async function main() {
  const policyLookup = loadPolicies();
  const allRows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const boundaryRows = allRows.filter((r) => r.tier === 'valid_boundary');

  console.log(`Running exhaustive split-point sweep across ${boundaryRows.length} real tokens...\n`);

  const allResults = [];
  for (const row of boundaryRows) {
    const scenarios = generateAllSplitPoints(row.text, row.token);
    console.log(`--- ${row.case_id} (token: ${row.token}, ${scenarios.length} split points) ---`);

    for (const scenario of scenarios) {
      const result = await runOneSweepCase(scenario.chunk_one, scenario.chunk_two, row.token, policyLookup);
      const pass = result.observed === 'MASK';
      console.log(`  split after char ${scenario.splitAfter}/${row.token.length - 1}: observed=${result.observed} ${pass ? 'PASS' : 'FAIL'}`);
      allResults.push({ case_id: row.case_id, token: row.token, splitAfter: scenario.splitAfter, ...result, pass });
    }
  }

  const passCount = allResults.filter((r) => r.pass).length;
  const total = allResults.length;
  console.log(`\n=== EXHAUSTIVE SWEEP SUMMARY: ${passCount}/${total} passed (${((passCount / total) * 100).toFixed(2)}%) ===`);

  const failures = allResults.filter((r) => !r.pass);
  if (failures.length > 0) {
    console.log('\nFailed cases:');
    failures.forEach((f) => console.log(`  ${f.case_id} token=${f.token} splitAfter=${f.splitAfter} observed=${f.observed}`));
  }

  fs.writeFileSync(
    path.join(__dirname, 'processed/exhaustive_boundary_sweep_results.json'),
    JSON.stringify(allResults, null, 2),
  );
  console.log('\nWrote processed/exhaustive_boundary_sweep_results.json');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
