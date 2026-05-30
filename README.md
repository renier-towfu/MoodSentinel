# MoodSentinel Backend

## Overview

MoodSentinel Backend is a FastAPI service for analyzing Facebook comments across English, Tagalog, and Taglish. It receives scraped comments from the separate MoodSentinel browser extension, processes them through the NLP pipeline, and returns sentiment, emotion, language, and aspect-level analysis.

The frontend is maintained separately at `C:\MS\MoodSentinel`. The browser extension is also maintained outside this backend repository.

## Features

- FastAPI REST API with health, batch analysis, queued analysis, and result polling.
- Browser-extension bridge for receiving scraped Facebook comments.
- English, Tagalog, and Taglish language detection.
- Optional Tagalog/Taglish translation before ABSA.
- Aspect-based sentiment analysis with fallback behavior.
- Emotion classification with sentiment-aware filtering.
- In-memory job queue and result store.
- Dockerfile for backend deployment.

## Technologies Used

- Python 3.10+
- FastAPI and Uvicorn
- Pydantic
- PyTorch
- Transformers
- PyABSA
- langdetect
- deep-translator
- Docker

## Architecture

```text
Frontend/mobile app
-> POST /api/analyze
-> backend creates job
-> browser extension polls /api/extension/pending
-> extension scrapes Facebook comments
-> extension submits comments to /api/extension/submit
-> services.pipeline processes comments
-> frontend polls status/result endpoints
```

Pipeline:

```text
comment
-> clean text
-> detect language
-> translate if needed
-> extract aspects and sentiment
-> classify emotion
-> aggregate distributions and breakdown
```

## Installation

Create and activate a virtual environment:

```bash
python -m venv .venv
.venv\Scripts\activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

The public backend upload intentionally excludes local model artifacts, checkpoints, datasets, evaluation outputs, figures, Facebook cookies, the frontend, and the browser extension package.

## Configuration

Copy the example environment file:

```bash
copy .env.example .env
```

Common settings:

```env
PORT=8000
MOODSENTINEL_MAX_COMMENTS=200
MOODSENTINEL_MIN_COMMENTS=3
MOODSENTINEL_USE_EXTENSION=true
MOODSENTINEL_EXTENSION_TIMEOUT=900
MOODSENTINEL_INFERENCE_MODE=absa
MOODSENTINEL_ABSA_CHECKPOINT=multilingual
```

Do not commit `.env`, Facebook cookies, credentials, datasets with private data, model checkpoints, or local virtual environments.

## Usage

Run the API:

```bash
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

Open API docs:

```text
http://localhost:8000/docs
```

Health check:

```bash
curl http://localhost:8000/api/health
```

Batch analysis:

```bash
curl -X POST http://localhost:8000/api/analyze/batch ^
  -H "Content-Type: application/json" ^
  -d "{\"comments\":[\"Ang ganda nito!\", \"The delivery was slow.\"]}"
```

## Folder Structure

```text
services/              Runtime language, translation, ABSA, emotion, and pipeline code
server.py              FastAPI application
extension_router.py    Browser extension bridge
requirements.txt       Python dependencies
Dockerfile             Container build
.dockerignore          Keeps local artifacts out of Docker images
.gitignore             Keeps local artifacts out of Git
```

Local-only folders such as `models/`, `checkpoints/`, `data/`, `figures/`, `eval_results/`, and `evaluation_results/` are ignored and should not be uploaded to GitHub.

## Screenshots

Placeholders:

- API documentation screenshot
- Frontend dashboard screenshot
- Browser extension screenshot
- Analysis result screenshot

## API Documentation

Core endpoints:

- `GET /api/health`
- `GET /api/ngrok-url`
- `POST /api/analyze`
- `GET /api/analyze/status/{job_id}`
- `GET /api/analyze/result/{job_id}`
- `POST /api/analyze/batch`
- `GET /api/extension/pending`
- `POST /api/extension/submit`
- `POST /api/extension/fail`
- `GET /api/extension/status`
- `GET /api/extension/status/{job_id}`

Interactive OpenAPI docs are available at `/docs` when the server is running.

## Database Setup

No database is currently required. Jobs and results are stored in memory and are cleared on process restart. For production use, replace the in-memory job store with Redis, PostgreSQL, or another persistent queue/result backend.

## Troubleshooting

- If `/api/health` reports `pipeline_ready=false`, check missing dependencies and model availability.
- If extension jobs time out, confirm the browser is running, the extension is installed, and `MOODSENTINEL_EXTENSION_TIMEOUT` is high enough.
- If ngrok auto-detection fails, verify ngrok is running locally and its API is available at `http://127.0.0.1:4040/api/tunnels`.
- If Docker builds are slow or huge, confirm `.dockerignore` is present and model/checkpoint folders are not copied into the image.

## Future Improvements

- Add persistent job storage.
- Add automated tests for API and pipeline behavior.
- Document the separate frontend and browser extension repositories/folders.
- Externalize model artifacts with checksums and download scripts.
- Normalize text encoding across source files.
- Add CI for linting, tests, and Docker build validation.

## License

No license file is currently present. Add a `LICENSE` file before publishing publicly.
