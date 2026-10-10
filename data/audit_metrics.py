#!/usr/bin/env python3
"""
Independent recalculation of the evaluation metrics from the per-case records.

Purpose (thesis action item 3, part E): every reported figure must have a stated
formula, numerator, denominator and eligible sample, and must be reproducible from
the raw per-case records rather than from the harness's own summary block.

Reads (all under data/processed/):
  realworld_cases.json                       ground-truth labels ('expected', 'category', 'tier')
  realworld_results.json                     Chapter 5 per-case observations
  realworld_results_<model>.json             Chapter 6 request-path observations (3 models)
  response_masking_results_<model>.json      Chapter 6 response-masking trials (3 models)

Writes:
  processed/metrics_audit.json               audit trail (inputs, definitions, counts, metrics)

Run from the data/ folder:   python3 audit_metrics.py
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROC = os.path.join(HERE, "processed")


def load(name):
    with open(os.path.join(PROC, name), encoding="utf-8") as f:
        return json.load(f)


def wilson(k, n, z=1.96):
    """95% Wilson score interval for a proportion k/n (returned as percentages)."""
    if n == 0:
        return None
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [round(100 * max(0.0, centre - half), 2), round(100 * min(1.0, centre + half), 2)]


def rate(k, n):
    return {
        "numerator": k,
        "denominator": n,
        "percent": None if n == 0 else round(100 * k / n, 2),
        "wilson95": wilson(k, n),
    }


def results_of(obj):
    return obj["results"] if isinstance(obj, dict) else obj


# ---------------------------------------------------------------------------
# Chapter 5 / Chapter 6 request path: original (frozen harness) vs corrected
# ---------------------------------------------------------------------------
def request_path_metrics(results):
    comp = [r for r in results if r["category"] == "compliance"]
    adv = [r for r in results if r["category"] == "adversarial"]

    must_mask = [r for r in comp if r["expected"] == "MASK"]
    must_allow = [r for r in comp if r["expected"] == "ALLOW"]
    tp_c = sum(r["observed"] == "MASK" for r in must_mask)
    fn_c = len(must_mask) - tp_c
    tn_c = sum(r["observed"] == "ALLOW" for r in must_allow)
    fp_c = len(must_allow) - tn_c
    tp_a = sum(r["observed"] == "BLOCK" for r in adv)
    fn_a = len(adv) - tp_a

    # What the frozen computeMetrics() did: every non-MASK compliance outcome counts as FN,
    # ignoring the per-case 'expected' label.
    orig_fn_c = sum(r["observed"] != "MASK" for r in comp)
    orig_tp = tp_c + tp_a
    orig_den = len(comp) + len(adv)

    affected = sorted(r["id"] for r in must_allow if r["observed"] == "ALLOW")

    violations = len(must_mask) + len(adv)
    tp = tp_c + tp_a
    return {
        "cases": {"compliance": len(comp), "compliance_expected_MASK": len(must_mask),
                  "compliance_expected_ALLOW": len(must_allow), "adversarial": len(adv)},
        "confusion": {"TP_compliance": tp_c, "FN_compliance": fn_c, "TN_compliance": tn_c,
                      "FP_compliance": fp_c, "TP_adversarial": tp_a, "FN_adversarial": fn_a},
        "original_frozen_computeMetrics": {
            "PCR_equals_Recall": rate(orig_tp, orig_den),
            "compliance_accuracy": rate(tp_c, len(comp)),
            "FN_compliance_as_counted": orig_fn_c,
            "note": "invalid_control successes were counted as false negatives",
        },
        "invalid_control_cases_affected": affected,
        "corrected": {
            "recall": dict(rate(tp, violations),
                           formula="(TP_compliance + TP_adversarial) / (compliance cases expecting MASK + adversarial cases)"),
            "PCR": dict(rate(tp, violations), formula="identical to recall by definition (see note)"),
            "ARR": dict(rate(tp_a, len(adv)), formula="TP_adversarial / adversarial cases"),
            "compliance_masking_recall": dict(rate(tp_c, len(must_mask)), formula="TP_compliance / compliance cases expecting MASK"),
            "true_negative_rate_controls": dict(rate(tn_c, len(must_allow)), formula="TN_compliance / invalid_control cases"),
            "compliance_accuracy": dict(rate(tp_c + tn_c, len(comp)), formula="(TP_compliance + TN_compliance) / all compliance cases"),
            "FDR": "undefined: no benign category in this dataset (denominator FP + TP counts only violation cases; benign N = 0)",
        },
        "PCR_equals_recall": True,
        "note": "With the corrected violation denominator, PCR and recall have the same numerator and the same denominator.",
    }


def response_masking(model_blob):
    res = results_of(model_blob)
    masked = sum(r["observed"] == "MASKED" for r in res)
    leaked = sum(r["observed"] == "LEAKED" for r in res)
    failed = sum(r["observed"] == "RECONSTRUCTION_FAILED" for r in res)
    other = len(res) - masked - leaked - failed
    eligible = masked + leaked
    return {
        "trials": len(res),
        "eligible_reproduced": eligible,
        "not_eligible_reconstruction_failed": failed,
        "success_masked": masked,
        "failure_leaked": leaked,
        "other": other,
        "masking_rate_among_eligible": rate(masked, eligible),
        "leaked_token_visible_in_output": [r["token"] for r in res if r["token"] in r.get("assembledContent", "")],
    }


def main():
    out = {"inputs": {}, "chapter5": None, "chapter6_request_path": {}, "chapter6_response_masking": {}}

    cases = load("realworld_cases.json")
    labels = {c["id"]: c for c in cases}
    ch5 = results_of(load("realworld_results.json"))
    # check ground truth in the results file equals the cases file
    mism = [r["id"] for r in ch5 if labels[r["id"]]["expected"] != r["expected"]]
    out["inputs"]["ch5_cases"] = len(cases)
    out["inputs"]["ch5_results"] = len(ch5)
    out["inputs"]["label_mismatches_between_cases_and_results"] = mism
    out["chapter5"] = request_path_metrics(ch5)

    for model, fname in (("llama3", "llama3"), ("deepseek-r1:14b", "deepseek-r1_14b"), ("mistral", "mistral")):
        out["chapter6_request_path"][model] = request_path_metrics(results_of(load(f"realworld_results_{fname}.json")))
        out["chapter6_response_masking"][model] = response_masking(load(f"response_masking_results_{fname}.json"))

    tot = {"trials": 0, "eligible": 0, "masked": 0, "leaked": 0, "not_eligible": 0}
    for m in out["chapter6_response_masking"].values():
        tot["trials"] += m["trials"]; tot["eligible"] += m["eligible_reproduced"]
        tot["masked"] += m["success_masked"]; tot["leaked"] += m["failure_leaked"]
        tot["not_eligible"] += m["not_eligible_reconstruction_failed"]
    tot["masking_rate_among_eligible"] = rate(tot["masked"], tot["eligible"])
    out["chapter6_response_masking"]["pooled"] = tot

    path = os.path.join(PROC, "metrics_audit.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    c5 = out["chapter5"]
    print("=" * 74)
    print(" Metrics audit: recomputed from per-case records")
    print("=" * 74)
    print(f"Ch.5 cases: {out['inputs']['ch5_results']}  label mismatches: {len(mism)}")
    print(f"  confusion          : {c5['confusion']}")
    o = c5["original_frozen_computeMetrics"]
    print(f"  ORIGINAL PCR=Recall: {o['PCR_equals_Recall']['numerator']}/{o['PCR_equals_Recall']['denominator']} = {o['PCR_equals_Recall']['percent']}%")
    print(f"  invalid_control cases affected by the correction: {len(c5['invalid_control_cases_affected'])} {c5['invalid_control_cases_affected']}")
    for k in ("recall", "PCR", "ARR", "compliance_masking_recall", "true_negative_rate_controls", "compliance_accuracy"):
        v = c5["corrected"][k]
        print(f"  CORRECTED {k:<28}: {v['numerator']}/{v['denominator']} = {v['percent']}%  Wilson95 {v['wilson95']}")
    print()
    for m, v in out["chapter6_request_path"].items():
        r = v["corrected"]["recall"]
        a = v["corrected"]["ARR"]
        print(f"Ch.6 request path {m:<16}: recall {r['numerator']}/{r['denominator']} = {r['percent']}%   ARR {a['numerator']}/{a['denominator']} = {a['percent']}%")
    print()
    for m, v in out["chapter6_response_masking"].items():
        if m == "pooled":
            print(f"Ch.6 response masking pooled: trials {v['trials']}, eligible {v['eligible']}, masked {v['masked']}, leaked {v['leaked']}, not eligible {v['not_eligible']}, rate {v['masking_rate_among_eligible']['percent']}% Wilson95 {v['masking_rate_among_eligible']['wilson95']}")
        else:
            print(f"Ch.6 response masking {m:<16}: eligible {v['eligible_reproduced']}, masked {v['success_masked']}, leaked {v['failure_leaked']}, not eligible {v['not_eligible_reconstruction_failed']}")
    print(f"\nWrote {path}")


if __name__ == "__main__":
    sys.exit(main())
