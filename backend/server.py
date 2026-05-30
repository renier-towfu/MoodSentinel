"""
================================================================================
MoodSentinel — server.py  (Phase 7 — Chrome Extension Scraper)
================================================================================
Changes from Phase 6:
  • Playwright scraper replaced by Chrome extension delegate
  • _run_analysis_job now calls enqueue_job() → waits for extension to submit
  • _run_pipeline_on_comments() added — called by extension_router after submit
  • Extension submits comments → pipeline runs → result stored in _jobs
  • All job queue, status, and result endpoints unchanged
  • Synthetic fallback removed (extension is now the scraper)

Fix (v7.0.1):
  • Removed duplicate CORSMiddleware registration
  • Fixed illegal allow_credentials=True + allow_origins=["*"] combination
    Chrome blocks this per CORS spec — caused 0-comment reel submissions

Fix (v7.0.2):
  • EXTENSION_TIMEOUT increased from 180 → 300s to match background.js timeout
  • Added GET /api/ngrok-url endpoint — queries ngrok local API at :4040
    so the Chrome extension can auto-detect the public URL on startup
    without manual entry in the popup
================================================================================
"""
from extension_router import router as extension_router, enqueue_job

import asyncio
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import urllib.request
import json as _json

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, HttpUrl, field_validator

# ── ML Router (original mBERT pipeline) ──────────────────────────────────────
_ROUTER_AVAILABLE = False
MoodRouter = None

# ── New ABSA pipeline ─────────────────────────────────────────────────────────
try:
    from services.pipeline import (
        process_batch_async,
        aggregate_pipeline_results,
    )
    _PIPELINE_AVAILABLE = True
except ImportError:
    _PIPELINE_AVAILABLE = False

# ── Playwright scraper (kept as optional fallback) ────────────────────────────
try:
    from scraper import scrape_comments as _real_scraper
    _SCRAPER_AVAILABLE = True
except ImportError:
    _SCRAPER_AVAILABLE = False

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  [%(levelname)-8s]  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("MoodSentinel.API")

# ── Configuration ─────────────────────────────────────────────────────────────
MAX_COMMENTS   = int(os.getenv("MOODSENTINEL_MAX_COMMENTS", 1000))
MIN_COMMENTS   = int(os.getenv("MOODSENTINEL_MIN_COMMENTS", 1))
CHECKPOINT_DIR = os.getenv("MOODSENTINEL_CHECKPOINT_DIR", "checkpoints")
INFERENCE_MODE = os.getenv("MOODSENTINEL_INFERENCE_MODE", "absa")

# Use Chrome extension instead of Playwright (set to "false" to fall back to Playwright)
USE_EXTENSION  = os.getenv("MOODSENTINEL_USE_EXTENSION", "true").lower() == "true"

# How long to wait for the extension to scrape and submit (seconds)
EXTENSION_TIMEOUT = int(os.getenv("MOODSENTINEL_EXTENSION_TIMEOUT", 900))

# Job result TTL — how long to keep completed results in memory (seconds)
JOB_TTL = int(os.getenv("MOODSENTINEL_JOB_TTL", 900))  # 15 minutes

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="MoodSentinel API",
    description=(
        "mBERT + ABSA sentiment & emotion analysis for Facebook comments. "
        "Supports English, Tagalog, and Taglish."
    ),
    version="7.0.1",
)

app.include_router(extension_router)

# ── CORS ──────────────────────────────────────────────────────────────────────
# FIX: allow_credentials=True is illegal with allow_origins=["*"] per the CORS
# spec — Chrome rejects it. Chrome extension origins
# (chrome-extension://...) are non-standard and are allowed via wildcard only
# when credentials are NOT required. The extension does not send cookies, so
# credentials=False is correct here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,   # Must be False when allow_origins=["*"]
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_ngrok_header(request: Request, call_next):
    response = await call_next(request)
    response.headers["ngrok-skip-browser-warning"] = "true"
    return response


