"""
================================================================================
MoodSentinel — services/language_detector.py
================================================================================
Detects whether a comment is English, Tagalog, or Taglish (code-switched).

Strategy (hybrid — no hardcoded word lists as primary signal)
-------------------------------------------------------------
1. Run `langdetect` to get tl / en probability scores from its n-gram model.
2. Augment with a compact Tagalog marker set that catches function words and
   particles `langdetect` sometimes misses in short or code-switched text.
3. Decision logic (in priority order):
   a. Dual-language signal from model (both tl_prob > 0.10 AND en_prob > 0.10)
      → "taglish"
   b. Both marker sets fire (tl_hits > 0 AND en_hits > 0)  → "taglish"
   c. Model says English but Tagalog markers are present   → "taglish"
      (handles "Sulit na sulit! Highly recommended." etc.)
   d. tl_prob > en_prob or only Tagalog markers fire       → "tagalog"
   e. Anything else                                        → "english"

Dependencies
------------
    pip install langdetect

The marker sets are intentionally small: they exist to *augment* the
statistical model, not replace it.  Ambiguous English words that also appear
in Filipino text (e.g. "it", "to", "or") are excluded from both sets.
================================================================================
"""

from __future__ import annotations

import re
from typing import Literal

from langdetect import DetectorFactory, LangDetectException, detect_langs

# Fix langdetect's random seed for reproducibility across calls
DetectorFactory.seed = 0

# ── Type alias ────────────────────────────────────────────────────────────────
Language = Literal["english", "tagalog", "taglish"]

# ── Tagalog augmentation markers ──────────────────────────────────────────────
# Function words, particles, and common Tagalog-exclusive words.
# Purpose: catch code-switching and short texts that the n-gram model misses.
# Words that are also common English tokens (e.g. "it", "to", "or") are
# deliberately excluded to avoid false positives.
_TAGALOG_MARKERS: frozenset[str] = frozenset({
    # Pronouns & particles
    "ako", "ko", "mo", "siya", "kami", "tayo", "kayo", "sila",
    "ang", "ng", "mga", "sa", "na", "ay", "nang", "naman",
    "nga", "ba", "raw", "daw", "rin", "din", "po", "ho", "ha",
    # Demonstratives & locatives
    "ito", "iyon", "nito", "nyan", "yun", "yung", "nung",
    "dito", "doon", "diyan",
    # Conjunctions / connectors
    "kasi", "pero", "kaya", "kung", "para", "dahil",
    "pag", "kapag", "kahit", "tsaka", "tapos",
    # Temporal
    "ngayon", "noon", "bukas",
    # Discourse particles / fillers
    "lang", "talaga", "talagang", "sobra", "sobrang", "medyo",
    "parang", "mukhang", "siguro", "halos",
    # Common adjectives / verbs
    "maganda", "ganda", "masaya", "mahal", "sarap", "grabe",
    "ayos", "sulit", "libre",
    # Affirmation / negation
    "oo", "opo", "hindi", "huwag", "wala", "meron", "wag",
    # Common verbs / phrases
    "gusto", "ibig", "dapat", "pwede",
    "lagi", "palagi", "minsan", "madalas",
    # Slang / informal
    "keri", "sus", "charot", "basta", "diba", "sana",
    "ganyan", "ganito",
    # Polite / greeting
    "salamat", "kamusta", "po",
    # Other markers
    "naku", "sige", "tara", "hala", "lupet", "may",
})

# ── English augmentation markers ──────────────────────────────────────────────
# High-frequency English function words absent in standard Filipino.
# Ambiguous words ("it", "to", "or", "and") are excluded.
_ENGLISH_MARKERS: frozenset[str] = frozenset({
    # Articles / determiners
    "the", "this", "that",
    # Pronouns (unambiguous in Filipino context)
    "i", "you", "he", "she", "we", "they",
    "my", "your", "our", "their",
    # Auxiliary / modal verbs
    "is", "are", "was", "were",
    "have", "has", "had",
    "will", "would", "could", "should",
    # Prepositions
    "with", "from", "which", "when", "where", "what",
    # Conjunctions
    "because", "although", "however", "therefore",
    # Common adverbs
    "very", "really", "actually", "basically", "honestly",
    "literally", "definitely", "absolutely", "certainly",
    "probably", "obviously", "seriously",
})

