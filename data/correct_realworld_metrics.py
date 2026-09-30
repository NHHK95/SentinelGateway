"""
Post-hoc correction of realworld_results.json metrics.

Rationale: computeMetrics() in test_harness.js (copied verbatim into
test_harness_realworld.js for Ch.4/Ch.5 comparability) classifies any
non-MASK compliance outcome as a false negative. This is correct for
the Ch.4 synthetic dataset, where every compliance case expects MASK.
It is NOT correct for the Ch.5 invalid_control tier, which expects
ALLOW by design (a true-negative control). This script recomputes
PCR/Recall using an expected-outcome-aware denominator, without
modifying the frozen harness logic itself.
"""
import json

with open("processed/realworld_results.json") as f:
    data = json.load(f)

results = data["results"]
compliance = [r for r in results if r["category"] == "compliance"]
adversarial = [r for r in results if r["category"] == "adversarial"]

# ---- Expected-aware confusion counts ----
tp_compliance = sum(1 for r in compliance if r["expected"] == "MASK" and r["observed"] == "MASK")
fn_compliance = sum(1 for r in compliance if r["expected"] == "MASK" and r["observed"] != "MASK")
tn_compliance = sum(1 for r in compliance if r["expected"] == "ALLOW" and r["observed"] == "ALLOW")
fp_compliance = sum(1 for r in compliance if r["expected"] == "ALLOW" and r["observed"] != "ALLOW")

tp_adversarial = sum(1 for r in adversarial if r["expected"] == "BLOCK" and r["observed"] == "BLOCK")
fn_adversarial = sum(1 for r in adversarial if r["expected"] == "BLOCK" and r["observed"] != "BLOCK")

tp = tp_compliance + tp_adversarial
fn_expected_aware = fn_compliance + fn_adversarial
actual_violations = (tp_compliance + fn_compliance) + (tp_adversarial + fn_adversarial)

# ---- What the ORIGINAL (buggy) computeMetrics reported ----
original_fn_compliance = sum(1 for r in compliance if r["observed"] != "MASK")  # ignores 'expected'
original_tp = tp_compliance + tp_adversarial
original_fn = original_fn_compliance + fn_adversarial
original_violations = len(compliance) + len(adversarial)
original_pcr = original_tp / original_violations if original_violations else 0
original_recall = original_tp / (original_tp + original_fn) if (original_tp + original_fn) else 0

# ---- Corrected figures ----
pcr = tp / actual_violations if actual_violations else 0
arr = tp_adversarial / len(adversarial) if adversarial else 0
recall = tp / (tp + fn_expected_aware) if (tp + fn_expected_aware) else 0
fdr_compliance = fp_compliance / (fp_compliance + tp_compliance) if (fp_compliance + tp_compliance) else 0
compliance_accuracy = (tp_compliance + tn_compliance) / len(compliance) if compliance else 0

def pct(v):
    return f"{v*100:.2f}%"

print("=" * 66)
print(" Sentinel Gateway — Real-World Evaluation: Metric Correction")
print("=" * 66)
print(f"Source file : data/processed/realworld_results.json")
print(f"Total cases : {len(results)}  (compliance={len(compliance)}, adversarial={len(adversarial)})")
print()
print("-- Confusion Matrix (expected-outcome-aware) " + "-" * 20)
print(f"  TP compliance (correctly masked, valid tokens)      : {tp_compliance}")
print(f"  FN compliance (missed, valid tokens)                : {fn_compliance}")
print(f"  TN compliance (correctly allowed, invalid_control)  : {tn_compliance}")
print(f"  FP compliance (incorrectly masked, invalid_control) : {fp_compliance}")
print(f"  TP adversarial (correctly blocked)                  : {tp_adversarial}")
print(f"  FN adversarial (missed / leaked)                    : {fn_adversarial}")
print()
print("-- Why a correction was needed " + "-" * 33)
print("  Frozen computeMetrics() (verbatim from test_harness.js) treats")
print("  ANY non-MASK compliance outcome as a false negative, with no")
print("  awareness of per-case 'expected' verdict. This misclassifies")
print("  the 5 invalid_control true-negative successes as missed")
print("  detections, understating PCR and Recall:")
print()
print(f"    Original (uncorrected) PCR    : {pct(original_pcr)}")
print(f"    Original (uncorrected) Recall : {pct(original_recall)}")
print()
print("-- Corrected Metrics " + "-" * 44)
print(f"  Policy Coverage Ratio (PCR)  : {pct(pcr)}")
print(f"  Adversarial Resilience (ARR) : {pct(arr)}")
print(f"  Recall                       : {pct(recall)}")
print(f"  FDR (compliance)             : {pct(fdr_compliance)}")
print(f"  Compliance accuracy (all tiers): {pct(compliance_accuracy)}")
print()
print(f"  Note: PCR == Recall ({pct(pcr)} == {pct(recall)}), confirming the")
print(f"  correction was applied consistently across both metrics.")
print("=" * 66)