# ── App state ─────────────────────────────────────────────────────────────────
class _AppState:
    router:    Optional[Any] = None
    boot_time: float = time.time()

_state = _AppState()


# ── Job Store ─────────────────────────────────────────────────────────────────
# Shared between server.py and extension_router.py
# extension_router imports _job_store and _run_pipeline_on_comments from here
#
# Job states:
#   "queued"     — waiting in queue
#   "scraping"   — waiting for Chrome extension to submit comments
#   "analyzing"  — ML pipeline running
#   "done"       — result ready
#   "failed"     — error occurred
#
# Each job:
# {
#   "job_id":      str,
#   "status":      str,
#   "position":    int,
#   "progress":    str,
#   "post_url":    str,
#   "created_at":  float,
#   "result":      dict | None,
#   "error":       str | None,
#   "_comments":   list | None,   # set by extension_router after submit
# }

_job_store: Dict[str, Dict] = {}

# Semaphore: only 1 analysis pipeline runs at a time
_analysis_semaphore = asyncio.Semaphore(1)

# Queue of waiting job_ids in order
_job_queue: asyncio.Queue = asyncio.Queue()


def _get_queue_position(job_id: str) -> int:
    queue_items = list(_job_queue._queue)  # type: ignore
    try:
        return queue_items.index(job_id)
    except ValueError:
        return 0


def _cleanup_old_jobs() -> None:
    now = time.time()
    to_delete = [
        jid for jid, job in _job_store.items()
        if job["status"] in ("done", "failed")
        and now - job["created_at"] > JOB_TTL
    ]
    for jid in to_delete:
        del _job_store[jid]
        log.debug(f"[Queue] Cleaned up expired job {jid}")


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    post_url:          HttpUrl
    max_comments:      Optional[int] = None
    language_override: Optional[str] = None
    cookies:           Optional[str] = ""

    @field_validator("language_override")
    @classmethod
    def validate_language(cls, v):
        if v is not None and v.lower() not in {"english", "tagalog", "taglish"}:
            raise ValueError("language_override must be english, tagalog, or taglish")
        return v.lower() if v else None

    @field_validator("max_comments")
    @classmethod
    def cap_max(cls, v):
        if v is not None and (v < 1 or v > MAX_COMMENTS):
            raise ValueError(f"max_comments must be 1–{MAX_COMMENTS}")
        return v


class BatchAnalyzeRequest(BaseModel):
    comments: List[str]

    @field_validator("comments")
    @classmethod
    def validate_comments(cls, v):
        if not v:
            raise ValueError("comments list cannot be empty")
        if len(v) > MAX_COMMENTS:
            raise ValueError(f"Maximum {MAX_COMMENTS} comments per request")
        return [c.strip() for c in v if c.strip()]


class CommentResult(BaseModel):
    text:           str
    language:       str
    sentiment:      str
    sentiment_conf: Optional[float] = None
    emotion:        str
    emotion_conf:   Optional[float] = None
    aspects:        Optional[List[dict]] = None


class AnalysisReport(BaseModel):
    sentiment_distribution: Dict[str, float]
    emotion_distribution:   Dict[str, float]
    language_distribution:  Dict[str, float]
    comments_analysed:      int
    comments_skipped:       int
    dominant_sentiment:     str
    dominant_emotion:       str
    post_url:               str
    processed_at:           str
    processing_time_ms:     float
    request_id:             str
    breakdown:              List[CommentResult]
    pipeline_used:          str = "unknown"


class BatchAnalysisReport(BaseModel):
    comments_analysed:      int
    dominant_sentiment:     str
    dominant_emotion:       str
    sentiment_distribution: Dict[str, float]
    emotion_distribution:   Dict[str, float]
    language_distribution:  Dict[str, float]
    processed_at:           str
    processing_time_ms:     float
    request_id:             str
    breakdown:              List[dict]
    pipeline_used:          str


