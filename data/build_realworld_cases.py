"""Rebuild the compliance entries of processed/realworld_cases.json from
processed/compliance_injected.csv, keeping the adversarial entries untouched.

The original conversion step was not committed; this script reproduces it
(verified: running it on the pre-fix CSV regenerates the pre-fix JSON exactly).
Run after inject_pii.py:   python3 build_realworld_cases.py
"""
import csv, json, sys

CSV_PATH = "processed/compliance_injected.csv"
CASES_PATH = "processed/realworld_cases.json"

def build(csv_path=CSV_PATH, cases_path=CASES_PATH):
    cases = json.load(open(cases_path))
    adversarial = [c for c in cases if c["category"] == "adversarial"]
    compliance = []
    for r in csv.DictReader(open(csv_path, newline="")):
        compliance.append({
            "id": r["case_id"],
            "category": "compliance",
            "content": r["text"],
            "stream": True,
            "model": "mock/echo-request",
            "secrets": [r["token"]],
            "expected": r["expected_verdict"],
            "source": r["source"],
            "tier": r["tier"],
        })
    return adversarial + compliance

if __name__ == "__main__":
    out = build()
    json.dump(out, open(CASES_PATH, "w"), indent=2, ensure_ascii=False)
    print(f"wrote {len(out)} cases to {CASES_PATH}")
