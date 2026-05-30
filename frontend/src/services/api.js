/**
 * MoodSentinel — src/services/api.js
 * Centralised API service for all FastAPI backend communication.
 *
 * v3 changes:
 *   - On timeout OR error, sends DELETE /api/analyze/{job_id} to cancel
 *     the job on the backend, which sets status = "cancelled".
 *   - The Chrome extension polls /api/extension/status/{job_id} and exits
 *     scraping immediately when it sees status = "cancelled".
 *   - MAX_POLL_ATTEMPTS increased to 200 (10 minutes) to match backend timeout.
 */
import { API_BASE_URL, MAX_COMMENTS } from '../constants';

// ── Global last report store ───────────────────────────────────────────────
let _lastReport = null;

export function getLastReport()       { return _lastReport; }
export function setLastReport(report) { _lastReport = report; }
export function clearLastReport()     { _lastReport = null; }

// ── Polling config ─────────────────────────────────────────────────────────
const POLL_INTERVAL_MS  = 3000;   // poll every 3 seconds
const MAX_POLL_ATTEMPTS = 200;    // 200 × 3s = 10 minutes max (matches backend)

// ── Health check ───────────────────────────────────────────────────────────
export async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
    });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    throw new Error(`Server unreachable: ${err.message}`);
  }
}

// ── Cancel a job on the backend ────────────────────────────────────────────
async function cancelJob(jobId) {
  if (!jobId) return;
  try {
    await fetch(`${API_BASE_URL}/api/analyze/${jobId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
    });
    console.log('🛑 Job cancelled:', jobId);
  } catch (err) {
    console.warn('⚠️ Failed to cancel job:', err.message);
  }
}

// ── Analyze post ───────────────────────────────────────────────────────────
export async function analyzePost(
  postUrl,
  cookies = '',
  maxComments = MAX_COMMENTS,
) {
  // ── Step 1: Submit job ─────────────────────────────────────────────────
  let submitData;
  try {
    const res = await fetch(`${API_BASE_URL}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({
        post_url:     postUrl,
        max_comments: maxComments,
        cookies:      cookies,
      }),
    });

    submitData = await res.json().catch(() => ({}));
    console.log('🔥 JOB SUBMITTED:', submitData);

    if (!res.ok) {
      throw new Error(
        submitData.detail || submitData.message || `Server error ${res.status}`
      );
    }
  } catch (err) {
    console.log('💥 SUBMIT FAILED:', err.message);
    throw err;
  }

  const { job_id } = submitData;
  if (!job_id) {
    throw new Error('Server did not return a job_id. Check server version.');
  }

  // ── Step 2: Poll for status — cancel job if we give up ────────────────
  let attempts = 0;

  try {
    while (attempts < MAX_POLL_ATTEMPTS) {
      await _sleep(POLL_INTERVAL_MS);
      attempts++;

      let statusData;
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/analyze/status/${job_id}`,
          { headers: { 'ngrok-skip-browser-warning': 'true' } },
        );
        statusData = await res.json().catch(() => ({}));
      } catch (err) {
        console.log(`⏳ Poll attempt ${attempts} failed, retrying...`);
        continue;
      }

      const { status, progress } = statusData;
      console.log(`⏳ [${attempts}] status=${status} | ${progress}`);

      if (status === 'done') break;

      if (status === 'failed') {
        throw new Error(progress || 'Analysis failed on the server.');
      }

      if (status === 'cancelled') {
        throw new Error('Analysis was cancelled.');
      }
    }

    // Timed out — cancel job so extension stops scraping
    if (attempts >= MAX_POLL_ATTEMPTS) {
      console.warn('⏰ Timeout reached — cancelling job', job_id);
      await cancelJob(job_id);
      throw new Error('Analysis timed out after 10 minutes. Please try again.');
    }

  } catch (err) {
    // Any error during polling — cancel the job to stop the extension
    if (err.message !== 'Analysis was cancelled.') {
      await cancelJob(job_id);
    }
    throw err;
  }

  // ── Step 3: Fetch result ───────────────────────────────────────────────
  let data;
  try {
    const res = await fetch(
      `${API_BASE_URL}/api/analyze/result/${job_id}`,
      { headers: { 'ngrok-skip-browser-warning': 'true' } },
    );

    data = await res.json().catch(() => ({}));
    console.log('🔥 FULL BACKEND RESPONSE:', data);

    if (!res.ok) {
      throw new Error(
        data.detail || data.message || `Server error ${res.status}`
      );
    }
  } catch (err) {
    console.log('💥 RESULT FETCH FAILED:', err.message);
    throw err;
  }

  setLastReport(data);
  return data;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}