class HealthResponse(BaseModel):
    status:           str
    version:          str
    uptime_seconds:   float
    router_loaded:    bool
    scraper_ready:    bool
    pipeline_ready:   bool
    inference_mode:   str
    use_extension:    bool
    active_jobs:      int
    queued_jobs:      int


class JobSubmittedResponse(BaseModel):
    job_id:   str
    status:   str
    position: int
    message:  str


class JobStatusResponse(BaseModel):
    job_id:   str
    status:   str
    position: int
    progress: str
    post_url: str


# ── Pipeline runner (shared with extension_router) ────────────────────────────

async def _run_pipeline_on_comments(job_id: str, comments: list, post_url: str) -> None:
    """
    Called by extension_router.py after the Chrome extension submits scraped comments.
    Runs the ABSA + emotion pipeline and stores the result in _job_store.
    """
    if job_id not in _job_store:
        log.error(f"[{job_id}] _run_pipeline_on_comments: job not found in _job_store")
        return

    job = _job_store[job_id]
    t_start = time.monotonic()

    # Store comments on the job so _run_analysis_job can pick them up
    job["_comments"] = comments
    log.info(f"[{job_id}] Extension delivered {len(comments)} comments — pipeline starting")

    # The semaphore and pipeline logic runs inside _run_analysis_job
    # which is already waiting on _comments to be set. Nothing more needed here.
    # This function just acts as the bridge that extension_router calls.


# ── Core analysis worker ──────────────────────────────────────────────────────

