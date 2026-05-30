"""
================================================================================
MoodSentinel — services/translator.py
================================================================================
Translates Tagalog / Taglish text to English using deep-translator.

Design decisions
----------------
• Translation is ONLY performed when the detected language is "tagalog"
  or "taglish".  English comments pass through untouched.
• The translated text is what gets sent to the ABSA model; the original
  text is preserved and returned to the frontend for display.
• deep-translator (GoogleTranslator) is free, no API key required.
• Errors are caught and logged — if translation fails, the original
  text is used as fallback (the pipeline never crashes on translation errors).
• Async wrapper provided for FastAPI compatibility.

Install
-------
    pip install deep-translator
================================================================================
"""

from __future__ import annotations

import asyncio
import logging
from functools import lru_cache
from typing import Optional

log = logging.getLogger("MoodSentinel.Translator")

# ── Lazy import so the app starts even if deep-translator is not installed ────
try:
    from deep_translator import GoogleTranslator
    _TRANSLATOR_AVAILABLE = True
except ImportError:
    _TRANSLATOR_AVAILABLE = False
    log.warning(
        "[Translator] deep-translator not installed. "
        "Translation will be skipped. "
        "Run: pip install deep-translator"
    )


# ── Languages that need translation before ABSA ──────────────────────────────
_NEEDS_TRANSLATION = {"english", "tagalog", "taglish"}

# ── Character limit for a single GoogleTranslator call ───────────────────────
# Google Translate API has a 5000-char limit per request.
_MAX_CHARS = 4800


@lru_cache(maxsize=512)
def _translate_cached(text: str, source: str = "tl") -> str:
    """
    Cached synchronous translation.
    LRU cache avoids re-translating identical comments in the same session.
    """
    translator = GoogleTranslator(source=source, target="en")
    return translator.translate(text)


def translate_text(
    text: str,
    language: str,
    fallback_on_error: bool = True,
) -> tuple[str, bool]:
    """
    Translate a single comment to English if necessary.

    Parameters
    ----------
    text              : Raw comment string
    language          : Detected language ("english" | "tagalog" | "taglish")
    fallback_on_error : If True, return original text on translation failure.
                        If False, re-raise the exception.

    Returns
    -------
    (translated_text, was_translated)
      translated_text : English text (or original if no translation needed)
      was_translated  : True if translation actually happened
    """
    # Skip translation if already English or translation library not available
    if language not in _NEEDS_TRANSLATION:
        return text, False

    if not _TRANSLATOR_AVAILABLE:
        log.debug("[Translator] Skipping — deep-translator not available.")
        return text, False

    if not text or not text.strip():
        return text, False

    # Truncate if over API limit
    truncated = text[:_MAX_CHARS] if len(text) > _MAX_CHARS else text

    try:
        # Taglish is mixed — use "auto" detection for better results
        source_lang = "auto" if language == "taglish" else "tl"
        translated  = _translate_cached(truncated, source_lang)

        if not translated or not translated.strip():
            log.warning("[Translator] Empty translation result — using original.")
            return text, False

        log.debug(f"[Translator] {language} → en | '{text[:40]}' → '{translated[:40]}'")
        return translated, True

    except Exception as exc:
        log.error(f"[Translator] Failed: {exc} | text='{text[:60]}'")
        if fallback_on_error:
            return text, False
        raise


def translate_batch(
    texts: list[str],
    languages: list[str],
    fallback_on_error: bool = True,
) -> list[tuple[str, bool]]:
    """
    Translate a batch of comments.

    Parameters
    ----------
    texts             : List of raw comment strings
    languages         : Detected language for each comment (parallel list)
    fallback_on_error : Passed to translate_text()

    Returns
    -------
    List of (translated_text, was_translated) tuples in the same order
    """
    if len(texts) != len(languages):
        raise ValueError(
            f"texts and languages must have the same length "
            f"(got {len(texts)} vs {len(languages)})"
        )

    results = []
    for text, lang in zip(texts, languages):
        translated, was_translated = translate_text(text, lang, fallback_on_error)
        results.append((translated, was_translated))

    return results


# ── Async wrappers for FastAPI ────────────────────────────────────────────────

async def translate_text_async(
    text: str,
    language: str,
    fallback_on_error: bool = True,
) -> tuple[str, bool]:
    """
    Async wrapper for translate_text().
    Runs the blocking translation in a thread pool executor.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: translate_text(text, language, fallback_on_error)
    )


async def translate_batch_async(
    texts: list[str],
    languages: list[str],
    fallback_on_error: bool = True,
) -> list[tuple[str, bool]]:
    """
    Async wrapper for translate_batch().
    Runs the blocking batch translation in a thread pool executor.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: translate_batch(texts, languages, fallback_on_error)
    )


# ── Standalone test ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    test_cases = [
        ("This is amazing!", "english"),
        ("Ang ganda nito, sobrang saya ko!", "tagalog"),
        ("Yung delivery sobrang tagal, I'm so disappointed.", "taglish"),
        ("Hindi ko talaga inexpect na ganito kaganda.", "tagalog"),
        ("Super galit ako sa service nila.", "taglish"),
    ]

    print("Translation Tests")
    print("=" * 60)
    for text, lang in test_cases:
        result, translated = translate_text(text, lang)
        status = "→ TRANSLATED" if translated else "→ UNCHANGED"
        print(f"[{lang:8s}] {status}")
        print(f"  IN : {text}")
        print(f"  OUT: {result}")
        print()
