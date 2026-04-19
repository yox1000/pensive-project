# Graphfol (HackPrinceton Project)

Graphfol is an AI-assisted medical scan explorer that combines:
- 2D NIfTI slice viewing
- 3D segmented anatomy exploration
- AR visualization with gesture controls
- Voice Q&A with spoken responses

This repository contains the web app (frontend + Node.js API gateway). The segmentation engine is expected to run as a separate backend service.

## Table of Contents
1. Overview
2. What This Repo Includes
3. Tech Stack
4. Setup
5. Environment Variables
6. Run Locally
7. Backend Contract (Required)
8. API Routes in This Server
9. Attribution and Contribution Boundaries (Devpost Requirement)
10. Troubleshooting
11. Limitations

## Overview
Graphfol lets a user upload a NIfTI scan, routes it to a segmentation backend, then presents:
- 2D multiplanar slices via NiiVue
- 3D mesh viewing via Three.js
- structure-level selection, highlighting, and volume display
- patient-facing AI summaries
- AR mode with hand-gesture controls and voice interaction

## What This Repo Includes
- `index.html`: Single-page UI, visualization logic, AR/gesture interaction, and client-side orchestration.
- `server.js`: Express server, static hosting, proxying to segmentation backend, and AI/TTS orchestration endpoints.
- `elevenlabs/tts.js`: ElevenLabs text-to-speech wrapper.
- `elevenlabs/intent.js`: Intent classification helper for voice AR commands.
- `.env.example`: Environment variable template.

## Tech Stack

### Runtime and Server
- Node.js (CommonJS)
- Express
- Multer
- http-proxy-middleware
- dotenv

### Visualization and Interaction
- NiiVue (`@niivue/niivue`)
- Three.js (`three`, OrbitControls, GLTFLoader, ARButton)
- WebXR (browser API)
- MediaPipe Hands (`@mediapipe/hands`, `@mediapipe/camera_utils`, `@mediapipe/drawing_utils`)
- Web Speech API (browser speech recognition)

### External AI / Speech Services
- K2 API (chat completion/report generation and voice answers)
- BiMediX2 endpoint (optional primary analyzer target)
- DeepSeek API (intent classification + transcription fallback path)
- ElevenLabs API (text-to-speech output)

## Setup

### Prerequisites
- Node.js 18+ (20+ recommended)
- npm
- A running segmentation backend (see Backend Contract section)
- API keys for services you plan to use (`K2`, `DeepSeek`, `ElevenLabs`)

### Install
```bash
npm install
cp .env.example .env
```

## Environment Variables
Set these in `.env`:

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No | Express port (default: `3000`) |
| `BACKEND_URL` | Yes | Segmentation backend base URL for fetch/proxy |
| `BACKEND_URL_DIRECT` | No | Optional direct upload URL for large file posts (falls back to `BACKEND_URL`) |
| `K2_API_KEY` | Yes (for analysis/voice) | Auth key for K2 chat endpoint |
| `K2_API_URL` | Yes (for analysis/voice) | K2 chat completion endpoint |
| `K2_MODEL` | Yes (for analysis/voice) | Model name used in K2 requests |
| `DEEPSEEK_API_KEY` | Yes (for intent/STT fallback) | DeepSeek key for intent classification and fallback transcription |
| `ELEVENLABS_API_KEY` | Yes (for voice playback) | ElevenLabs TTS key |
| `ELEVENLABS_VOICE_ID` | No | ElevenLabs voice id (default Rachel id in code) |
| `BIMEDIX_URL` | No | Optional BiMediX2-compatible endpoint (default local vLLM URL) |
| `BIMEDIX_MODEL` | No | Optional BiMediX2 model label |

## Run Locally
```bash
npm start
```

Then open:
```text
http://localhost:3000
```

## Backend Contract (Required)
This app depends on an external segmentation backend (default expected at `http://localhost:9999`) with endpoints compatible with:

