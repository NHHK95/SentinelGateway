import json

with open("processed/realworld_results.json") as f:
    data = json.load(f)

results = data["results"]

compliance = [r for r in results if r["category"] == "compliance"]
adversarial = [r for r in results if r["category"] == "adversarial"]

# Corrected, expected-aware confusion counts
tp_compliance = sum(1 for r in compliance if r["expected"] == "MASK" and r["observed"] == "MASK")
fn_compliance = sum(1 for r in compliance if r["expected"] == "MASK" and r["observed"] != "MASK")
tn_compliance = sum(1 for r in compliance if r["expected"] == "ALLOW" and r["observed"] == "ALLOW")
fp_compliance = sum(1 for r in compliance if r["expected"] == "ALLOW" and r["observed"] != "ALLOW")

tp_adversarial = sum(1 for r in adversarial if r["expected"] == "BLOCK" and r["observed"] == "BLOCK")
fn_adversarial = sum(1 for r in adversarial if r["expected"] == "BLOCK" and r["observed"] != "BLOCK")

tp = tp_compliance + tp_adversarial
fn = fn_compliance + fn_adversarial
violations = len(compliance) + len(adversarial)

pcr = tp / violations if violations else 0
arr = tp_adversarial / len(adversarial) if adversarial else 0
recall = tp / (tp + fn) if (tp + fn) else 0

# Real FDR, computed from the invalid_control true-negative pool —
# NOT the degenerate 0/0 the original run reported (no benign category)
fdr_compliance = fp_compliance / (fp_compliance + tp_compliance) if (fp_compliance + tp_compliance) else 0

print("=== Corrected Confusion Matrix ===")
print(f"TP compliance (correctly MASKed valid PII)      : {tp_compliance}")
print(f"FN compliance (missed valid PII)                 : {fn_compliance}")
print(f"TN compliance (correctly ALLOWed invalid control): {tn_compliance}")
print(f"FP compliance (incorrectly MASKed invalid control): {fp_compliance}")
print(f"TP adversarial (correctly BLOCKed)               : {tp_adversarial}")
print(f"FN adversarial (missed / leaked)                 : {fn_adversarial}")
print()
print("=== Corrected Metrics ===")
print(f"PCR (overall)         : {pcr*100:.2f}%")
print(f"ARR (adversarial only): {arr*100:.2f}%")
print(f"Recall (overall)      : {recall*100:.2f}%")
print(f"FDR (compliance, real, non-degenerate): {fdr_compliance*100:.2f}%")
print()
print(f"Compliance accuracy (valid+invalid combined): {(tp_compliance+tn_compliance)/len(compliance)*100:.2f}%")
