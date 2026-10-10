#!/usr/bin/env node
'use strict';
/**
 * Writes the Chapter 4 test-case manifest (90 cases) from the case builders in
 * ../test_harness.js, without running the harness or contacting the gateway.
 * Run from the data/ folder:  node ch4_case_manifest.js
 * Output: processed/ch4_case_manifest.json
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const src = fs.readFileSync(path.join(__dirname, '..', 'test_harness.js'), 'utf8')
  .replace(/^#!.*\n/, '')
  .replace(/main\(\)\.catch\([\s\S]*$/, 'module.exports = { buildBenignCases, buildComplianceCases, buildAdversarialCases };');
const m = new Module(path.join(__dirname, 'th_manifest.js'));
m.paths = Module._nodeModulePaths(__dirname);
m._compile(src, path.join(__dirname, 'th_manifest.js'));
const { buildBenignCases, buildComplianceCases, buildAdversarialCases } = m.exports;

const cases = [...buildBenignCases(50), ...buildComplianceCases(20), ...buildAdversarialCases(20)];
const ids = new Set(cases.map((c) => c.id));
const counts = {};
for (const c of cases) counts[c.category] = (counts[c.category] ?? 0) + 1;
if (cases.length !== 90 || ids.size !== 90) throw new Error(`Expected 90 unique cases, got ${cases.length}/${ids.size}`);

const manifest = cases.map((c) => ({
  id: c.id,
  category: c.category,
  model: c.model,
  stream: c.stream,
  expected: c.expected,
  eligible_for_response_masking: c.category === 'compliance' ? c.model === 'mock/nhi-boundary-valid' : null,
  secrets: c.secrets,
  content: c.content,
}));
fs.writeFileSync(path.join(__dirname, 'processed', 'ch4_case_manifest.json'), JSON.stringify(manifest, null, 2));
console.log('cases:', cases.length, 'unique ids:', ids.size, counts);
console.log('eligible response-masking cases:', manifest.filter((c) => c.eligible_for_response_masking === true).length);
