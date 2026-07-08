'use strict';

const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const DEFAULT_MONGODB_URI = 'mongodb://audit-db:27017/sentinel';
const DEFAULT_DB_NAME = 'sentinel';

/** @type {MongoClient | null} */
let client = null;
/** @type {import('mongodb').Db | null} */
let db = null;
/** @type {Promise<void> | null} */
let connectPromise = null;

/**
 * @param {Object} [options]
 * @param {string} [options.uri]
 * @param {string} [options.dbName]
 * @returns {Promise<void>}
 */
async function connectAuditStore(options = {}) {
  if (db) {
    return;
  }

  if (!connectPromise) {
    const uri = options.uri ?? process.env.MONGODB_URI ?? DEFAULT_MONGODB_URI;
    const dbName = options.dbName ?? process.env.MONGODB_DB ?? DEFAULT_DB_NAME;

    connectPromise = (async () => {
      client = new MongoClient(uri);
      await client.connect();
      db = client.db(dbName);
    })();
  }

  await connectPromise;
}

/**
 * @param {import('./types').DecisionVerdict} decision
 * @param {import('./types').PolicyLookup | null} policyLookup
 * @returns {string[]}
 */
function resolveAuditCollections(decision, policyLookup) {
  if (!policyLookup) {
    return ['policy_events'];
  }

  /** @type {Set<string>} */
  const collections = new Set();

  for (const triggered of decision.triggered_rules) {
    const compiled = policyLookup.policies.get(triggered.policy_id);
    const collection = compiled?.document.enforcement?.audit_collection;
    if (collection) {
      collections.add(collection);
    }
  }

  if (collections.size === 0) {
    collections.add('policy_events');
  }

  return [...collections];
}

/**
 * @param {Object} params
 * @param {import('./types').DecisionVerdict} params.decision
 * @param {import('./types').PolicyLookup | null} params.policyLookup
 * @param {'request' | 'response' | 'stream'} params.phase
 * @param {string} params.path
 * @param {string} [params.requestId]
 * @param {boolean} [params.streaming]
 * @returns {Object}
 */
function buildAuditRecord({
  decision,
  policyLookup,
  phase,
  path,
  requestId,
  streaming = false,
}) {
  return {
    audit_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    phase,
    path,
    streaming,
    request_id: requestId ?? crypto.randomUUID(),
    verdict: decision.verdict,
    risk_score: decision.risk_score,
    evaluated_at: decision.evaluated_at,
    policy_revision: policyLookup?.revision ?? null,
    policy_count: policyLookup?.policy_count ?? 0,
    triggered_rules: decision.triggered_rules.map((rule) => ({
      policy_id: rule.policy_id,
      policy_version: rule.policy_version,
      rule_id: rule.rule_id,
      rule_name: rule.rule_name,
      rule_type: rule.rule_type,
      action: rule.action,
      risk_weight: rule.risk_weight,
      match_count: rule.matches.length,
    })),
    compliance: {
      frameworks: decision.frameworks,
    },
  };
}

/**
 * Asynchronously persists a structured compliance audit trail block.
 * Failures are logged and never block the request path.
 * @param {Object} params
 * @param {import('./types').DecisionVerdict} params.decision
 * @param {import('./types').PolicyLookup | null} params.policyLookup
 * @param {'request' | 'response' | 'stream'} params.phase
 * @param {string} params.path
 * @param {string} [params.requestId]
 * @param {boolean} [params.streaming]
 * @returns {void}
 */
function dispatchAuditTrail(params) {
  if (params.decision.triggered_rules.length === 0) {
    return;
  }

  const record = buildAuditRecord(params);
  const collections = resolveAuditCollections(params.decision, params.policyLookup);

  void (async () => {
    try {
      await connectAuditStore();
      if (!db) {
        throw new Error('Audit database is not connected');
      }

      await Promise.all(
        collections.map((collection) => db.collection(collection).insertOne({ ...record })),
      );
    } catch (error) {
      console.error('[audit] failed to persist compliance trail:', error.message);
    }
  })();
}

/**
 * @returns {Promise<void>}
 */
async function closeAuditStore() {
  if (client) {
    await client.close();
  }
  client = null;
  db = null;
  connectPromise = null;
}

module.exports = {
  connectAuditStore,
  dispatchAuditTrail,
  buildAuditRecord,
  closeAuditStore,
};
