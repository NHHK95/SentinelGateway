#!/usr/bin/env node
'use strict';

/**
 * Re-tests the Chapter 5 valid_boundary compliance cases as GENUINE
 * two-chunk SSE streams through the actual, now-fixed streamGuard.js —
 * rather than the non-streaming request they were originally evaluated
 * as (test_harness_realworld.js hardcodes stream: false for all cases).
 *
 * This directly imports the real production modules — no mocks, no
 * Docker, no live gateway required. It verifies that the Ch.5 claim
 * ("directly re-exercises the Round 3 disclosure-timing fix") is
 * actually true as tested, using the real boundary_chunk_one /
 * boundary_chunk_two split metadata already generated during Ch.5
 * dataset construction.
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
  const payload = { choices: [{ delta: { content } }] };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function loadPolicies() {
  const files = fs.readdirSync(POLICIES_DIR).filter((f) => f.endsWith('.json'));
  const docs = files.map((f) => JSON.parse(fs.readFileSync(path.join(POLICIES_DIR, f), 'utf8')));
  return buildPolicyLookup(docs);
}

function runBoundaryCase(row, policyLookup) {
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
        } catch { /* ignore [DONE] etc */ }
      }
    });

    const finish = () => {
      const leaked = released.includes(row.token);
      const masked = released.includes('[NHI-REDACTED]');
      const observed = blocked ? 'BLOCK' : (masked && !leaked ? 'MASK' : 'ALLOW');
      resolve({
        case_id: row.case_id,
        token: row.token,
        chunk_one: row.boundary_chunk_one,
        chunk_two: row.boundary_chunk_two,
        emitted: released,
        leaked,
        masked,
        observed,
        expected: row.expected_verdict,
        pass: observed === row.expected_verdict,
      });
    };

    guard.on('error', (err) => {
      blocked = err.message === 'STREAM_BLOCKED';
      finish();
    });
    guard.on('end', finish);

    // Feed the REAL two-chunk split exactly as Ch.5 dataset construction
    // computed it, as two separate SSE deltas — genuine streaming, not
    // a single non-streaming request.
    guard.write(sseChunk(row.boundary_chunk_one));
    guard.write(sseChunk(row.boundary_chunk_two));
    guard.end();
  });
}

async function main() {
  const policyLookup = loadPolicies();
  const allRows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const boundaryRows = allRows.filter((r) => r.tier === 'valid_boundary');

  console.log(`Loaded ${boundaryRows.length} valid_boundary cases from ${CSV_PATH}\n`);

  const results = [];
  for (const row of boundaryRows) {
    const result = await runBoundaryCase(row, policyLookup);
    results.push(result);
    console.log(`${result.case_id} (token: ${result.token})`);
    console.log(`  emitted: "${result.emitted}"`);
    console.log(`  leaked=${result.leaked} masked=${result.masked} observed=${result.observed} expected=${result.expected}`);
    console.log(`  ${result.pass ? 'PASS' : 'FAIL'}\n`);
  }

  const passCount = results.filter((r) => r.pass).length;
  console.log(`\n=== SUMMARY: ${passCount}/${results.length} passed ===`);

  fs.writeFileSync(
    path.join(__dirname, 'processed/boundary_retest_results.json'),
    JSON.stringify(results, null, 2),
  );
  console.log('Wrote processed/boundary_retest_results.json');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
