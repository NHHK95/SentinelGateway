'use strict';

const {
  VERDICTS,
  RULE_TYPES,
  VERDICT_PRIORITY,
  NHI_LEGACY_PATTERN,
  NHI_NEW_PATTERN,
  NHI_LETTER_VALUES,
  NHI_CHECKSUM_WEIGHTS,
} = require('./types');

const NHI_REGEX_HINT = /NHI|AAANNNC|AAANNAX/i;

/**
 * @param {string} token
 * @returns {number|null}
 */
function nhiCharValue(token, index) {
  const char = token[index].toUpperCase();
  if (/[0-9]/.test(char)) {
    return Number(char);
  }
  return NHI_LETTER_VALUES[char] ?? null;
}

/**
 * Validates legacy NHI format (AAANNNC) per HISO 10046:2024 s2.1.4.
 * Weights 7,6,5,4,3,2 on the first six characters; letters A-Z excluding I and O
 * (A=1 ... Z=24). Check digit = 11 - (sum mod 11); a value of 10 is translated
 * to zero; if sum mod 11 is zero the NHI number is invalid.
 * @param {string} token
 * @returns {boolean}
 */
function isValidLegacyNhi(token) {
  if (!NHI_LEGACY_PATTERN.test(token)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 6; i += 1) {
    const value = nhiCharValue(token, i);
    if (value === null) {
      return false;
    }
    sum += value * NHI_CHECKSUM_WEIGHTS[i];
  }

  const remainder = sum % 11;
  if (remainder === 0) {
    return false; // standard: remainder zero => NHI number is invalid
  }
  const calculated = 11 - remainder; // 1..10
  const expected = calculated === 10 ? 0 : calculated; // standard: 10 is translated to zero

  return Number(token[6]) === expected;
}

/**
 * Validates new NHI format (AAANNAC) per HISO 10046:2024 s2.1.3-2.1.4.
 * Same weights and letter values as the legacy format. The sum modulo 23 is
 * subtracted from 23 to give an index number (1..23); the check character is
 * the letter with that index in the 24-letter alphabet (A=1 ... Z=24, no I/O).
 * Note: the standard does not state how a remainder of zero is handled for the
 * new format; it yields index 23 (letter Y) here. See test/nhi_conformance.
 * @param {string} token
 * @returns {boolean}
 */