async def _run_analysis_job(job_id: str, body: AnalyzeRequest) -> None:
    """
    Full analysis job. Delegates scraping to Chrome extension, then runs pipeline.
    Updates _job_store[job_id] throughout.
    """
    job      = _job_store[job_id]
    t_start  = time.monotonic()
    post_url = str(body.post_url)
    cap      = min(body.max_comments or MAX_COMMENTS, MAX_COMMENTS)

    try:
        # ── Scraping phase ────────────────────────────────────────────────────
        if USE_EXTENSION:
            # Delegate to Chrome extension
            job["status"]   = "scraping"
            job["progress"] = "Waiting for Chrome extension to scrape comments..."
            log.info(f"[{job_id}] ▶ Delegating scrape to Chrome extension | url={post_url}")

            await enqueue_job(job_id, post_url, cap)

            # Poll until extension sets _comments on this job (or fails/times out)
            interval = 2
            elapsed  = 0
            raw_comments = None

            while elapsed < EXTENSION_TIMEOUT:
                await asyncio.sleep(interval)
                elapsed += interval

                # Check if extension_router called _run_pipeline_on_comments
                # which sets job["_comments"]
                if "_comments" in job and job["_comments"] is not None:
                    raw_comments = job["_comments"]
                    log.info(f"[{job_id}] Extension delivered {len(raw_comments)} comments after {elapsed}s")
                    break

                # Check if extension reported failure
                if job.get("status") == "failed":
                    raise RuntimeError(job.get("error", "Chrome extension failed to scrape."))

                # Check extension queue status
                from extension_router import _extension_queue
                q_job = _extension_queue.get(job_id)
                if q_job and q_job["status"] == "failed":
                    raise RuntimeError("Chrome extension reported scraping failure.")

                log.debug(f"[{job_id}] Waiting for extension... {elapsed}s elapsed")

            if raw_comments is None:
                raise RuntimeError(
                    f"Chrome extension did not respond within {EXTENSION_TIMEOUT}s. "
                    "Make sure Chrome is open with the MoodSentinel extension running."
                )

        else:
            # Fallback: use Playwright scraper directly
            job["status"]   = "scraping"
            job["progress"] = "Scraping Facebook comments with Playwright..."
            log.info(f"[{job_id}] ▶ Scraping with Playwright | url={post_url}")

            if not _SCRAPER_AVAILABLE:
                raise RuntimeError("Playwright scraper not available and extension mode is disabled.")

            raw_comments = await _real_scraper(
                post_url,
                cookies_str=body.cookies or "",
                max_comments=cap,
            )

        # ── Validate comments ─────────────────────────────────────────────────
        valid_comments   = [c.strip() for c in raw_comments if len(c.strip()) >= 3]
        skipped_comments = len(raw_comments) - len(valid_comments)

        log.info(f"[{job_id}] {len(valid_comments)} valid comments ({skipped_comments} skipped)")

        if len(valid_comments) < MIN_COMMENTS:
            raise ValueError(
                f"Only {len(valid_comments)} usable comment(s) found "
                f"(minimum {MIN_COMMENTS} required)."
            )

        # ── Inference phase ───────────────────────────────────────────────────
        job["status"]   = "analyzing"
        job["progress"] = f"Analyzing {len(valid_comments)} comments..."
        log.info(f"[{job_id}] ▶ Running ABSA pipeline on {len(valid_comments)} comments")

        aggregated    = {}
        breakdown     = []
        pipeline_used = "unknown"

        async with _analysis_semaphore:
            use_absa = (INFERENCE_MODE == "absa") or (
                INFERENCE_MODE == "auto" and _PIPELINE_AVAILABLE
            )

            if use_absa and _PIPELINE_AVAILABLE:
                try:
                    pipeline_results = await process_batch_async(valid_comments)
                    aggregated       = aggregate_pipeline_results(pipeline_results)
                    raw_breakdown    = aggregated.pop("breakdown")
                    breakdown = [
                        CommentResult(
                            text=           d["text"],
                            language=       d["language"],
                            sentiment=      d["sentiment"],
                            sentiment_conf= d.get("sentiment_conf"),
                            emotion=        d["emotion"],
                            emotion_conf=   d.get("emotion_conf"),
                            aspects=        d.get("aspects"),
                        ).dict()
                        for d in raw_breakdown
                    ]
                    pipeline_used = "absa"
                except Exception as exc:
                    log.error(f"[{job_id}] ABSA failed: {exc}")

        if pipeline_used == "unknown":
            raise RuntimeError("No inference pipeline available.")

        elapsed_ms = round((time.monotonic() - t_start) * 1000, 2)

        # ── Store result ──────────────────────────────────────────────────────
        job["status"]   = "done"
        job["progress"] = "Analysis complete."
        job["result"]   = {
            "sentiment_distribution": aggregated["sentiment_distribution"],
            "emotion_distribution":   aggregated["emotion_distribution"],
            "language_distribution":  aggregated["language_distribution"],
            "comments_analysed":      len(valid_comments),
            "comments_skipped":       skipped_comments,
            "dominant_sentiment":     aggregated["dominant_sentiment"],
            "dominant_emotion":       aggregated["dominant_emotion"],
            "post_url":               post_url,
            "processed_at":           datetime.now(timezone.utc).isoformat(),
            "processing_time_ms":     elapsed_ms,
            "request_id":             job_id,
            "breakdown":              breakdown,
            "pipeline_used":          pipeline_used,
        }

        log.info(
            f"[{job_id}] ✔ Done in {elapsed_ms}ms | "
            f"sentiment={aggregated.get('dominant_sentiment')} | "
            f"emotion={aggregated.get('dominant_emotion')}"
        )

    except Exception as exc:
        log.error(f"[{job_id}] ✘ Failed: {exc}")
        job["status"]   = "failed"
        job["progress"] = f"Analysis failed: {str(exc)}"
        job["error"]    = str(exc)

    # Update queue positions for remaining queued jobs
    for jid, j in _job_store.items():
        if j["status"] == "queued":
            j["position"] = _get_queue_position(jid)


# ── Exception handlers ────────────────────────────────────────────────────────

@app.exception_handler(HTTPException)
async def http_exc(request: Request, exc: HTTPException):
    req_id = getattr(request.state, "request_id", str(uuid.uuid4()))
    return JSONResponse(status_code=exc.status_code, content={
        "error": f"HTTP_{exc.status_code}", "detail": str(exc.detail), "request_id": req_id,
    })

