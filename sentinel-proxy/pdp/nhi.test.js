'use strict';
// NHI checksum conformance against HISO 10046:2024 (Health NZ) published examples and rules.
// Vectors: nhi_spec_vectors.json (source of every vector is recorded in the file).
// Vectors marked "unspecified" (the standard is silent) are not scored.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isValidNhiStructure } = require('./engine');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'nhi_spec_vectors.json'), 'utf8'));

for (const v of vectors.filter((x) => x.expected !== 'unspecified')) {
  test(`NHI ${v.nhi} is ${v.expected} [${v.source}]`, () => {
    assert.equal(isValidNhiStructure(v.nhi), v.expected === 'valid');
  });
}
