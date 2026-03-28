# CloneAI

Production-oriented full-stack AI website clone analyzer: Vite + vanilla frontend, Node/Express backend, Claude streaming over SSE.

## Prerequisites

- Node.js 20+ recommended (Sharp prebuilds)
- [Anthropic API key](https://console.anthropic.com/)

## Backend (`backend/.env`)

Required:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Recommended for production:

```env
NODE_ENV=production
PORT=3001
CORS_ORIGINS=https://your-app.vercel.app
```

| Variable | Purpose |
|----------|---------|
| `CORS_ORIGINS` | **Required in production:** comma-separated frontend origins (no `*`). Dev defaults include `http://localhost:5173`. |
| `CLONEAI_INGRESS_KEY` | Optional shared secret; browser sends `X-CloneAI-Key` (set `VITE_CLONEAI_KEY` on the frontend). |
| `RATE_LIMIT_PER_MINUTE` | Max `POST /api/analyze` per IP per minute (default **8**, clamped 5–30). |
| `HTML_FETCH_TIMEOUT_MS` | HTML fetch timeout (default **15000**, clamped 8s–20s). |
| `CLAUDE_MAX_TOKENS` | Output cap (default **8000**, max **8192**). |
| `CLAUDE_STREAM_TIMEOUT_MS` | Abort Claude stream if stalled (default **180000**). |

## Frontend (local / Vercel)

| Variable | Purpose |
|----------|---------|
| `VITE_API_URL` | **Required for production builds:** API origin only, e.g. `https://cloneai-api.onrender.com` (no path, no trailing slash). Local dev falls back to `http://localhost:3001`. |
| `VITE_CLONEAI_KEY` | Matches `CLONEAI_INGRESS_KEY` when enabled. |

## Run locally

**Backend**

```bash
cd backend
npm install
npm start
```

**Frontend**

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Deploy

**Render / Railway (backend)**  
Root `backend`, start `npm start`, set env vars above. Confirm `GET /api/health`.

**Vercel (frontend)**  
Root `frontend`, framework Vite, output `dist`, set `VITE_API_URL` to the public API origin.

## Security & limits (launch checklist)

- CORS allowlist only (no wildcard in production path).
- Rate limit on analyze (per minute, per IP).
- URL validation (http/https, length, blocks loopback).
- Images: PNG/JPEG/WebP only, magic-byte check, 20MB × 10 max (Multer).
- Screenshots re-encoded/resized with **Sharp** before Claude to cut payload size.
- Structured JSON logs: `analyze_request`, `analyze_success`, `analyze_failure`, `analyze_claude_timeout`.

## License

Use freely for your own projects.
