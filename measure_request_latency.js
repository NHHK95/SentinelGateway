#!/usr/bin/env node
'use strict';

/**
 * RQ4 benchmark: per-request latency, streaming time-to-first-token, throughput
 * and resource use of the Sentinel-Proxy gateway versus the same upstream called
 * directly (baseline).
 *
 * Design
 *  - Baseline  = POST straight to the mock LLM  (BASELINE_URL, default :3000)
 *  - Gateway   = POST through Sentinel-Proxy     (GATEWAY_URL,  default :8080)
 *  - Latency scenarios are PAIRED and INTERLEAVED (baseline, gateway, baseline, ...)
 *    so machine drift affects both conditions equally. Overhead is reported as the
 *    median of the paired differences with a bootstrap 95% confidence interval.
 *  - Warm-up requests are discarded.
 *  - Throughput = closed-loop workers for a fixed duration at several concurrency
 *    levels, baseline then gateway, same payload.
 *  - Optional: docker stats snapshot (CPU / memory) during throughput runs.
 *
 * Run (mock upstream active in docker-compose.yml):
 *   node measure_request_latency.js
 * Useful environment variables:
 *   N=300 WARMUP=50 STREAM_N=100 DURATION_S=15 CONCURRENCY=1,10,50 DOCKER_STATS=1
 *   OUT=data/processed/latency_overhead_results.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { performance } = require('perf_hooks');

const BASELINE_URL = process.env.BASELINE_URL ?? 'http://localhost:3000/v1/chat/completions';
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8080/v1/chat/completions';
const N = Number(process.env.N ?? 300);
const WARMUP = Number(process.env.WARMUP ?? 50);
const STREAM_N = Number(process.env.STREAM_N ?? 100);
const DURATION_S = Number(process.env.DURATION_S ?? 15);
const CONCURRENCY = (process.env.CONCURRENCY ?? '1,10,50').split(',').map(Number);
const DOCKER_STATS = (process.env.DOCKER_STATS ?? '1') === '1';
const OUT = process.env.OUT ?? path.join(__dirname, 'data/processed/latency_overhead_results.json');

// --------------------------------------------------------------------------
// Payloads. Benign text carries no NHI or injection phrase, so the gateway
// takes the ALLOW path. The NHI payload carries one spec-valid legacy NHI
// (HISO 10046 worked example) so the gateway takes the MASK path and
// triggers an audit write.
// --------------------------------------------------------------------------
const FILLER =
  'Please summarise the attached project status update for the operations team, ' +
  'including the main risks, the agreed owners and the dates that were confirmed ' +
  'during the weekly planning meeting. ';

function benign(bytes) {
  let s = '';
  while (s.length < bytes) s += FILLER;
  return s.slice(0, bytes);
}

function withNhi(bytes) {
  const needle = " For your reference, the patient's National Health Index number is ZAC5361. ";
  const base = benign(Math.max(0, bytes - needle.length));
  const mid = Math.floor(base.length / 2);
  return base.slice(0, mid) + needle + base.slice(mid);
}

const LATENCY_SCENARIOS = [
  { id: 'benign-100B', desc: 'benign, ~100 B, ALLOW path', content: benign(100), expect: 'ALLOW' },
  { id: 'benign-1KB', desc: 'benign, ~1 KB, ALLOW path', content: benign(1024), expect: 'ALLOW' },
  { id: 'benign-3KB', desc: 'benign, ~3 KB, ALLOW path', content: benign(3072), expect: 'ALLOW' },
  { id: 'nhi-1KB', desc: '1 KB with one valid NHI, MASK path (+audit)', content: withNhi(1024), expect: 'MASK' },
];

const STREAM_SCENARIOS = [
  { id: 'stream-default-3chunk', desc: 'mock-llm default 3-chunk reply (~90 chars)', model: 'mock-llm', content: benign(100) },
  { id: 'stream-echo-1KB', desc: 'echo model, one ~1 KB delta', model: 'mock/echo-request', content: benign(1024) },
];

// --------------------------------------------------------------------------
// Statistics
// --------------------------------------------------------------------------
function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarise(values) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    mean: round(mean),
    p50: round(quantile(s, 0.5)),
    p95: round(quantile(s, 0.95)),
    p99: round(quantile(s, 0.99)),
    min: round(s[0]),
    max: round(s[s.length - 1]),
  };
}

function bootstrapMedianCI(diffs, iterations = 2000) {
  const medians = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = new Array(diffs.length);
    for (let j = 0; j < diffs.length; j += 1) {
      sample[j] = diffs[Math.floor(Math.random() * diffs.length)];
    }
    sample.sort((a, b) => a - b);
    medians.push(quantile(sample, 0.5));
  }
  medians.sort((a, b) => a - b);
  return [round(quantile(medians, 0.025)), round(quantile(medians, 0.975))];
}

function round(x, dp = 3) {
  return Math.round(x * 10 ** dp) / 10 ** dp;
}

// --------------------------------------------------------------------------
// Requests
// --------------------------------------------------------------------------
async function timedRequest(url, model, content) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  });
  const text = await res.text();
  const ms = performance.now() - t0;
  return { ms, status: res.status, bytes: text.length, text };
}

async function timedStream(url, model, content) {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok || !res.body) {
    return { ok: false, status: res.status };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let firstContentMs = null;
  let carry = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    if (firstContentMs === null && /"content":"[^"]/.test(carry)) {
      firstContentMs = performance.now() - t0;
    }
    if (carry.length > 4096) carry = carry.slice(-512);
  }
  return { ok: true, status: res.status, ttfcMs: firstContentMs, totalMs: performance.now() - t0 };
}

function pairedStats(base, gate) {
  const diffs = gate.map((g, i) => g - base[i]);
  const sorted = [...diffs].sort((a, b) => a - b);
  return {
    baseline: summarise(base),
    gateway: summarise(gate),
    overheadMedianMs: round(quantile(sorted, 0.5)),
    overheadMedianCI95: bootstrapMedianCI(diffs),
    overheadP95Ms: round(quantile(sorted, 0.95)),
  };
}

// --------------------------------------------------------------------------
// Latency (non-streaming)
// --------------------------------------------------------------------------
async function runLatency(sc) {
  const model = 'mock/echo-request';
  const base = [];
  const gate = [];
  let gateStatus200 = 0;
  let maskedSeen = 0;

  for (let i = 0; i < WARMUP + N; i += 1) {
    const b = await timedRequest(BASELINE_URL, model, sc.content);
    const g = await timedRequest(GATEWAY_URL, model, sc.content);
    if (i < WARMUP) continue;
    if (b.status !== 200 || g.status !== 200) {
      throw new Error(`${sc.id}: non-200 (baseline ${b.status}, gateway ${g.status}); check the gateway is up and uses the mock upstream`);
    }
    gateStatus200 += 1;
    if (g.text.includes('[NHI-REDACTED]')) maskedSeen += 1;
    base.push(b.ms);
    gate.push(g.ms);
  }

  const verdictOk = sc.expect === 'MASK' ? maskedSeen === N : maskedSeen === 0;
  if (!verdictOk) {
    throw new Error(`${sc.id}: gateway behaved unexpectedly (expected ${sc.expect}, masked responses = ${maskedSeen}/${N}). Is the corrected engine running on the mock upstream?`);
  }
  return { id: sc.id, desc: sc.desc, requests: N, ok: gateStatus200, ...pairedStats(base, gate) };
}

// --------------------------------------------------------------------------
// Streaming
// --------------------------------------------------------------------------
async function runStreaming(sc) {
  const bT = [];
  const gT = [];
  const bF = [];
  const gF = [];
  for (let i = 0; i < Math.floor(WARMUP / 2) + STREAM_N; i += 1) {
    const b = await timedStream(BASELINE_URL, sc.model, sc.content);
    const g = await timedStream(GATEWAY_URL, sc.model, sc.content);
    if (i < Math.floor(WARMUP / 2)) continue;
    if (!b.ok || !g.ok || b.ttfcMs === null || g.ttfcMs === null) {
      throw new Error(`${sc.id}: stream failed (baseline ok=${b.ok}, gateway ok=${g.ok})`);
    }
    bT.push(b.totalMs); gT.push(g.totalMs); bF.push(b.ttfcMs); gF.push(g.ttfcMs);
  }
  return {
    id: sc.id,
    desc: sc.desc,
    requests: STREAM_N,
    timeToFirstContent: pairedStats(bF, gF),
    totalStreamTime: pairedStats(bT, gT),
  };
}

// --------------------------------------------------------------------------
// Throughput + resource use
// --------------------------------------------------------------------------
function dockerStatsOnce() {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}', 'sentinel-proxy', 'mock-llm-service'],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const rows = {};
        stdout.trim().split('\n').forEach((line) => {
          const [name, cpu, mem] = line.split('|');
          if (name) rows[name] = { cpu, mem };
        });
        resolve(rows);
      },
    );
  });
}

async function closedLoop(url, concurrency, seconds, content, sampleResources) {
  const deadline = performance.now() + seconds * 1000;
  const lat = [];
  let errors = 0;
  let resources = null;

  async function worker() {
    while (performance.now() < deadline) {
      try {
        const r = await timedRequest(url, 'mock/echo-request', content);
        if (r.status === 200) lat.push(r.ms); else errors += 1;
      } catch { errors += 1; }
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  if (sampleResources && DOCKER_STATS) {
    setTimeout(async () => { resources = await dockerStatsOnce(); }, (seconds * 1000) / 2);
  }
  await Promise.all(workers);
  const sorted = [...lat].sort((a, b) => a - b);
  return {
    concurrency,
    completed: lat.length,
    errors,
    requestsPerSecond: round(lat.length / seconds, 1),
    p50Ms: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    p99Ms: round(quantile(sorted, 0.99)),
    resources,
  };
}

async function runThroughput() {
  const content = benign(1024);
  const rows = [];
  for (const c of CONCURRENCY) {
    // warm each target briefly
    await closedLoop(BASELINE_URL, c, 2, content, false);
    await closedLoop(GATEWAY_URL, c, 2, content, false);
    const baseline = await closedLoop(BASELINE_URL, c, DURATION_S, content, true);
    const gateway = await closedLoop(GATEWAY_URL, c, DURATION_S, content, true);
    rows.push({
      concurrency: c,
      baseline,
      gateway,
      throughputRatio: round(gateway.requestsPerSecond / baseline.requestsPerSecond, 3),
    });
    console.log(`[throughput] c=${c}: baseline ${baseline.requestsPerSecond} req/s, gateway ${gateway.requestsPerSecond} req/s`);
  }
  return rows;
}

// --------------------------------------------------------------------------
async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[latency] baseline=${BASELINE_URL}\n[latency] gateway =${GATEWAY_URL}`);
  console.log(`[latency] N=${N} warmup=${WARMUP} streamN=${STREAM_N} duration=${DURATION_S}s concurrency=${CONCURRENCY.join(',')}`);

  const latency = [];
  for (const sc of LATENCY_SCENARIOS) {
    const r = await runLatency(sc);
    latency.push(r);
    console.log(`[latency] ${sc.id}: baseline p50 ${r.baseline.p50} ms, gateway p50 ${r.gateway.p50} ms, overhead median ${r.overheadMedianMs} ms (95% CI ${r.overheadMedianCI95.join(' to ')})`);
  }

  const streaming = [];
  for (const sc of STREAM_SCENARIOS) {
    const r = await runStreaming(sc);
    streaming.push(r);
    console.log(`[stream] ${sc.id}: first-content overhead median ${r.timeToFirstContent.overheadMedianMs} ms (CI ${r.timeToFirstContent.overheadMedianCI95.join(' to ')}); total-stream overhead median ${r.totalStreamTime.overheadMedianMs} ms`);
  }

  const throughput = await runThroughput();

  const result = {
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      totalMemGB: round(os.totalmem() / 1024 ** 3, 1),
    },
    parameters: { N, WARMUP, STREAM_N, DURATION_S, CONCURRENCY, BASELINE_URL, GATEWAY_URL },
    latency,
    streaming,
    throughput,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`[latency] wrote ${OUT}`);
}

main().catch((err) => {
  console.error(`[latency] FAILED: ${err.message}`);
  process.exit(1);
});