@app.exception_handler(Exception)
async def generic_exc(request: Request, exc: Exception):
    req_id = getattr(request.state, "request_id", str(uuid.uuid4()))
    log.exception(f"Unhandled [{req_id}]")
    return JSONResponse(status_code=500, content={
        "error": "INTERNAL_SERVER_ERROR", "detail": "Check server logs.", "request_id": req_id,
    })

@app.middleware("http")
async def attach_request_id(request: Request, call_next):
    req_id   = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    request.state.request_id = req_id
    start    = time.monotonic()
    response = await call_next(request)
    elapsed  = round((time.monotonic() - start) * 1000, 2)
    response.headers["X-Request-ID"]         = req_id
    response.headers["X-Processing-Time-Ms"] = str(elapsed)
    return response


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/api/ngrok-url", tags=["Ops"])
async def get_ngrok_url():
    """
    Returns the active ngrok public URL by querying ngrok's local API at :4040.
    The Chrome extension calls this on startup from localhost:8000 to auto-detect
    its API base URL — no manual entry in the popup required.
    """
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:4040/api/tunnels",
            headers={"User-Agent": "MoodSentinel"}
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = _json.loads(resp.read())
        tunnels = data.get("tunnels", [])
        # Prefer https tunnel
        for t in tunnels:
            if t.get("proto") == "https":
                return {"url": t["public_url"]}
        # Fallback: return first tunnel
        if tunnels:
            return {"url": tunnels[0]["public_url"]}
        return {"url": None, "error": "No active ngrok tunnels found"}
    except Exception as e:
        log.warning(f"[ngrok] Could not query ngrok API: {e}")
        return {"url": None, "error": str(e)}


@app.get("/api/health", response_model=HealthResponse, tags=["Ops"])
async def health_check():
    active = sum(1 for j in _job_store.values() if j["status"] in ("scraping", "analyzing"))
    queued = sum(1 for j in _job_store.values() if j["status"] == "queued")
    return HealthResponse(
        status="ok",
        version=app.version,
        uptime_seconds=round(time.time() - _state.boot_time, 1),
        router_loaded=_state.router is not None,
        scraper_ready=_SCRAPER_AVAILABLE,
        pipeline_ready=_PIPELINE_AVAILABLE,
        inference_mode=INFERENCE_MODE,
        use_extension=USE_EXTENSION,
        active_jobs=active,
        queued_jobs=queued,
    )


@app.post("/api/analyze", response_model=JobSubmittedResponse, tags=["Analysis"])
async def analyze_post(body: AnalyzeRequest, request: Request) -> JobSubmittedResponse:
    """
    Submit a Facebook post URL for analysis.

    Returns immediately with a job_id. The Chrome extension picks up the job,
    scrapes comments from the live Facebook DOM, and submits them back.
    Poll /api/analyze/status/{job_id} for progress.
    Fetch /api/analyze/result/{job_id} when status is 'done'.
    """
    _cleanup_old_jobs()

    job_id   = str(uuid.uuid4())
    post_url = str(body.post_url)

    pending = sum(
        1 for j in _job_store.values()
        if j["status"] in ("queued", "scraping", "analyzing")
    )

    _job_store[job_id] = {
        "job_id":     job_id,
        "status":     "queued",
        "position":   pending,
        "progress":   f"Queued. {pending} job(s) ahead." if pending > 0 else "Starting soon...",
        "post_url":   post_url,
        "created_at": time.time(),
        "result":     None,
        "error":      None,
        "_comments":  None,
    }

    asyncio.create_task(_run_analysis_job(job_id, body))

    log.info(f"[{job_id}] ▶ Queued | url={post_url} | position={pending} | extension={USE_EXTENSION}")

    return JobSubmittedResponse(
        job_id=job_id,
        status="queued",
        position=pending,
        message=(
            f"Analysis queued. {pending} job(s) ahead."
            if pending > 0
            else "Analysis started. Waiting for Chrome extension to scrape."
        ),
    )