# Minimum probability for a language to be considered "present" in the model output
_TAGLISH_THRESHOLD: float = 0.10

# Pre-compiled tokeniser: normalise punctuation → whitespace
_TOKENISE: re.Pattern[str] = re.compile(r"[^\w\s]")


# ── Public API ────────────────────────────────────────────────────────────────

def detect_language(text: str) -> Language:
    """
    Detect the language of a single comment.

    Parameters
    ----------
    text:
        Raw comment string (may contain emoji, slang, mixed language).

    Returns
    -------
    "english" | "tagalog" | "taglish"
    """
    if not text or not text.strip():
        return "english"

    # --- Marker-based token counts (augmentation layer) ----------------------
    cleaned = _TOKENISE.sub(" ", text.lower())
    tokens = set(cleaned.split())
    tl_hits = len(tokens & _TAGALOG_MARKERS)
    en_hits = len(tokens & _ENGLISH_MARKERS)

    # --- Statistical model (primary signal) ----------------------------------
    try:
        lang_probs = detect_langs(text)
        lang_map: dict[str, float] = {lp.lang: lp.prob for lp in lang_probs}
    except LangDetectException:
        lang_map = {}

    tl_prob = lang_map.get("tl", 0.0)
    en_prob = lang_map.get("en", 0.0)

    # ── Decision tree ─────────────────────────────────────────────────────────

    # 1. Model detects a genuine mix of both languages
    if tl_prob > _TAGLISH_THRESHOLD and en_prob > _TAGLISH_THRESHOLD:
        return "taglish"

    # 2. Both marker sets fired — clear code-switching regardless of model vote
    if tl_hits > 0 and en_hits > 0:
        return "taglish"

    # 3. Model leans English but Tagalog markers are present AND there are enough
    #    tokens to indicate a multi-word, code-switched sentence rather than a
    #    single Tagalog word the n-gram model happened to misclassify.
    #    e.g. "Sulit na sulit! Highly recommended." → taglish
    #    e.g. "grabe" (single token) → tagalog, not taglish
    if tl_hits > 0 and en_prob > 0.5 and len(tokens) >= 3:
        return "taglish"

    # 4. Model or markers point to Tagalog.
    #    Use >= so that when the model is agnostic (both 0.0, e.g. a single
    #    Tagalog slang word it couldn't classify), the marker set breaks the tie.
    if tl_hits > 0 and tl_prob >= en_prob:
        return "tagalog"
    if tl_prob > en_prob and tl_prob > 0.0:
        return "tagalog"

    # 5. Model or markers point to English (or neither fired → safe default)
    return "english"


def detect_batch(texts: list[str]) -> list[Language]:
    """
    Detect language for a list of comments.

    Parameters
    ----------
    texts:
        List of raw comment strings.

    Returns
    -------
    List of language labels in the same order as input.
    """
    return [detect_language(t) for t in texts]


# ── Standalone test ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    samples: list[tuple[str, Language]] = [
        # Original test cases
        ("This product is absolutely amazing!", "english"),
        ("Ang ganda nito, sobrang worth it talaga!", "tagalog"),
        ("Yung delivery was super late pero okay naman ang product.", "taglish"),
        ("Hindi ko talaga inexpect na ganito kaganda.", "tagalog"),
        ("The service was really disappointing honestly.", "english"),
        ("Grabe ang tagal ng shipping, I want a refund!", "taglish"),
        # Edge cases
        ("Okay lang yun", "tagalog"),
        ("wow", "english"),
        ("grabe", "tagalog"),
        ("Salamat po!", "tagalog"),
        ("I love this so much", "english"),
        # Taglish where model misses the switch
        ("Ayos to! Very affordable and the quality is great.", "taglish"),
        ("Sulit na sulit! Highly recommended.", "taglish"),
        ("Maganda ang packaging, very impressed!", "taglish"),
    ]

    print("Language Detection Tests")
    print("=" * 60)
    all_pass = True
    for text, expected in samples:
        result = detect_language(text)
        status = "✅" if result == expected else "❌"
        if result != expected:
            all_pass = False
        print(f"{status}  [{result:8s}] expected={expected:8s} | {text[:55]}")

    print()
    print("All tests passed ✅" if all_pass else "Some tests failed ❌")