function isValidNewNhi(token) {
  if (!NHI_NEW_PATTERN.test(token)) {
    return false;
  }

  const upper = token.toUpperCase();
  const body = upper.slice(0, 6);
  const checkChar = upper[6];

  let sum = 0;
  for (let i = 0; i < 6; i += 1) {
    const value = nhiCharValue(body, i);
    if (value === null) {
      return false;
    }
    sum += value * NHI_CHECKSUM_WEIGHTS[i];
  }

  const expectedIndex = 23 - (sum % 23); // 1..23
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const expectedCheck = alphabet[expectedIndex - 1];

  return checkChar === expectedCheck;
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isValidNhiStructure(token) {
  const normalized = token.trim().toUpperCase();
  if (NHI_LEGACY_PATTERN.test(normalized)) {
    return isValidLegacyNhi(normalized);
  }
  if (NHI_NEW_PATTERN.test(normalized)) {
    return isValidNewNhi(normalized);
  }
  return false;
}

/**
 * @param {import('./types').PolicyRule} rule
 * @returns {boolean}
 */
function ruleRequiresNhiValidation(rule) {
  if (rule.rule_id.includes('NHI')) {
    return true;
  }
  if (rule.description && NHI_REGEX_HINT.test(rule.description)) {
    return true;
  }
  if (rule.pattern && /\[A-HJ-NP-Z\]/.test(rule.pattern)) {
    return true;
  }
  return false;
}

/**
 * @param {string[]} [flags]
 * @returns {string}
 */
function compileRegexFlags(flags = []) {
  let compiled = '';
  if (flags.includes('CASE_INSENSITIVE')) {
    compiled += 'i';
  }
  if (flags.includes('MULTILINE')) {
    compiled += 'm';
  }
  if (flags.includes('DOTALL')) {
    compiled += 's';
  }
  return compiled;
}

/**
 * @param {import('./types').PolicyDocument} document
 * @returns {import('./types').CompiledPolicy}
 */
function compilePolicy(document) {
  const compiled_rules = document.rules.map((rule) => {
    if (rule.type === RULE_TYPES.REGEX) {
      return {
        rule,
        compiled_type: RULE_TYPES.REGEX,
        matcher: new RegExp(rule.pattern, compileRegexFlags(rule.flags)),
        validate_nhi: ruleRequiresNhiValidation(rule),
      };
    }

    const case_insensitive = rule.match_config?.case_insensitive !== false;
    const patterns = (rule.patterns ?? []).map((pattern) => (
      case_insensitive ? pattern.toLowerCase() : pattern
    ));

    return {
      rule,
      compiled_type: RULE_TYPES.KEYWORD_HEURISTIC,
      patterns,
      case_insensitive,
      match_any: rule.match_config?.match_any !== false,
    };
  });

  return { document, compiled_rules };
}

/**
 * @param {import('./types').PolicyDocument[]} documents
 * @returns {import('./types').PolicyLookup}
 */
function buildPolicyLookup(documents) {
  /** @type {Map<string, import('./types').CompiledPolicy>} */
  const policies = new Map();
  /** @type {Map<string, { policy: import('./types').CompiledPolicy, rule: import('./types').PolicyRule }>} */
  const rules_by_id = new Map();

  for (const document of documents) {
    const compiled = compilePolicy(document);
    policies.set(document.policy_id, compiled);

    for (const compiledRule of compiled.compiled_rules) {
      rules_by_id.set(compiledRule.rule.rule_id, {
        policy: compiled,
        rule: compiledRule.rule,
      });
    }
  }

  return {
    policies,
    rules_by_id,
    revision: String(Date.now()),
    loaded_at: new Date().toISOString(),
    policy_count: policies.size,
  };
}

/**
 * @param {import('./types').PolicyDocument} policy
 * @param {import('./types').EvaluationContext} context
 * @returns {boolean}
 */
function policyApplies(policy, context) {
  if (policy.status !== 'active') {
    return false;
  }

  const { scope } = policy;
  return scope.apply_to.includes(context.apply_to)
    && scope.directions.includes(context.direction);
}

/**
 * @param {string} payload
 * @param {import('./types').CompiledRegexRule} compiledRule
 * @returns {import('./types').RuleMatch[]}
 */
function evaluateRegexRule(payload, compiledRule) {
  const { matcher, validate_nhi, rule } = compiledRule;
  const flags = matcher.flags.includes('g')
    ? matcher.flags
    : `${matcher.flags}g`;
  const globalMatcher = new RegExp(matcher.source, flags);

  /** @type {import('./types').RuleMatch[]} */
  const matches = [];
  let match = globalMatcher.exec(payload);

  while (match !== null) {
    const value = match[0];
    const structurallyValid = !validate_nhi || isValidNhiStructure(value);

    if (structurallyValid) {
      matches.push({
        value,
        index: match.index,
        length: value.length,
        replacement: rule.mask_config?.replacement,
      });
    }

    if (match.index === globalMatcher.lastIndex) {
      globalMatcher.lastIndex += 1;
    }
    match = globalMatcher.exec(payload);
  }

  return matches;
}

/**
 * @param {string} payload
 * @param {import('./types').CompiledKeywordRule} compiledRule
 * @returns {import('./types').RuleMatch[]}
 */
function evaluateKeywordRule(payload, compiledRule) {
  const haystack = compiledRule.case_insensitive
    ? payload.toLowerCase()
    : payload;

  /** @type {import('./types').RuleMatch[]} */
  const matches = [];

  for (const pattern of compiledRule.patterns) {
    let fromIndex = 0;
    while (fromIndex < haystack.length) {
      const index = haystack.indexOf(pattern, fromIndex);
      if (index === -1) {
        break;
      }

      matches.push({
        value: payload.slice(index, index + pattern.length),
        index,
        length: pattern.length,
      });

      if (compiledRule.match_any) {
        return matches;
      }

      fromIndex = index + pattern.length;
    }
  }

  return matches;
}

/**
 * @param {import('./types').TriggeredRule[]} triggeredRules
 * @returns {import('./types').FrameworkMetadata[]}
 */
function collectFrameworkMetadata(triggeredRules) {
  /** @type {Map<string, import('./types').FrameworkMetadata>} */
  const frameworks = new Map();

  for (const triggered of triggeredRules) {
    for (const mapping of triggered.compliance) {
      const key = `${mapping.framework}::${mapping.reference}`;
      const existing = frameworks.get(key) ?? {
        framework: mapping.framework,
        reference: mapping.reference,
        title: mapping.title,
        policy_ids: [],
        rule_ids: [],
      };

      if (!existing.policy_ids.includes(triggered.policy_id)) {
        existing.policy_ids.push(triggered.policy_id);
      }
      if (!existing.rule_ids.includes(triggered.rule_id)) {
        existing.rule_ids.push(triggered.rule_id);
      }

      frameworks.set(key, existing);
    }
  }

  return [...frameworks.values()];
}

/**
 * @param {string} payload
 * @param {import('./types').RuleMatch[]} matches
 * @param {string} [defaultReplacement='[REDACTED]']
 * @returns {string}
 */
function applyMaskReplacements(payload, matches, defaultReplacement = '[REDACTED]') {
  const sorted = [...matches].sort((a, b) => b.index - a.index);
  let modified = payload;

  for (const match of sorted) {
    const replacement = match.replacement ?? defaultReplacement;
    modified = modified.slice(0, match.index)
      + replacement
      + modified.slice(match.index + match.length);
  }

  return modified;
}

/**
 * @param {import('./types').TriggeredRule[]} triggeredRules
 * @returns {import('./types').Verdict}
 */
function resolveVerdict(triggeredRules) {
  if (triggeredRules.length === 0) {
    return VERDICTS.ALLOW;
  }

  let verdict = VERDICTS.ALLOW;
  for (const triggered of triggeredRules) {
    if (VERDICT_PRIORITY[triggered.action] > VERDICT_PRIORITY[verdict]) {
      verdict = triggered.action;
    }
  }

  return verdict;
}

/**
 * Stateless PDP evaluation loop.
 * @param {string} payload
 * @param {import('./types').EvaluationContext} context
 * @param {import('./types').PolicyLookup} policyLookup
 * @returns {import('./types').DecisionVerdict}
 */
function evaluate(payload, context, policyLookup) {
  /** @type {import('./types').TriggeredRule[]} */
  const triggered_rules = [];

  for (const compiledPolicy of policyLookup.policies.values()) {
    const { document, compiled_rules } = compiledPolicy;
    if (!policyApplies(document, context)) {
      continue;
    }

    for (const compiledRule of compiled_rules) {
      const matches = compiledRule.compiled_type === RULE_TYPES.REGEX
        ? evaluateRegexRule(payload, compiledRule)
        : evaluateKeywordRule(payload, compiledRule);

      if (matches.length === 0) {
        continue;
      }

      triggered_rules.push({
        policy_id: document.policy_id,
        policy_version: document.version,
        rule_id: compiledRule.rule.rule_id,
        rule_name: compiledRule.rule.name,
        rule_type: compiledRule.rule.type,
        action: compiledRule.rule.action,
        risk_weight: compiledRule.rule.risk_weight,
        matches,
        compliance: document.compliance,
      });
    }
  }

  const verdict = resolveVerdict(triggered_rules);
  const risk_score = triggered_rules.reduce(
    (max, rule) => Math.max(max, rule.risk_weight),
    0,
  );

  /** @type {import('./types').DecisionVerdict} */
  const decision = {
    verdict,
    triggered_rules,
    frameworks: collectFrameworkMetadata(triggered_rules),
    risk_score,
    evaluated_at: new Date().toISOString(),
  };

  if (verdict === VERDICTS.MASK) {
    const maskMatches = triggered_rules
      .filter((rule) => rule.action === VERDICTS.MASK)
      .flatMap((rule) => rule.matches);

    decision.modified_payload = applyMaskReplacements(payload, maskMatches);
  }

  return decision;
}

module.exports = {
  compilePolicy,
  buildPolicyLookup,
  evaluate,
  isValidLegacyNhi,
  isValidNewNhi,
  isValidNhiStructure,
};
