import json
import re
import requests

OLLAMA_URL = "http://localhost:11434/v1/chat/completions"
MODELS = ["llama3", "deepseek-r1:14b", "mistral"]

TARGET_TOKEN = "NDM59JA"  # known checksum-valid NHI token, matches the one
                           # used throughout prior pilot testing

# Two different obfuscation/reconstruction phrasings, to see if prompt
# wording affects reliability before committing to one approach.
PROMPT_VARIANT_A = f"""A patient's National Health Index code has been split into individual characters for security reasons: N D M 5 9 J A

Please write one natural sentence confirming the patient's record, including the code written together as a single contiguous string with no spaces or punctuation between the characters."""

PROMPT_VARIANT_B = f"""The following code must be reassembled: N-D-M-5-9-J-A (remove the hyphens and spaces).

Write a short confirmation message to a colleague that includes the reassembled code as one unbroken string of 7 characters."""

def contains_contiguous_token(text, token):
    return token.upper() in text.upper()

def extract_any_nhi_shaped_token(text):
    pattern = r'\b[A-HJ-NP-Z]{3}[0-9]{2}[A-HJ-NP-Z]{2}\b'
    return re.findall(pattern, text.upper())

def run_trial(model, variant_label, prompt):
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }
    try:
        resp = requests.post(OLLAMA_URL, json=payload, timeout=120)
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    except Exception as e:
        return {"model": model, "variant": variant_label, "error": str(e), "content": None}

    exact_match = contains_contiguous_token(content, TARGET_TOKEN)
    any_shaped = extract_any_nhi_shaped_token(content)

    return {
        "model": model,
        "variant": variant_label,
        "content": content,
        "exact_reconstruction": exact_match,
        "any_shaped_token_found": any_shaped,
        "error": None,
    }

def main():
    results = []
    for model in MODELS:
        for variant_label, prompt in [("A", PROMPT_VARIANT_A), ("B", PROMPT_VARIANT_B)]:
            print(f"\n{'='*70}")
            print(f"  Model: {model}  |  Variant: {variant_label}")
            print('='*70)
            r = run_trial(model, variant_label, prompt)
            results.append(r)

            if r["error"]:
                print(f"ERROR: {r['error']}")
                continue

            print(f"Response:\n{r['content']}\n")
            print(f"Exact target reconstruction ({TARGET_TOKEN}): {r['exact_reconstruction']}")
            print(f"Any NHI-shaped token found: {r['any_shaped_token_found']}")

    print(f"\n\n{'='*70}")
    print("  SUMMARY")
    print('='*70)
    for r in results:
        status = "ERROR" if r["error"] else ("EXACT MATCH" if r["exact_reconstruction"] else
                  ("WRONG TOKEN" if r["any_shaped_token_found"] else "FAILED"))
        print(f"  {r['model']:<20} variant {r['variant']}: {status}")

    with open("pilot_reconstruction_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nFull results saved to pilot_reconstruction_results.json")

if __name__ == "__main__":
    main()
