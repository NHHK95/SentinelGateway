"""
Standalone demonstration of the two data-quality issues identified during
PII injection tool development, and their fixes. Both versions run on the
IDENTICAL sample input for direct, honest comparison.
"""
import re
import random

SAMPLE_RAW_ENRON = """Message-ID: <9624641.1075852700773.JavaMail.evans@thyme>
Date: Fri, 19 Oct 2001 07:23:22 -0700 (PDT)
From: [REDACTED]@enron.com
To: [REDACTED]@enron.com
Subject: Discussion Time
Mime-Version: 1.0
Content-Type: text/plain; charset=us-ascii
X-bcc:
X-Folder: \\Deleted Items
X-Origin: Arnol

John, Please let me know what time to come up this afternoon. Thanks-Jeb x-5-3609"""

TOKEN = "LDC6151"

print("="*70)
print("ISSUE 1: Header-block injection vs. body-only extraction")
print("="*70)

# --- BEFORE: naive word-splice on raw text (headers + body together) ---
def inject_naive(raw_text, token):
    words = raw_text.split(" ")
    insert_at = random.randint(2, len(words) - 2)
    words.insert(insert_at, f"NHI:{token}")
    return " ".join(words)

random.seed(1)
before_1 = inject_naive(SAMPLE_RAW_ENRON, TOKEN)
print("\n--- BEFORE (naive injection into raw MIME text) ---")
print(before_1[:300])

# --- AFTER: extract body first, then inject ---
def extract_email_body(raw_text):
    parts = re.split(r'\r?\n\r?\n', raw_text, maxsplit=1)
    body = parts[1] if len(parts) == 2 else raw_text
    return re.sub(r'\s+', ' ', body).strip()

body_only = extract_email_body(SAMPLE_RAW_ENRON)
print("\n--- AFTER (header stripped first) ---")
print(f"Extracted body: {body_only}")

print()
print("="*70)
print("ISSUE 2: Mid-clause word-splice vs. sentence-boundary needle injection")
print("="*70)

# --- BEFORE: word-splice into body (grammatically broken) ---
random.seed(1)
before_2 = inject_naive(body_only, TOKEN)
print("\n--- BEFORE (mid-clause word splice) ---")
print(before_2)

# --- AFTER: clean needle sentence at sentence boundary ---
NEEDLE_TEMPLATES = [
    "For your reference, the patient's National Health Index number is {token}.",
]

def inject_needle(body, token):
    needle = NEEDLE_TEMPLATES[0].format(token=token)
    sentences = re.split(r'(?<=[.!?])\s+', body)
    if len(sentences) < 2:
        return f"{body} {needle}"
    sentences.insert(len(sentences), needle)
    return " ".join(sentences)

random.seed(1)
after_2 = inject_needle(body_only, TOKEN)
print("\n--- AFTER (needle sentence at sentence boundary) ---")
print(after_2)
