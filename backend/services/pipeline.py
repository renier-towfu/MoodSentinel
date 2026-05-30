"""
================================================================================
MoodSentinel â€” services/pipeline.py
================================================================================
Main ABSA pipeline â€” orchestrates all service calls for a single comment
or a batch of comments.

Pipeline flow (per comment)
---------------------------
1. detect_language()       â†’ "english" | "tagalog" | "taglish"
2. translate_text()        â†’ English text (only if Tagalog/Taglish)
3. extract_aspects()       â†’ [{"aspect": ..., "sentiment": ..., "confidence": ...}]
4. classify_emotions()     â†’ [{"aspect": ..., "sentiment": ..., "emotion": ..., "emotion_conf": ...}]

Return format (per comment)
---------------------------
{
    "original_comment":    str,
    "translated_comment":  str,
    "language":            str,
    "was_translated":      bool,
    "aspects": [
        {
            "aspect":       str,
            "sentiment":    str,
            "emotion":      str,
            "confidence":   float | None,   # ABSA/roberta sentiment confidence
            "emotion_conf": float | None,   # fine-tuned emotion model confidence
        }
    ]
}
================================================================================
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

import regex  # pip install regex

from services.language_detector import detect_language, detect_batch
from services.translator        import translate_text, translate_batch
from services.absa_service      import extract_aspects, extract_aspects_batch
from services.emotion_service   import classify_emotions, classify_emotions_batch

log = logging.getLogger("MoodSentinel.Pipeline")

CommentResult = dict


def _clean_comment_text(text: str) -> str | None:
    # Step 1: remove emoji characters while preserving surrounding words.
    cleaned = regex.sub(
        r"[\U0001F000-\U0001FAFF\U00002600-\U000027BF\uFE00-\uFE0F"
        r"\U0001F300-\U0001F9FF\U00002300-\U000023FF\U00002700-\U000027BF]",
        " ",
        text,
    )

    # Step 2: remove @mention tokens before symbol stripping.
    cleaned = regex.sub(r"@\w+", " ", cleaned)

    # Step 3: remove #hashtag tokens before symbol stripping.
    cleaned = regex.sub(r"#\w+", " ", cleaned)

    # Step 4: remove URL tokens.
    cleaned = regex.sub(r"https?://\S+|www\.\S+", " ", cleaned)

    # Step 5: remove all Unicode punctuation and symbol characters.
    cleaned = regex.sub(r"[\p{P}\p{S}]", " ", cleaned)

    # Step 6: normalize whitespace.
    cleaned = regex.sub(r"\s+", " ", cleaned).strip()

    # Step 7: require at least two consecutive Unicode letters or digits.
    if not regex.search(r"[\p{L}\p{N}][\p{L}\p{N}]", cleaned):
        return None

    return cleaned


def process_comment(text: str) -> CommentResult:
    if not text or not text.strip():
        return {
            "original_comment":   text,
            "translated_comment": text,
            "language":           "english",
            "was_translated":     False,
            "aspects": [{"aspect": "general", "sentiment": "Neutral", "emotion": "Neutral",
                         "confidence": None, "emotion_conf": None}],
        }

    cleaned_text = _clean_comment_text(text)
    if cleaned_text is None:
        return {
            "original_comment":   text,
            "translated_comment": text,
            "language":           "english",
            "was_translated":     False,
            "aspects": [{"aspect": "general", "sentiment": "Neutral", "emotion": "Neutral",
                         "confidence": None, "emotion_conf": None}],
        }

    language = detect_language(cleaned_text)
    log.debug(f"[Pipeline] Language detected: {language}")

    translated_text, was_translated = translate_text(cleaned_text, language)
    log.debug(f"[Pipeline] Translation: {'yes' if was_translated else 'no'}")

    aspects = extract_aspects(translated_text)
    log.debug(f"[Pipeline] Aspects found: {len(aspects)}")

    aspects_with_emotion = classify_emotions(aspects, text=translated_text)

    return {
        "original_comment":   text,
        "translated_comment": translated_text,
        "language":           language,
        "was_translated":     was_translated,
        "aspects":            aspects_with_emotion,
    }


def process_batch(texts: list[str]) -> list[CommentResult]:
    if not texts:
        return []

    t_start = time.monotonic()
    log.info(f"[Pipeline] Processing batch of {len(texts)} comments...")

    languages = detect_batch(texts)

    translation_results = translate_batch(texts, languages)
    translated_texts    = [tr[0] for tr in translation_results]
    was_translated_list = [tr[1] for tr in translation_results]

    all_aspects = extract_aspects_batch(translated_texts)

    all_aspects_with_emotion = classify_emotions_batch(all_aspects, translated_texts)

    results = []
    for i, text in enumerate(texts):
        results.append({
            "original_comment":   text,
            "translated_comment": translated_texts[i],
            "language":           languages[i],
            "was_translated":     was_translated_list[i],
            "aspects":            all_aspects_with_emotion[i],
        })

    elapsed = round(time.monotonic() - t_start, 3)
    log.info(f"[Pipeline] Batch complete in {elapsed}s | {len(results)} results")

    return results


async def process_comment_async(text: str) -> CommentResult:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: process_comment(text))


async def process_batch_async(texts: list[str]) -> list[CommentResult]:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: process_batch(texts))


def aggregate_pipeline_results(
    pipeline_results: list[CommentResult],
) -> dict:
    """
    Convert pipeline results into the AnalysisReport format expected
    by the existing server.py and DashboardScreen.js.

    sentiment_conf â†’ confidence from ABSA/twitter-roberta (sentiment model)
    emotion_conf   â†’ confidence from fine-tuned emotion model
    Both are taken from aspects[0] only (first aspect represents the comment).
    Both are passed as-is (None if missing); rounding and hide logic is in CommentCard.js.
    """
    from collections import Counter

    if not pipeline_results:
        return {
            "sentiment_distribution": {},
            "emotion_distribution":   {},
            "language_distribution":  {},
            "dominant_sentiment":     "N/A",
            "dominant_emotion":       "N/A",
            "breakdown":              [],
        }

    sentiment_counts: Counter = Counter()
    emotion_counts:   Counter = Counter()
    language_counts:  Counter = Counter()
    breakdown = []

    for result in pipeline_results:
        lang = result["language"]
        language_counts[lang] += 1

        aspects = result.get("aspects", [])

        if not aspects:
            sentiment_counts["Neutral"] += 1
            continue

        for aspect in aspects:
            sentiment = aspect.get("sentiment", "Neutral")
            emotion   = aspect.get("emotion", "Neutral")
            sentiment_counts[sentiment] += 1
            if emotion and emotion != "Neutral":
                emotion_counts[emotion] += 1

        sentiments_in_comment = [a.get("sentiment", "Neutral") for a in aspects]
        primary_sentiment = max(set(sentiments_in_comment),
                                key=sentiments_in_comment.count)
        primary_emotion = aspects[0].get("emotion", "Neutral")

        # â”€â”€ FIX: separate sentiment_conf and emotion_conf â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        # sentiment_conf â†’ from ABSA/roberta ("confidence" key set by absa_service)
        # emotion_conf   â†’ from fine-tuned emotion model ("emotion_conf" key set by emotion_service)
        sentiment_conf = aspects[0].get("confidence", None)
        emotion_conf   = aspects[0].get("emotion_conf", None)

        breakdown.append({
            "text":           result["original_comment"],
            "language":       lang,
            "sentiment":      primary_sentiment,
            "sentiment_conf": sentiment_conf,   # ABSA/roberta confidence
            "emotion":        primary_emotion,
            "emotion_conf":   emotion_conf,     # emotion model confidence
            "aspects":        aspects,
            "translated":     result.get("was_translated", False),
        })

    total         = len(pipeline_results)
    emotion_total = sum(emotion_counts.values())

    def _pct(count: int, denom: int) -> float:
        return round((count / denom) * 100, 2) if denom > 0 else 0.0

    return {
        "sentiment_distribution": {
            s: _pct(sentiment_counts[s], total)
            for s in ["Positive", "Negative", "Neutral"]
        },
        "emotion_distribution": {
            e: _pct(emotion_counts[e], emotion_total)
            for e in ["Happiness", "Surprise", "Anger", "Disgust", "Fear", "Sadness"]
        },
        "language_distribution": {
            l: _pct(language_counts[l], total)
            for l in ["english", "tagalog", "taglish"]
        },
        "dominant_sentiment": (
            max(sentiment_counts, key=sentiment_counts.get)
            if sentiment_counts else "N/A"
        ),
        "dominant_emotion": (
            max(emotion_counts, key=emotion_counts.get)
            if emotion_counts else "N/A"
        ),
        "breakdown": breakdown,
    }


if __name__ == "__main__":
    test_comments = [
        "The delivery was super slow but the product quality is amazing.",
        "Ang ganda nito, sobrang saya ko! Hindi ko inexpect na ganito kaganda.",
        "Yung service sobrang pangit, galit na galit ako.",
        "I'm scared about the quality â€” the smell is alarming.",
        "Okay lang naman, walang reklamo.",
        "This is absolutely disgusting, there was mold on the packaging.",
    ]

    print("Full Pipeline Test")
    print("=" * 70)
    for comment in test_comments:
        result = process_comment(comment)
        print(f"\nOriginal  : {result['original_comment']}")
        if result["was_translated"]:
            print(f"Translated: {result['translated_comment']}")
        print(f"Language  : {result['language']}")
        for a in result["aspects"]:
            print(f"  â†’ Aspect={a.get('aspect',''):<15} Sentiment={a.get('sentiment',''):<8} "
                  f"SentConf={a.get('confidence')}  Emotion={a.get('emotion')}  "
                  f"EmoConf={a.get('emotion_conf')}")