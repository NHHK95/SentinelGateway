#!/usr/bin/env node
'use strict';

/**
 * Measures real PaC hot-reload latency: time from writing a policy change
 * to disk, until the gateway actually enforces it on a live request.
 *
 * Methodology: adds a new, uniquely-identifiable BLOCK rule to a scratch
 * copy of the adversarial policy, writes it, then polls the gateway with
 * a request that ONLY this new rule would catch, until it returns 403.
 */

const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, 'policies/pol_adv_injection_01.json');
const BACKUP_PATH = POLICY_PATH + '.puv-backup';
const PROXY_URL = process.env.PROXY_URL ?? 'http://localhost:8080/v1/chat/completions';
const MAX_WAIT_MS = 15000;
const POLL_INTERVAL_MS = 10;

const TEST_MARKER = `puv-test-marker-${Date.now()}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function probeGateway() {
  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-llm',
        messages: [{ role: 'user', content: TEST_MARKER }],
      }),
    });
    return res.status;
  } catch {
    return 0;
  }
}

async function main() {
  const original = fs.readFileSync(POLICY_PATH, 'utf8');
  fs.writeFileSync(BACKUP_PATH, original);
  const policy = JSON.parse(original);

  // Confirm baseline: the marker should NOT be blocked before the change
  const baselineStatus = await probeGateway();
  console.log(`Baseline probe (before policy change): status=${baselineStatus} (expect 200)`);
if (baselineStatus !== 200) {
  console.error(`ABORT: expected baseline status 200, got ${baselineStatus}. Gateway may not be reachable or routed correctly. Restoring backup and exiting.`);
  fs.writeFileSync(POLICY_PATH, original);
  fs.unlinkSync(BACKUP_PATH);
  process.exit(1);
}
  // Add a new rule targeting ONLY our unique marker
  policy.rules.push({
    rule_id: 'RULE_PUV_TEST',
    name: 'PUV Measurement Test Rule',
    description: 'Temporary rule added to measure hot-reload latency.',
    type: 'keyword_heuristic',
    match_config: { match_any: true, case_insensitive: true, scope: 'full_payload' },
    patterns: [TEST_MARKER],
    risk_weight: 1.0,
    action: 'BLOCK',
  });

  console.log(`\nWriting policy change with marker: ${TEST_MARKER}`);
  const startNs = process.hrtime.bigint();
  fs.writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2));

  let elapsedMs = 0;
  let polls = 0;
  let detected = false;

  while (elapsedMs < MAX_WAIT_MS) {
    const status = await probeGateway();
    polls++;
    const nowNs = process.hrtime.bigint();
    elapsedMs = Number(nowNs - startNs) / 1e6;

    if (status === 403) {
      detected = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  console.log(`\n${'='.repeat(50)}`);
  if (detected) {
    console.log(`PaC hot-reload latency: ${elapsedMs.toFixed(1)}ms (${polls} polls)`);
  } else {
    console.log(`TIMEOUT: policy change not detected within ${MAX_WAIT_MS}ms`);
  }
  console.log('='.repeat(50));

  // Always restore, success or failure
  fs.writeFileSync(POLICY_PATH, original);
  fs.unlinkSync(BACKUP_PATH);
  console.log('\nOriginal policy file restored.');

  // Verify restoration took effect too (sanity check, not timed)
  await sleep(500);
  const restoredStatus = await probeGateway();
  console.log(`Post-restore probe: status=${restoredStatus} (expect 200)`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  // best-effort restore on crash
  try {
    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, POLICY_PATH);
      fs.unlinkSync(BACKUP_PATH);
      console.error('Restored policy file after error.');
    }
  } catch {}
  process.exit(1);
});
