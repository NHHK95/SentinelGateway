import random
import re
import pandas as pd

random.seed(42)

LETTER_VALUES = {
    'A':1,'B':2,'C':3,'D':4,'E':5,'F':6,'G':7,'H':8,
    'J':9,'K':10,'L':11,'M':12,'N':13,'P':14,'Q':15,'R':16,
    'S':17,'T':18,'U':19,'V':20,'W':21,'X':22,'Y':23,'Z':24,
}
LETTERS = list(LETTER_VALUES.keys())
WEIGHTS = [7,6,5,4,3,2]
ALPHABET24 = "ABCDEFGHJKLMNPQRSTUVWXYZ"

def char_value(ch):
    return int(ch) if ch.isdigit() else LETTER_VALUES[ch]

# ---------------------------------------------------------------------------
# NHI check-character generation per HISO 10046:2024 s2.1.4 (Health NZ):
#   weights 7,6,5,4,3,2 on the first six characters; letters A-Z without I and O
#   (A=1 .. Z=24); digits keep their face value.
#   legacy (AAANNNC): check digit = 11 - (sum mod 11); 10 is translated to 0;
#                     sum mod 11 == 0 -> invalid number.
#   new    (AAANNAC): check letter = letter whose index is 23 - (sum mod 23).
# Prefixes whose result sits on an edge case (sum mod 11 == 0, sum mod 23 == 0,
# or legacy result 10) are skipped by the generators so that every valid token
# is valid under the plain rule and every control is invalid under any reading.
# ---------------------------------------------------------------------------
def _wsum(body):
    return sum(char_value(body[i]) * WEIGHTS[i] for i in range(6))

def legacy_check_digit(body):
    """Return the spec check digit for a 6-char legacy body, or None on an edge case."""
    r = _wsum(body) % 11
    if r in (0, 1):          # r == 0 invalid by the standard; r == 1 -> result 10 -> 0 (skipped, edge)
        return None
    return 11 - r

def new_check_letter(body):
    """Return the spec check letter for a 6-char new-format body, or None on an edge case."""
    r = _wsum(body) % 23
    if r == 0:               # index 23 is not addressed by the standard (skipped, edge)
        return None
    return ALPHABET24[(23 - r) - 1]

def _legacy_body():
    letters = [random.choice(LETTERS) for _ in range(3)]
    digits3 = [str(random.randint(0, 9)) for _ in range(3)]
    return letters + digits3

def _new_body():
    letters3 = [random.choice(LETTERS) for _ in range(3)]
    digits2 = [str(random.randint(0, 9)) for _ in range(2)]
    return letters3 + digits2 + [random.choice(LETTERS)]

def gen_valid_legacy():
    while True:
        body = _legacy_body()
        c = legacy_check_digit(body)
        if c is not None:
            return "".join(body) + str(c)

def gen_valid_new():
    while True:
        body = _new_body()
        c = new_check_letter(body)
        if c is not None:
            return "".join(body) + c

def gen_invalid_checksum_legacy():
    while True:
        body = _legacy_body()
        correct = legacy_check_digit(body)
        if correct is None:
            continue
        wrong = random.choice([d for d in range(10) if d != correct])
        return "".join(body) + str(wrong)

def gen_invalid_checksum_new():
    while True:
        body = _new_body()
        correct = new_check_letter(body)
        if correct is None:
            continue
        wrong = random.choice([ch for ch in LETTERS if ch != correct])
        return "".join(body) + wrong

def extract_email_body(raw_text):
    text = str(raw_text)
    parts = re.split(r'\r?\n\r?\n', text, maxsplit=1)
    body = parts[1] if len(parts) == 2 else text
    body = re.sub(r'\s+', ' ', body).strip()
    return body

# ---- "Needle" sentence templates — clean, self-contained, grammatically
# correct regardless of where they land. This is the actual "needle in
# the haystack" approach your Ch.3 methodology names. ----
NEEDLE_TEMPLATES = [
    "For your reference, the patient's National Health Index number is {token}.",
    "Please confirm the NHI number {token} on file before proceeding.",
    "The attached referral lists the NHI as {token}.",
    "Note: NHI {token} needs to be updated in the system.",
    "Can you cross-check NHI {token} against the enrolment record?",
    "The clinic asked us to quote NHI {token} in all correspondence.",
]

def inject_needle(body, token):
    """
    Insert a clean, grammatically self-contained sentence containing the
    token at a random SENTENCE boundary (not mid-clause), so the
    surrounding email text and the injected content each read naturally.
    """
    needle = random.choice(NEEDLE_TEMPLATES).format(token=token)

    # Split on sentence-ending punctuation, keep the delimiters
    sentences = re.split(r'(?<=[.!?])\s+', body)
    if len(sentences) < 2:
        # too short to insert mid-way — just append
        new_text = f"{body} {needle}"
    else:
        insert_at = random.randint(1, len(sentences))  # can go at the very end too
        sentences.insert(insert_at, needle)
        new_text = " ".join(sentences)

    token_start = new_text.index(token)
    return new_text, token_start

def split_for_boundary_test(text, token, token_start):
    split_offset = random.randint(1, min(6, len(token) - 1))
    split_point = token_start + (len(token) - split_offset)
    return text[:split_point], text[split_point:]

def main():
    base = pd.read_csv("processed/compliance_base_texts.csv")

    n = len(base)
    n_boundary = max(1, round(n * 0.2))
    n_invalid = max(1, round(n * 0.2))
    n_valid_plain = n - n_boundary - n_invalid

    tiers = (
        ["valid_plain"] * n_valid_plain +
        ["valid_boundary"] * n_boundary +
        ["invalid_control"] * n_invalid
    )
    random.shuffle(tiers)

    records = []
    skipped = 0
    for i, (_, row) in enumerate(base.iterrows()):
        tier = tiers[i]
        raw_text = str(row["text"])
        body_only = extract_email_body(raw_text)

        if len(body_only) < 40:
            skipped += 1
            continue

        use_new_format = random.random() < 0.5

        if tier == "invalid_control":
            token = gen_invalid_checksum_new() if use_new_format else gen_invalid_checksum_legacy()
            token_valid = False
            expected_verdict = "ALLOW"
        else:
            token = gen_valid_new() if use_new_format else gen_valid_legacy()
            token_valid = True
            expected_verdict = "MASK"

        injected_text, token_start = inject_needle(body_only, token)

        record = {
            "case_id": f"compliance-real-{len(records)+1:02d}",
            "source": row["source"],
            "tier": tier,
            "token": token,
            "token_format": "new" if use_new_format else "legacy",
            "token_valid_checksum": token_valid,
            "expected_verdict": expected_verdict,
            "text": injected_text,
        }

        if tier == "valid_boundary" and token_start is not None:
            chunk_one, chunk_two = split_for_boundary_test(injected_text, token, token_start)
            record["boundary_chunk_one"] = chunk_one
            record["boundary_chunk_two"] = chunk_two

        records.append(record)

    out = pd.DataFrame(records)
    out.to_csv("processed/compliance_injected.csv", index=False)

    print(f"Total injected cases: {len(out)} (skipped {skipped} too-short bodies)")
    print(out["tier"].value_counts())
    print(f"\nSample valid_plain injected body:\n{out[out['tier']=='valid_plain'].iloc[0]['text'][:500]}")
    print(f"\nSample invalid_control injected body:\n{out[out['tier']=='invalid_control'].iloc[0]['text'][:500]}")
    print("DONE")

if __name__ == "__main__":
    main()