- `POST /segment` (multipart file upload)
- `POST /segment/demo?mode=brain|lung|leg`
- `GET /structures/:scanId`
- `GET /mesh/:scanId` (GLB)
- `GET /scan/:scanId` (NIfTI gzip)
- `GET /segmentation/:scanId` (NIfTI gzip overlay)
- `GET /analyze/:scanId`

`server.js` proxies/forwards requests to this backend via `BACKEND_URL` / `BACKEND_URL_DIRECT`.

## API Routes in This Server

### Segmentation Proxy
- `POST /api/segment`
- `POST /api/segment/demo?mode=...`

### Backend Data Proxy
- `GET /api/backend/*`
- `GET /api/structures/:scanId`
- `GET /api/mesh/:scanId`
- `GET /api/scan/:scanId`
- `GET /api/segmentation/:scanId`
- `GET /api/analyze/:scanId`

### AI and Voice
- `POST /api/analyze` (SSE stream, patient-facing summary generation)
- `POST /api/voice-query` (question -> answer + intent + TTS audio)
- `POST /api/whisper` (fallback transcription path)

## Typical User Flow
1. User uploads `.nii` or `.nii.gz`.
2. App sends file to `/api/segment/demo` (or `/api/segment` path contract).
3. Server forwards upload to segmentation backend and returns `scan_id` + structures.
4. Frontend loads:
- 2D scan volume (`/api/scan/:scanId`)
- optional segmentation overlay (`/api/segmentation/:scanId`)
- 3D GLB anatomy mesh (`/api/mesh/:scanId`)
5. User explores structures, requests report, or opens AR mode.
6. Optional voice mode sends question context to `/api/voice-query`, receives intent + TTS audio response.

## Attribution and Contribution Boundaries (Devpost Requirement)
This section is intentionally explicit for hackathon compliance.

### Public Frameworks, Libraries, and APIs Used
- **NiiVue** for 2D NIfTI rendering.
- **Three.js** and built-in addons (OrbitControls, GLTFLoader, ARButton) for 3D and WebXR.
- **MediaPipe Hands** for hand landmark tracking and gesture input.
- **Express / Multer / http-proxy-middleware / dotenv** for server and upload/proxy infrastructure.
- **K2 API**, **DeepSeek API**, and **ElevenLabs API** for language, intent/transcription fallback, and text-to-speech.
- **BiMediX2 endpoint support** (if configured) for model inference compatibility.

### What Our Team Built in This Repository
- End-to-end web application flow from upload -> visualization -> report -> AR voice interaction.
- UI/UX logic for structure selection, highlighting, toggles, and report rendering.
- API gateway logic connecting frontend to segmentation and model services.
- Voice interaction orchestration pipeline:
  question capture -> intent classification -> answer generation -> TTS playback.
- AR overlay behavior and gesture-driven controls for scaling, rotating, and selecting structures.

### What We Did Not Build Here
- The underlying open-source/public frameworks listed above.
- Hosted external model providers and speech providers (K2/DeepSeek/ElevenLabs).
- The segmentation model/service itself (this repo expects a separate backend that provides segmentation endpoints).

## Troubleshooting
- Upload fails immediately:
  check `BACKEND_URL`/`BACKEND_URL_DIRECT` and verify segmentation backend is reachable.
- Report generation fails:
  confirm `K2_API_KEY`, `K2_API_URL`, and `K2_MODEL` are valid.
- Voice answer has no audio:
  confirm `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`.
- AR button or AR session unavailable:
  device/browser likely lacks WebXR AR support; desktop browsers often do not support immersive AR.
- Hand tracking not active:
  check camera permission and ability to load MediaPipe CDN scripts.

## Limitations
- Not a medical device; outputs are informational only and not clinical advice.
- Requires external services and keys for full functionality.
- Browser AR/voice behavior depends on platform support and permissions.
- Large file handling and latency depend on segmentation backend performance and network conditions.
