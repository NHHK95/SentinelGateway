import json
import re
import random
import pandas as pd

random.seed(42)  # reproducibility — record this seed in your methodology write-up

# ---- Config: adjust these if you want a different final N ----
N_ADVERSARIAL_HIJACK = 12
N_ADVERSARIAL_EXTRACT = 10
N_ADVERSARIAL_JAILBREAK = 8
N_COMPLIANCE_ENRON = 30
# Total adversarial N = 30, matching/exceeding your Ch.4 baseline of N=20

# ---- Load your existing policy patterns for auto-tagging ----
# Adjust this path if your policies folder sits elsewhere relative to this script
POLICY_PATH = "../policies/pol_adv_injection_01.json"

with open(POLICY_PATH) as f:
    policy = json.load(f)

all_patterns = []
for rule in policy["rules"]:
    for pattern in rule.get("patterns", []):
        all_patterns.append((rule["rule_id"], pattern.lower()))

def tag_matches(text):
    text_lower = str(text).lower()
    hits = [rule_id for rule_id, pattern in all_patterns if pattern in text_lower]
    return hits

def looks_obfuscated(text):
    # crude heuristic: long base64-ish run, or explicit rot13/hex mentions
    text_str = str(text)
    has_long_b64 = bool(re.search(r'[A-Za-z0-9+/]{40,}={0,2}', text_str))
    mentions_encoding = bool(re.search(r'\b(base64|rot13|hex(?:adecimal)?)\b', text_str, re.I))
    return has_long_b64 or mentions_encoding

# ---- TensorTrust: hijacking ----
hijack_df = pd.read_csv("raw/tensortrust/tensortrust_hijacking_robustness.csv")
hijack_df = hijack_df.dropna(subset=["attack"])
hijack_df = hijack_df[hijack_df["attack"].str.len().between(20, 2000)]
hijack_sample = hijack_df.sample(n=min(N_ADVERSARIAL_HIJACK, len(hijack_df)), random_state=42).copy()
hijack_sample["source"] = "tensortrust_hijacking"
hijack_sample["text"] = hijack_sample["attack"]
hijack_sample["expected_verdict"] = "BLOCK"

# ---- TensorTrust: extraction ----
extract_df = pd.read_csv("raw/tensortrust/tensortrust_extraction_robustness.csv")
extract_df = extract_df.dropna(subset=["attack"])
extract_df = extract_df[extract_df["attack"].str.len().between(20, 2000)]
extract_sample = extract_df.sample(n=min(N_ADVERSARIAL_EXTRACT, len(extract_df)), random_state=43).copy()
extract_sample["source"] = "tensortrust_extraction"
extract_sample["text"] = extract_sample["attack"]
extract_sample["expected_verdict"] = "BLOCK"

# ---- Jailbreak Chat ----
jbc_df = pd.read_csv("raw/jailbreak_chat/jailbreak_chat_subset.csv")
jbc_df = jbc_df.dropna(subset=["prompt"])
jbc_sample = jbc_df.sample(n=min(N_ADVERSARIAL_JAILBREAK, len(jbc_df)), random_state=44).copy()
jbc_sample["source"] = "jailbreak_chat"
jbc_sample["text"] = jbc_sample["prompt"]
jbc_sample["expected_verdict"] = "BLOCK"

# ---- Combine adversarial pool and auto-tag ----
adversarial = pd.concat([
    hijack_sample[["source", "text", "expected_verdict"]],
    extract_sample[["source", "text", "expected_verdict"]],
    jbc_sample[["source", "text", "expected_verdict"]],
], ignore_index=True)

adversarial["matched_rule_ids"] = adversarial["text"].apply(tag_matches)
adversarial["matched_existing_pattern"] = adversarial["matched_rule_ids"].apply(lambda x: len(x) > 0)
adversarial["looks_obfuscated"] = adversarial["text"].apply(looks_obfuscated)
adversarial["case_id"] = ["adv-real-%02d" % (i + 1) for i in range(len(adversarial))]

adversarial.to_csv("processed/adversarial_sample.csv", index=False)

print(f"Adversarial sample: {len(adversarial)} total")
print(adversarial["source"].value_counts())
print(f"\nPrompts matching an EXISTING policy pattern: {adversarial['matched_existing_pattern'].sum()}")
print(f"Prompts NOT matching any existing pattern (novel phrasing): {(~adversarial['matched_existing_pattern']).sum()}")
print(f"Prompts flagged as possibly obfuscated: {adversarial['looks_obfuscated'].sum()}")

# ---- Enron compliance/PII base texts ----
enron_df = pd.read_csv("raw/enron/enron_sample_100.csv")
# Adjust column name below if your Enron export uses a different body column
text_col = "message" if "message" in enron_df.columns else enron_df.columns[-1]
enron_df = enron_df.dropna(subset=[text_col])
enron_df = enron_df[enron_df[text_col].str.len().between(100, 3000)]
enron_sample = enron_df.sample(n=min(N_COMPLIANCE_ENRON, len(enron_df)), random_state=45).copy()
enron_sample["source"] = "enron"
enron_sample["text"] = enron_sample[text_col]
enron_sample["case_id"] = ["compliance-real-%02d" % (i + 1) for i in range(len(enron_sample))]

enron_sample[["case_id", "source", "text"]].to_csv("processed/compliance_base_texts.csv", index=False)

print(f"\nEnron compliance base texts sampled: {len(enron_sample)}")
print("DONE")
