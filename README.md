# MoodSentinel

> Sentiment and emotion analysis for Facebook comments — powered by mBERT and ABSA.

MoodSentinel is a monorepo containing three components that work together:

- **backend** — FastAPI Python service that runs the NLP analysis pipeline
- **frontend** — Expo React Native mobile app for submitting jobs and viewing results
- **extension** — Chrome extension that scrapes Facebook comments and bridges them to the backend

---

## Repository Structure

```
MoodSentinel/
├── backend/                  Python FastAPI backend
│   ├── services/             Language detection, translation, ABSA, emotion, pipeline
│   ├── server.py             Main FastAPI application and job queue
│   ├── extension_router.py   Chrome extension bridge endpoints
│   ├── requirements.txt      Python dependencies
│   ├── Dockerfile            Container build
│   ├── .dockerignore
│   └── .env.example
│
├── frontend/                 Expo React Native mobile app
│   ├── app/                  Expo Router route files
│   ├── assets/               App icons and images
│   ├── src/
│   │   ├── components/       Reusable UI components
│   │   ├── constants/        Theme constants and API URL config
│   │   ├── hooks/            Analysis hooks
│   │   ├── screens/          Browser and dashboard screens
│   │   ├── services/         Backend API client
│   │   └── utils/            Helper utilities
│   ├── app.json
│   ├── eas.json
│   ├── package.json
│   └── tsconfig.json
│
└── extension/                Chrome extension (scraper bridge)
    ├── background.js         Service worker — polls backend and scrapes Facebook
    ├── popup.html            Extension popup UI
    ├── popup.js              Popup logic
    ├── manifest.json         Chrome extension manifest
    ├── icon16.jpg
    ├── icon48.jpg
    └── icon128.jpg
```

---

## How It Works

```
Mobile app (frontend)
  -> POST /api/analyze        Submit a Facebook post URL
  -> backend creates a job
  -> Chrome extension polls   GET /api/extension/pending
  -> extension scrapes        Facebook comments from the live DOM
  -> extension submits        POST /api/extension/submit
  -> backend pipeline runs    Language detect -> translate -> ABSA -> emotion
  -> mobile app polls         GET /api/analyze/status/{job_id}
  -> mobile app fetches       GET /api/analyze/result/{job_id}
```

---

## Quick Start

### Backend

```bash
cd backend
cp .env.example .env
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

API docs available at `http://localhost:8000/docs`

### Frontend

```bash
cd frontend
cp .env.example .env
# Set EXPO_PUBLIC_API_BASE_URL=http://localhost:8000 (or your ngrok URL)
npm install
npx expo start
```

### Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo

### Backend via Docker

```bash
cd backend
docker build -t moodsentinel-backend .
docker run -p 8000:8000 --env-file .env moodsentinel-backend
```

---

## Backend API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Service health and status |
| GET | `/api/ngrok-url` | Auto-detect active ngrok tunnel |
| POST | `/api/analyze` | Submit a Facebook post for analysis |
| GET | `/api/analyze/status/{job_id}` | Poll job progress |
| GET | `/api/analyze/result/{job_id}` | Fetch completed result |
| POST | `/api/analyze/batch` | Analyze raw comments directly |
| GET | `/api/extension/pending` | Extension polls for next job |
| POST | `/api/extension/submit` | Extension submits scraped comments |
| POST | `/api/extension/fail` | Extension reports scraping failure |
| GET | `/api/extension/status` | Extension health check |
| GET | `/api/extension/status/{job_id}` | Per-job extension status |

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Python 3.10+, FastAPI, Uvicorn, PyTorch, Transformers, PyABSA |
| Frontend | Expo, React Native, Expo Router, TypeScript |
| Extension | Chrome Extension (Manifest V3), JavaScript |
| Deployment | Docker, ngrok |

---

## Environment Variables

### Backend (`backend/.env`)

```env
PORT=8000
MOODSENTINEL_MAX_COMMENTS=200
MOODSENTINEL_MIN_COMMENTS=3
MOODSENTINEL_USE_EXTENSION=true
MOODSENTINEL_EXTENSION_TIMEOUT=900
MOODSENTINEL_INFERENCE_MODE=absa
```

### Frontend (`frontend/.env`)

```env
EXPO_PUBLIC_API_BASE_URL=http://localhost:8000
```

---

## Notes

- Jobs and results are stored in memory and cleared on process restart. For production, replace with Redis or a database.
- On a physical phone, replace `localhost` with your computer LAN IP or ngrok public URL.
- Model checkpoints, datasets, and local build artifacts are excluded from this repo via `.gitignore`.
- No license file is currently present. Add a `LICENSE` before publishing publicly.
