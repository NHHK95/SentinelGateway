'use strict';

/** @typedef {'ALLOW' | 'MASK' | 'BLOCK'} Verdict */

/** @typedef {'regex' | 'keyword_heuristic'} RuleType */

/** @typedef {'request' | 'response'} ApplyTo */

/** @typedef {'inbound' | 'outbound'} Direction */

/**
 * @typedef {Object} ComplianceMapping
 * @property {string} framework
 * @property {string} reference
 * @property {string} title
 * @property {string} description
 * @property {string} [url]
 */

/**
 * @typedef {Object} PolicyScope
 * @property {ApplyTo[]} apply_to
 * @property {Direction[]} directions
 */

/**
 * @typedef {Object} MaskConfig
 * @property {'partial' | 'full'} [strategy]
 * @property {string} replacement
 * @property {boolean} [preserve_length]
 */

/**
 * @typedef {Object} KeywordMatchConfig
 * @property {boolean} [match_any]
 * @property {boolean} [case_insensitive]
 * @property {'full_payload' | 'line'} [scope]
 */

/**
 * @typedef {Object} PolicyRule
 * @property {string} rule_id
 * @property {string} name
 * @property {string} [description]
 * @property {RuleType} type
 * @property {string} [pattern]
 * @property {string[]} [flags]
 * @property {string[]} [patterns]
 * @property {KeywordMatchConfig} [match_config]
 * @property {Record<string, string[]>} [examples]
 * @property {number} risk_weight
 * @property {Verdict} action
 * @property {MaskConfig} [mask_config]
 */

/**
 * @typedef {Object} PolicyEnforcement
 * @property {'enforcing' | 'monitoring'} mode
 * @property {string} on_match
 * @property {boolean} audit
 * @property {string} [audit_collection]
 * @property {Object} [block_config]
 */

/**
 * @typedef {Object} PolicyMetadata
 * @property {string} owner
 * @property {string[]} tags
 * @property {string} created_at
 * @property {string} updated_at
 * @property {number} [review_cycle_days]
 */

/**
 * @typedef {Object} PolicyDocument
 * @property {string} policy_id
 * @property {string} version
 * @property {string} name
 * @property {string} description
 * @property {'active' | 'inactive' | 'draft'} status
 * @property {string} effective_date
 * @property {PolicyScope} scope
 * @property {ComplianceMapping[]} compliance
 * @property {PolicyRule[]} rules
 * @property {PolicyEnforcement} enforcement
 * @property {PolicyMetadata} metadata
 */

/**
 * @typedef {Object} RuleMatch
 * @property {string} value
 * @property {number} index
 * @property {number} length
 * @property {string} [replacement]
 */

/**
 * @typedef {Object} TriggeredRule
 * @property {string} policy_id
 * @property {string} policy_version
 * @property {string} rule_id
 * @property {string} rule_name
 * @property {RuleType} rule_type
 * @property {Verdict} action
 * @property {number} risk_weight
 * @property {RuleMatch[]} matches
 * @property {ComplianceMapping[]} compliance
 */

/**
 * @typedef {Object} FrameworkMetadata
 * @property {string} framework
 * @property {string} reference
 * @property {string} title
 * @property {string[]} policy_ids
 * @property {string[]} rule_ids
 */

/**
 * @typedef {Object} DecisionVerdict
 * @property {Verdict} verdict
 * @property {TriggeredRule[]} triggered_rules
 * @property {FrameworkMetadata[]} frameworks
 * @property {number} risk_score
 * @property {string} [modified_payload]
 * @property {string} evaluated_at
 */

/**
 * @typedef {Object} CompiledRegexRule
 * @property {PolicyRule} rule
 * @property {'regex'} compiled_type
 * @property {RegExp} matcher
 * @property {boolean} validate_nhi
 */

/**
 * @typedef {Object} CompiledKeywordRule
 * @property {PolicyRule} rule
 * @property {'keyword_heuristic'} compiled_type
 * @property {string[]} patterns
 * @property {boolean} case_insensitive
 * @property {boolean} match_any
 */

/** @typedef {CompiledRegexRule | CompiledKeywordRule} CompiledRule */

/**
 * @typedef {Object} CompiledPolicy
 * @property {PolicyDocument} document
 * @property {CompiledRule[]} compiled_rules
 */

/**
 * @typedef {Object} PolicyLookup
 * @property {Map<string, CompiledPolicy>} policies
 * @property {Map<string, { policy: CompiledPolicy, rule: PolicyRule }>} rules_by_id
 * @property {string} revision
 * @property {string} loaded_at
 * @property {number} policy_count
 */

/**
 * @typedef {Object} EvaluationContext
 * @property {ApplyTo} apply_to
 * @property {Direction} direction
 */

const VERDICTS = Object.freeze({
  ALLOW: 'ALLOW',
  MASK: 'MASK',
  BLOCK: 'BLOCK',
});

const RULE_TYPES = Object.freeze({
  REGEX: 'regex',
  KEYWORD_HEURISTIC: 'keyword_heuristic',
});

const VERDICT_PRIORITY = Object.freeze({
  ALLOW: 0,
  MASK: 1,
  BLOCK: 2,
});

const NHI_LEGACY_PATTERN = /^[A-HJ-NP-Z]{3}[0-9]{4}$/i;
const NHI_NEW_PATTERN = /^[A-HJ-NP-Z]{3}[0-9]{2}[A-HJ-NP-Z]{2}$/i;

const NHI_LETTER_VALUES = Object.freeze({
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 9, K: 10, L: 11, M: 12, N: 13, P: 14, Q: 15, R: 16,
  S: 17, T: 18, U: 19, V: 20, W: 21, X: 22, Y: 23, Z: 24,
});

const NHI_CHECKSUM_WEIGHTS = Object.freeze([7, 6, 5, 4, 3, 2]);

module.exports = {
  VERDICTS,
  RULE_TYPES,
  VERDICT_PRIORITY,
  NHI_LEGACY_PATTERN,
  NHI_NEW_PATTERN,
  NHI_LETTER_VALUES,
  NHI_CHECKSUM_WEIGHTS,
};
