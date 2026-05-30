"""
================================================================================
MoodSentinel — services/emotion_service.py
================================================================================
Emotion classification using j-hartmann/emotion-english-distilroberta-base
loaded directly from HuggingFace (downloads once, then cached).

FIX (confidence separation):
         - classify_emotions() now writes emotion confidence to "emotion_conf" key
         - "confidence" key (ABSA/roberta sentiment confidence) is NEVER overwritten
         - CommentCard.js displays both separately as "X% sent" and "X% emo"
================================================================================
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import torch

log = logging.getLogger("MoodSentinel.Emotion")

# ── FIX: use HuggingFace model ID, not a local path ──────────────────────────
_MODEL_ID = "j-hartmann/emotion-english-distilroberta-base"

# Optional: cache inside your project folder instead of ~/.cache/huggingface
# Uncomment the line below if you want that:
# os.environ["TRANSFORMERS_CACHE"] = os.path.join(
#     os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
#     "models", "cache"
# )

_LABEL_MAP: dict[str, str] = {
    "anger":    "Anger",
    "disgust":  "Disgust",
    "fear":     "Fear",
    "joy":      "Happiness",
    "neutral":  "Neutral",
    "sadness":  "Sadness",
    "surprise": "Surprise",
}

_model     = None
_tokenizer = None


def _load_model():
    global _model, _tokenizer
    if _model is not None:
        return _model, _tokenizer

    try:
        from transformers import (
            AutoModelForSequenceClassification,
            AutoTokenizer,
        )

        log.info(f"[Emotion] Loading {_MODEL_ID} from HuggingFace...")

        _tokenizer = AutoTokenizer.from_pretrained(_MODEL_ID)
        _model     = AutoModelForSequenceClassification.from_pretrained(_MODEL_ID)
        _model.eval()

        log.info("[Emotion] Model loaded successfully.")

    except Exception as exc:
        log.error(f"[Emotion] Model load failed: {exc} — using fallback.")
        _model     = None
        _tokenizer = None

    return _model, _tokenizer


def _fallback_emotion(sentiment: str) -> str:
    if sentiment == "Positive":
        return "Happiness"
    if sentiment == "Negative":
        return "Anger"
    return "Neutral"


def _classify_single(text: str, sentiment: str) -> tuple[str, Optional[float]]:
    """
    Classify emotion for a single text.

    Returns
    -------
    (emotion_label, emotion_confidence)
    emotion_confidence is None when model is unavailable or sentiment is Neutral.
    This value is stored in "emotion_conf" — it NEVER touches the "confidence" key.
    """
    if sentiment == "Neutral":
        return "Neutral", None

    model, tokenizer = _load_model()
    if model is None:
        return _fallback_emotion(sentiment), None

    try:
        truncated = text[:512] if len(text) > 512 else text

        encoded = tokenizer(
            truncated,
            truncation=True,
            max_length=512,
            return_tensors="pt",
        )

        with torch.no_grad():
            outputs = model(**encoded)

        probs = torch.softmax(outputs.logits, dim=-1)[0]

        id2label    = model.config.id2label
        label_probs = {
            _LABEL_MAP.get(str(id2label[i]).lower(), "Neutral"): probs[i].item()
            for i in range(len(probs))
        }

        if sentiment == "Positive":
            allowed = {"Happiness", "Surprise"}
        else:
            allowed = {"Anger", "Disgust", "Fear", "Sadness"}

        filtered = {k: v for k, v in label_probs.items() if k in allowed}

        if filtered:
            best_label = max(filtered, key=filtered.get)
            best_score = filtered[best_label]
            return best_label, round(best_score, 4)

        return _fallback_emotion(sentiment), None

    except Exception as exc:
        log.error(f"[Emotion] Prediction failed: {exc}")
        return _fallback_emotion(sentiment), None


def classify_emotions(
    aspects: list[dict],
    text: str = "",
) -> list[dict]:
    """
    Add emotion labels to aspect dicts from ABSA.

    FIX: emotion confidence is stored in "emotion_conf" (new key).
         "confidence" key (ABSA/roberta sentiment confidence) is preserved as-is.

    Parameters
    ----------
    aspects : List of {"aspect": str, "sentiment": str, "confidence": float|None}
    text    : Original comment text (used for emotion classification)

    Returns
    -------
    List of dicts with keys:
        aspect, sentiment, confidence (ABSA), emotion, emotion_conf, sentence_level
    """
    result = []
    for item in aspects:
        sentiment         = item.get("sentiment", "Neutral")
        aspect            = item.get("aspect", None)
        emotion, emotion_conf = _classify_single(text, sentiment)

        result.append({
            "aspect":         aspect,
            "sentiment":      sentiment,
            "confidence":     item.get("confidence"),   # ABSA/roberta — never overwritten
            "emotion":        emotion,
            "emotion_conf":   emotion_conf,             # emotion model — separate key
            "sentence_level": item.get("sentence_level", False),
        })
    return result


def classify_emotions_batch(
    aspects_list: list[list[dict]],
    texts: list[str],
) -> list[list[dict]]:
    if len(aspects_list) != len(texts):
        raise ValueError(
            f"aspects_list and texts must have same length "
            f"(got {len(aspects_list)} vs {len(texts)})"
        )
    return [
        classify_emotions(aspects, text)
        for aspects, text in zip(aspects_list, texts)
    ]