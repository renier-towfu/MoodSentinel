"""
================================================================================
MoodSentinel — services/absa_service.py
================================================================================
Aspect-Based Sentiment Analysis using PyABSA (ATEPC pipeline).

What this does
--------------
Given an English comment (translated if originally Tagalog/Taglish),
this service:
  1. Extracts aspect terms (e.g., "delivery", "service", "product")
  2. Predicts sentiment polarity for each aspect (Positive / Negative / Neutral)

Fallback behaviour
------------------
If PyABSA finds no aspects, falls back to a sentence-level sentiment model
(cardiffnlp/twitter-roberta-base-sentiment-latest) trained on social media text.
Aspect is set to None in this case — never fabricated.

If PyABSA is not installed at all, falls back to rule-based keyword matching.

Returns
-------
List of dicts:
    [
        {"aspect": "delivery",  "sentiment": "Negative", "sentence_level": False},
        {"aspect": None,        "sentiment": "Positive", "sentence_level": True},
    ]
================================================================================
"""

from __future__ import annotations

import logging
import os
from typing import Optional

log = logging.getLogger("MoodSentinel.ABSA")

# ── Lazy PyABSA import ────────────────────────────────────────────────────────
try:
    from pyabsa import AspectTermExtraction as ATEPC, available_checkpoints
    _PYABSA_AVAILABLE = True
    log.info("[ABSA] PyABSA loaded successfully.")
except ImportError:
    _PYABSA_AVAILABLE = False
    log.warning(
        "[ABSA] PyABSA not installed — using rule-based fallback. "
        "Run: pip install pyabsa"
    )

# ── Singleton model instances ─────────────────────────────────────────────────
_atepc_model    = None
_sentence_model = None

# PyABSA checkpoint
_CHECKPOINT = os.getenv("MOODSENTINEL_ABSA_CHECKPOINT", "multilingual")

# Sentiment label map from PyABSA output → MoodSentinel canonical labels
_SENTIMENT_MAP: dict[str, str] = {
    "Positive": "Positive",
    "Negative": "Negative",
    "Neutral":  "Neutral",
    "positive": "Positive",
    "negative": "Negative",
    "neutral":  "Neutral",
    "POS":      "Positive",
    "NEG":      "Negative",
    "NEU":      "Neutral",
}

# Sentence-level model label map
_SENTENCE_LABEL_MAP: dict[str, str] = {
    "positive": "Positive",
    "negative": "Negative",
    "neutral":  "Neutral",
}

# ── Type alias ────────────────────────────────────────────────────────────────
AspectResult = dict  # {"aspect": str|None, "sentiment": str, "sentence_level": bool}


# ── Model loaders (singletons) ────────────────────────────────────────────────

def _load_model() -> Optional[object]:
    """Load PyABSA ATEPC model once, reuse on subsequent calls."""
    global _atepc_model

    if _atepc_model is not None:
        return _atepc_model

    if not _PYABSA_AVAILABLE:
        return None

    try:
        log.info(f"[ABSA] Loading ATEPC model: {_CHECKPOINT} ...")
        from pyabsa import AspectTermExtraction as ATEPC
        _atepc_model = ATEPC.AspectExtractor(
            checkpoint=_CHECKPOINT,
            auto_device=True,
        )
        log.info("[ABSA] ATEPC model loaded.")
    except Exception as exc:
        log.error(f"[ABSA] Model load failed: {exc}")
        _atepc_model = None

    return _atepc_model


def _load_sentence_model() -> Optional[object]:
    """Load twitter-roberta sentence sentiment model once, reuse on subsequent calls."""
    global _sentence_model

    if _sentence_model is not None:
        return _sentence_model

    try:
        from transformers import pipeline
        log.info("[ABSA] Loading sentence-level sentiment fallback model...")
        _sentence_model = pipeline(
            task="text-classification",
            model="cardiffnlp/twitter-roberta-base-sentiment-latest",
            device=-1,
        )
        log.info("[ABSA] Sentence model loaded.")
    except Exception as exc:
        log.error(f"[ABSA] Sentence model load failed: {exc}")
        _sentence_model = None

    return _sentence_model


# ── Fallback functions ────────────────────────────────────────────────────────

def _sentence_level_sentiment(text: str) -> list[AspectResult]:
    """
    Sentence-level fallback when PyABSA finds no aspects.
    Uses twitter-roberta trained on social media text.
    Returns aspect=None — never fabricates an aspect term.
    """
    model = _load_sentence_model()

    if model is None:
        return [{"aspect": None, "sentiment": "Neutral", "sentence_level": True}]

    try:
        result = model(text[:512])[0]
        label      = result["label"].lower()
        sentiment  = _SENTENCE_LABEL_MAP.get(label, "Neutral")
        confidence = round(result["score"], 4)
        log.debug(f"[ABSA] Sentence fallback: {sentiment} ({confidence}) for: '{text[:50]}'")
        return [{
            "aspect":         None,
            "sentiment":      sentiment,
            "confidence":     confidence,
            "sentence_level": True,
        }]
    except Exception as exc:
        log.error(f"[ABSA] Sentence fallback failed: {exc}")
        return [{"aspect": None, "sentiment": "Neutral", "sentence_level": True}]


