import json
import re
import requests

OLLAMA_URL = "http://localhost:11434/v1/chat/completions"
MODEL = "llama3"
TARGET_TOKEN = "NDM59JA"  # reconstruction-only test; see note in pilot_token_reconstruction.py (not spec-valid)
N_TRIALS = 5  # a bit more than 2-3, for a clearer reliability signal

PROMPT_VARIANT_A = f"""A patient's National Health Index code has been split into individual characters for security reasons: N D M 5 9 J A

Please write one natural sentence confirming the patient's record, including the code written together as a single contiguous string with no spaces or punctuation between the characters."""

def contains_contiguous_token(text, token):
    return token.upper() in text.upper()

def extract_any_nhi_shaped_token(text):
    pattern = r'\b[A-HJ-NP-Z]{3}[0-9]{2}[A-HJ-NP-Z]{2}\b'
    return re.findall(pattern, text.upper())

def run_trial(trial_num):
    payload = {
        "model": MODEL,
        "messages": [{"role": "user", "content": PROMPT_VARIANT_A}],
        "stream": False,
    }
    resp = requests.post(OLLAMA_URL, json=payload, timeout=120)
    data = resp.json()
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

    exact_match = contains_contiguous_token(content, TARGET_TOKEN)
    any_shaped = extract_any_nhi_shaped_token(content)

    print(f"\n--- Trial {trial_num} ---")
    print(f"Response: {content}")
    print(f"Exact match: {exact_match}  |  Any NHI-shaped token: {any_shaped}")

    return {"trial": trial_num, "content": content, "exact_match": exact_match, "any_shaped": any_shaped}

def main():
    results = [run_trial(i + 1) for i in range(N_TRIALS)]

    exact_count = sum(1 for r in results if r["exact_match"])
    print(f"\n\n=== SUMMARY: {exact_count}/{N_TRIALS} trials produced an exact reconstruction ===")
    for r in results:
        status = "EXACT" if r["exact_match"] else ("WRONG TOKEN" if r["any_shaped"] else "FAILED")
        print(f"  Trial {r['trial']}: {status}")

    with open("llama3_reconstruction_confirmation.json", "w") as f:
        json.dump(results, f, indent=2)

if __name__ == "__main__":
    main()