@app.get("/api/analyze/status/{job_id}", response_model=JobStatusResponse, tags=["Analysis"])
async def get_job_status(job_id: str) -> JobStatusResponse:
    """
    Poll every 3 seconds for analysis progress.

    Status values:
      queued    — waiting for a running job to finish
      scraping  — Chrome extension is collecting Facebook comments
      analyzing — ML pipeline is running
      done      — result ready at /api/analyze/result/{job_id}
      failed    — check progress field for error message
    """
    if job_id not in _job_store:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found.")

    job = _job_store[job_id]
    return JobStatusResponse(
        job_id=job_id,
        status=job["status"],
        position=job.get("position", 0),
        progress=job["progress"],
        post_url=job["post_url"],
    )


@app.get("/api/analyze/result/{job_id}", tags=["Analysis"])
async def get_job_result(job_id: str):
    """
    Fetch the completed analysis result.
    Only available when status is 'done'.
    """
    if job_id not in _job_store:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found.")

    job = _job_store[job_id]

    if job["status"] in ("queued", "scraping", "analyzing"):
        raise HTTPException(
            status_code=202,
            detail=f"Job still in progress. Status: {job['status']}"
        )

    if job["status"] == "failed":
        raise HTTPException(
            status_code=500,
            detail=job.get("error", "Analysis failed.")
        )

    if job["status"] == "done" and job["result"]:
        return JSONResponse(content=job["result"])

    raise HTTPException(status_code=500, detail="Unexpected job state.")


@app.post("/api/analyze/batch", response_model=BatchAnalysisReport, tags=["Analysis"])
async def analyze_batch(body: BatchAnalyzeRequest, request: Request) -> BatchAnalysisReport:
    """
    Batch analysis without scraping — accepts raw comments directly.
    Synchronous (no job queue, no extension needed).
    """
    req_id  = getattr(request.state, "request_id", str(uuid.uuid4()))
    t_start = time.monotonic()

    log.info(f"[{req_id}] ▶ /api/analyze/batch | {len(body.comments)} comments")

    valid_comments = [c for c in body.comments if len(c) >= 3]
    if not valid_comments:
        raise HTTPException(status_code=400, detail="No valid comments provided.")

    aggregated    = {}
    breakdown     = []
    pipeline_used = "unknown"

    if _PIPELINE_AVAILABLE:
        try:
            pipeline_results = await process_batch_async(valid_comments)
            aggregated       = aggregate_pipeline_results(pipeline_results)
            breakdown        = aggregated.pop("breakdown", [])
            pipeline_used    = "absa"
        except Exception as exc:
            log.error(f"[{req_id}] ABSA batch failed: {exc}")

    if pipeline_used == "unknown":
        raise HTTPException(status_code=503, detail="No inference pipeline available.")

    elapsed_ms = round((time.monotonic() - t_start) * 1000, 2)
    log.info(f"[{req_id}] ✔ Batch done in {elapsed_ms}ms")

    return BatchAnalysisReport(
        comments_analysed=len(valid_comments),
        dominant_sentiment=aggregated.get("dominant_sentiment", "N/A"),
        dominant_emotion=aggregated.get("dominant_emotion", "N/A"),
        sentiment_distribution=aggregated.get("sentiment_distribution", {}),
        emotion_distribution=aggregated.get("emotion_distribution", {}),
        language_distribution=aggregated.get("language_distribution", {}),
        processed_at=datetime.now(timezone.utc).isoformat(),
        processing_time_ms=elapsed_ms,
        request_id=req_id,
        breakdown=breakdown,
        pipeline_used=pipeline_used,
    )


@app.get("/", include_in_schema=False)
async def root():
    return {"service": "MoodSentinel API", "version": app.version, "docs": "/docs"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", 8000)),
        reload=True,
    )