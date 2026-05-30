"""
MoodSentinel — extension_router.py

FastAPI router that bridges the mobile app and Chrome extension.

Flow:
1. Mobile app calls POST /api/analyze (existing endpoint) → creates job
2. server.py detects no Playwright → stores job in extension queue instead
3. Chrome extension calls GET /api/extension/pending → gets next job
4. Extension scrapes comments → POST /api/extension/submit
5. Pipeline runs on submitted comments
6. Mobile app polls GET /api/analyze/status/{job_id} → gets result (unchanged)

Endpoints:
  GET  /api/extension/pending        → returns next pending job for extension
  POST /api/extension/submit         → extension submits scraped comments
  POST /api/extension/fail           → extension reports a failed job
  GET  /api/extension/status         → extension health check
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from fastapi import APIRouter

logger = logging.getLogger("MoodSentinel.Extension")

router = APIRouter()

# ── In-memory extension job queue ────────────────────────────────────────────
# Format: { job_id: { "post_url", "max_comments", "created_at", "status" } }
_extension_queue: dict[str, dict] = {}
_queue_lock = asyncio.Lock()


# ── Queue helpers (called from server.py) ────────────────────────────────────

async def enqueue_job(job_id: str, post_url: str, max_comments: int = 200) -> None:
    """Called by server.py to add a job to the extension queue."""
    async with _queue_lock:
        _extension_queue[job_id] = {
            "job_id": job_id,
            "post_url": post_url,
            "max_comments": max_comments,
            "created_at": time.time(),
            "status": "pending",
        }
    logger.info(f"[Extension] Job enqueued: {job_id} | url={post_url}")


async def is_job_pending(job_id: str) -> bool:
    async with _queue_lock:
        job = _extension_queue.get(job_id)
        return job is not None and job["status"] == "pending"


# ── Extension endpoints ───────────────────────────────────────────────────────

@router.get("/api/extension/pending")
async def get_pending_job():
    """
    Called by Chrome extension every 5 seconds.
    Returns the oldest pending job or empty response.
    """
    async with _queue_lock:
        # Find oldest pending job
        pending = [
            j for j in _extension_queue.values()
            if j["status"] == "pending"
        ]
        if not pending:
            return {}

        # Sort by created_at, take oldest
        job = sorted(pending, key=lambda x: x["created_at"])[0]
        job["status"] = "processing"

        logger.info(f"[Extension] Serving job to extension: {job['job_id']}")
        return {
            "job_id": job["job_id"],
            "post_url": job["post_url"],
            "max_comments": job["max_comments"],
        }


@router.post("/api/extension/submit")
async def submit_comments(payload: dict):
    """
    Called by Chrome extension after scraping comments.
    Triggers the ABSA + emotion pipeline on the scraped comments.
    """
    job_id = payload.get("job_id")
    comments = payload.get("comments", [])
    post_url = payload.get("post_url", "")

    if not job_id:
        return {"error": "missing job_id"}

    logger.info(f"[Extension] Received {len(comments)} comments for job {job_id}")

    # Remove from queue
    async with _queue_lock:
        if job_id in _extension_queue:
            _extension_queue[job_id]["status"] = "submitted"

    # Import here to avoid circular imports
    from server import _job_store, _run_pipeline_on_comments

    if job_id not in _job_store:
        logger.error(f"[Extension] Job {job_id} not found in job store.")
        return {"error": "job not found"}

    # Run pipeline in background
    asyncio.create_task(
        _run_pipeline_on_comments(job_id, comments, post_url)
    )

    return {"ok": True, "job_id": job_id, "comments_received": len(comments)}


@router.post("/api/extension/fail")
async def fail_job(payload: dict):
    """Called by extension if scraping failed."""
    job_id = payload.get("job_id")
    reason = payload.get("reason", "unknown")

    if not job_id:
        return {"error": "missing job_id"}

    logger.error(f"[Extension] Job {job_id} failed: {reason}")

    async with _queue_lock:
        if job_id in _extension_queue:
            _extension_queue[job_id]["status"] = "failed"

    from server import _job_store
    if job_id in _job_store:
        _job_store[job_id]["status"] = "error"
        _job_store[job_id]["error"] = f"Extension scraping failed: {reason}"

    return {"ok": True}


@router.get("/api/extension/status")
async def extension_status():
    """Health check for extension."""
    async with _queue_lock:
        pending = sum(1 for j in _extension_queue.values() if j["status"] == "pending")
        processing = sum(1 for j in _extension_queue.values() if j["status"] == "processing")

    return {
        "ok": True,
        "pending_jobs": pending,
        "processing_jobs": processing,
    }
@router.get("/api/extension/status/{job_id}")
async def extension_job_status(job_id: str):
    """
    Called by background.js every 5s to check if the extension job is complete.
    Returns status from both the extension queue and the main job store.
    """
    from server import _job_store

    # Check main job store first (pipeline result lives here)
    if job_id in _job_store:
        main_job = _job_store[job_id]
        main_status = main_job.get("status", "pending")

        # Map main job statuses to simple complete/pending/failed
        if main_status in ("done", "complete"):
            return {"job_id": job_id, "status": "complete", "comment_count": main_job.get("comments_analysed", 0)}
        if main_status in ("error", "failed"):
            return {"job_id": job_id, "status": "failed", "comment_count": 0}

    # Check extension queue for scraping status
    async with _queue_lock:
        q_job = _extension_queue.get(job_id)
        if q_job:
            q_status = q_job.get("status", "pending")
            if q_status == "submitted":
                return {"job_id": job_id, "status": "analyzing", "comment_count": 0}
            if q_status == "failed":
                return {"job_id": job_id, "status": "failed", "comment_count": 0}
            return {"job_id": job_id, "status": "scraping", "comment_count": 0}

    return {"job_id": job_id, "status": "pending", "comment_count": 0}