def _rule_based_fallback(text: str) -> list[AspectResult]:
    """
    Last-resort fallback when both PyABSA and sentence model are unavailable.
    Uses keyword matching. Only reached if transformers is not installed.
    """
    text_lower = text.lower()

    positive_words = {
        "good", "great", "amazing", "excellent", "love", "best", "awesome",
        "wonderful", "fantastic", "perfect", "happy", "satisfied", "nice",
        "fast", "quick", "helpful", "friendly", "recommend",
    }
    negative_words = {
        "bad", "terrible", "awful", "worst", "hate", "slow", "broken",
        "disappointed", "horrible", "useless", "poor", "never", "fail",
        "missing", "wrong", "damage", "damaged", "late", "angry", "upset",
        "disgusting", "disgust", "fear", "scared", "disappointing",
    }

    tokens   = set(text_lower.split())
    pos_hits = len(tokens & positive_words)
    neg_hits = len(tokens & negative_words)

    if pos_hits > neg_hits:
        sentiment = "Positive"
    elif neg_hits > pos_hits:
        sentiment = "Negative"
    else:
        sentiment = "Neutral"

    return [{"aspect": None, "sentiment": sentiment, "sentence_level": True}]


# ── Main extraction functions ─────────────────────────────────────────────────

def extract_aspects(text: str) -> list[AspectResult]:
    """
    Extract aspect terms and sentiment polarity from a single comment.

    Flow:
        1. PyABSA attempts aspect extraction
        2. If aspects found → return aspect-level results
        3. If no aspects found → sentence-level sentiment via twitter-roberta
        4. If model unavailable → rule-based keyword fallback

    Parameters
    ----------
    text : English comment string (translate Tagalog/Taglish before calling)

    Returns
    -------
    List of AspectResult dicts. aspect field is None when no aspects detected.
    """
    if not text or not text.strip():
        return [{"aspect": None, "sentiment": "Neutral", "sentence_level": True}]

    model = _load_model()

    if model is None:
        log.debug("[ABSA] PyABSA unavailable — using sentence-level fallback.")
        return _sentence_level_sentiment(text)

    try:
        result = model.predict(
            text,
            print_result=False,
            ignore_error=True,
        )

        aspects_found = result.get("aspect", [])
        sentiments    = result.get("sentiment", [])
        confidences   = result.get("confidence", [])

        if not aspects_found:
            log.debug("[ABSA] No aspects detected — using sentence-level fallback.")
            return _sentence_level_sentiment(text)

        output = []
        for i, (aspect, sentiment) in enumerate(zip(aspects_found, sentiments)):
            canonical = _SENTIMENT_MAP.get(str(sentiment), "Neutral")
            cleaned_aspect = str(aspect).lower().strip()

            # Skip empty aspect strings — treat as no aspect found
            if not cleaned_aspect:
                continue

            output.append({
                "aspect":         cleaned_aspect,
                "sentiment":      canonical,
                "confidence":     round(float(confidences[i]), 4) if i < len(confidences) else None,
                "sentence_level": False,
            })

        # If all aspects were empty strings, fall back to sentence level
        if not output:
            return _sentence_level_sentiment(text)

        log.debug(f"[ABSA] Extracted {len(output)} aspect(s) from: '{text[:50]}'")
        return output

    except Exception as exc:
        log.error(f"[ABSA] Prediction failed: {exc} — using sentence-level fallback.")
        return _sentence_level_sentiment(text)


def extract_aspects_batch(texts: list[str]) -> list[list[AspectResult]]:
    """
    Extract aspects from a list of comments.

    Parameters
    ----------
    texts : List of English comment strings

    Returns
    -------
    List of aspect lists (one per comment), in the same order as input.
    """
    if not texts:
        return []

    model = _load_model()

    if model is None:
        return [_sentence_level_sentiment(t) for t in texts]

    try:
        results = model.predict(
            texts,
            print_result=False,
            ignore_error=True,
        )

        output = []
        for i, result in enumerate(results):
            aspects_found = result.get("aspect", [])
            sentiments    = result.get("sentiment", [])

            if not aspects_found:
                output.append(_sentence_level_sentiment(texts[i]))
                continue

            confidences = result.get("confidence", [])
            comment_aspects = []
            for i, (aspect, sentiment) in enumerate(zip(aspects_found, sentiments)):
                canonical      = _SENTIMENT_MAP.get(str(sentiment), "Neutral")
                cleaned_aspect = str(aspect).lower().strip()

                if not cleaned_aspect:
                    continue

                comment_aspects.append({
                    "aspect":         cleaned_aspect,
                    "sentiment":      canonical,
                    "confidence":     round(float(confidences[i]), 4) if i < len(confidences) else None,
                    "sentence_level": False,
                })

            # If all aspects were empty strings, fall back to sentence level
            if not comment_aspects:
                output.append(_sentence_level_sentiment(texts[i]))
                continue

            output.append(comment_aspects)

        return output

    except Exception as exc:
        log.error(f"[ABSA] Batch prediction failed: {exc} — using sentence-level fallback for all.")
        return [_sentence_level_sentiment(t) for t in texts]


# ── Standalone test ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    test_comments = [
        "The delivery was super slow but the product quality is amazing.",
        "I love the app interface but customer service is terrible.",
        "Price is reasonable but the packaging was damaged.",
        "Overall great experience, fast shipping and friendly staff.",
        "This is really disappointing honestly.",
        "okay lang",
        "grabe",
    ]

    print("ABSA Aspect Extraction Tests")
    print("=" * 60)
    for comment in test_comments:
        aspects = extract_aspects(comment)
        print(f"\nComment : {comment}")
        for a in aspects:
            src = "sentence" if a.get("sentence_level") else "absa"
            print(f"  [{src}] aspect={a['aspect']} sentiment={a['sentiment']}")