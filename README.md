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
| `RATE_LIMIT_DAILY_PER_IP` | Max analyses per IP per 24h (default **200**, clamped 20–5000). |
| `HTML_FETCH_TIMEOUT_MS` | HTML fetch timeout (default **15000**, clamped 8s–20s). |
| `HTML_FETCH_MAX_REDIRECTS` | Follow redirects only on the **same registrable host** (default **2**, max **5**). |
| `CLAUDE_MAX_TOKENS` | Output cap (default **8000**, max **8192**). |
| `CLAUDE_STREAM_TIMEOUT_MS` | Abort Claude stream if stalled (default **180000**). |
| `RELAX_ANALYZE_ORIGIN_CHECK` | Set to `true` only if you must call `/api/analyze` without a browser `Origin` (discouraged). |

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

**Automated smoke checks** (with the server running on port 3001):

```bash
cd backend
npm run smoke
```

Covers health, empty input, SSRF rejection on `127.0.0.1`, and honeypot rejection. End-to-end streaming still needs a valid `ANTHROPIC_API_KEY` and manual browser checks.

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

- **CORS:** Explicit allowlist only; `*` entries in `CORS_ORIGINS` are stripped with a warning.
- **Browser origin (production):** `POST /api/analyze` requires an `Origin` header that matches `CORS_ORIGINS` (reduces scripted abuse). Override with `RELAX_ANALYZE_ORIGIN_CHECK=true` only if needed.
- **Rate limits:** Per-minute **and** per-24h caps on `/api/analyze` (cost protection).
- **SSRF:** DNS resolution with blocking of private/link-local/CGNAT ranges and metadata-style hostnames (`backend/ssrf.js`). URLs with embedded credentials are rejected.
- **Redirects:** Only same host key (after stripping leading `www.`) as the initial URL; `http`/`https` only.
- **Uploads:** PNG/JPEG/WebP only, magic-byte verification, **20MB × 10**, Multer field/part limits; files renamed to `upload-N.ext` server-side.
- **Honeypot:** Hidden `hp` field must be empty.
- **Errors:** Production uses generic client messages; stack traces and internals stay in logs only.
- **Secrets:** Anthropic key server-only; never returned to the browser.
- **Sharp** re-encodes images before Claude.
- **Logs:** `analyze_request`, `analyze_success`, `analyze_failure`, `analyze_claude_timeout`, `analyze_honeypot_triggered`, `analyze_blocked_origin`, `html_fetch_failed`, etc.

## License

Use freely for your own projects.
