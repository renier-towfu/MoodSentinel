# MoodSentinel Frontend

## Overview

MoodSentinel Frontend is an Expo React Native app for submitting Facebook post analysis jobs to the MoodSentinel backend and viewing sentiment, emotion, language, aspect, and exportable report results.

This repository is the frontend only. The backend is maintained separately at `C:\Projects\MoodSentinel\backend`, and the browser extension that performs scraping is maintained separately from this app.

## Features

- Expo Router based mobile app.
- Facebook post analysis workflow.
- Backend health and analysis API integration.
- Analysis dashboard with sentiment, emotion, language, metadata, and per-comment views.
- CSV export support through Expo file/sharing modules.
- Android/EAS build configuration.

## Technologies Used

- Expo
- React Native
- Expo Router
- React Navigation dependencies
- react-native-webview
- react-native-svg
- expo-file-system
- expo-sharing

## Architecture

```text
app/
-> Expo Router routes
-> src/screens/*
-> src/services/api.js
-> MoodSentinel backend API
-> separate browser extension handles scraping
```

## Installation

```bash
npm install
```

Copy the example environment file:

```bash
copy .env.example .env
```

Set the backend URL:

```env
EXPO_PUBLIC_API_BASE_URL=http://localhost:8000
```

For a physical phone, use your computer LAN IP or ngrok URL instead of `localhost`.

## Usage

Start the app:

```bash
npm run start
```

Run on Android:

```bash
npm run android
```

Run on web:

```bash
npm run web
```

## Folder Structure

```text
app/                 Expo Router route files
src/components/      Reusable UI components
src/constants/       Theme constants and API URL config
src/hooks/           Analysis hooks
src/screens/         Browser and dashboard screens
src/services/        Backend API client
src/utils/           Helper utilities
assets/              App images/icons
```

Local-only folders such as `node_modules/`, `.expo/`, native build outputs, the copied `backend/`, and the older nested `mobile/` app are ignored for the public frontend upload.

## API Configuration

The app reads:

```env
EXPO_PUBLIC_API_BASE_URL
```

Required backend endpoints:

- `GET /api/health`
- `POST /api/analyze`
- `GET /api/analyze/status/{job_id}`
- `GET /api/analyze/result/{job_id}`

## Screenshots

Placeholders:

- Browser screen
- Analysis progress screen
- Dashboard report screen
- CSV export flow

## Troubleshooting

- If the backend is unreachable on a phone, replace `localhost` with your computer LAN IP or ngrok URL.
- If exports fail, confirm `expo-file-system` and `expo-sharing` are installed.
- If routes do not load, clear Expo cache with `npx expo start -c`.
- Do not commit `.env`, `node_modules/`, `.expo/`, build folders, or local backend copies.

## Future Improvements

- Add a dedicated settings screen for backend URL selection.
- Add automated tests for API helpers and dashboard rendering.
- Add screenshots and release build instructions.
- Normalize legacy mojibake comments/emoji encoding in source files.

## License

No license file is currently present. Add a `LICENSE` file before publishing publicly.
