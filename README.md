# CloneAI

Full-stack AI website clone analyzer: a vanilla Vite frontend and Node.js/Express backend that streams a detailed developer brief from Claude (Anthropic).

## Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)

## Backend environment (`backend/.env`)

Create `backend/.env` (not committed) with:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Optional:

| Variable | Purpose |
|----------|---------|
| `PORT` | Listen port (default `3001`) |
| `CORS_ORIGINS` | Comma-separated allowed browser origins, e.g. `https://your-app.vercel.app,http://localhost:5173`. Use `*` only if you accept any origin. If unset in **production**, browsers are denied until you set this. |
| `CLONEAI_INGRESS_KEY` | If set, clients must send header `X-CloneAI-Key` with the same value (pair with `VITE_CLONEAI_KEY` on the frontend). |
| `RATE_LIMIT_MAX` | Max `/api/analyze` requests per IP per 15 minutes (default `30`). |
| `CLAUDE_MAX_TOKENS` | Cap output tokens (default `8192`, max clamped in code). |

## Frontend environment (local / Vercel)

| Variable | Purpose |
|----------|---------|
| `VITE_API_URL` | Backend base URL **without** trailing slash, e.g. `https://cloneai-api.onrender.com`. Omit for local dev (`http://localhost:3001`). |
| `VITE_CLONEAI_KEY` | Must match `CLONEAI_INGRESS_KEY` when that is enabled. |

On Vercel: Project → Settings → Environment Variables → add `VITE_API_URL` (and optional `VITE_CLONEAI_KEY`), then redeploy.

## Run locally

**Terminal 1 — backend**

```bash
cd backend
npm install
npm start
```

- API: [http://localhost:3001](http://localhost:3001)
- Health: [http://localhost:3001/api/health](http://localhost:3001/api/health)

**Terminal 2 — frontend**

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Deploy

**Frontend (Vercel)**

1. Import the GitHub repo.
2. **Root Directory:** `frontend`
3. Framework: **Vite**; build `npm run build`; output `dist`.
4. Set `VITE_API_URL` to your hosted backend origin (no path).

**Backend (Railway or Render)**

1. **Root Directory:** `backend`
2. Start: `npm start`
3. Set `ANTHROPIC_API_KEY`, `CORS_ORIGINS` (your Vercel URL), and `NODE_ENV=production`.
4. Optional: `CLONEAI_INGRESS_KEY` + frontend `VITE_CLONEAI_KEY`.

## Behavior notes

- **Pipeline:** The backend emits SSE `stage` events (8 agents) before streaming Claude output, so the progress UI matches server-side steps.
- **Scraping:** Many sites block bots; the API detects common challenge pages and tells Claude to rely on screenshots. Prefer **Image** or **URL + Images** when a fetch fails.
- **Streaming:** Responses use `text/event-stream` with `X-Accel-Buffering: no` to reduce proxy buffering.

## Project layout

```
backend/     Express API, rate limit, CORS, Claude streaming, multer uploads
frontend/    Vite + vanilla HTML/CSS/JS
```

## License

Private / use as you like for your own projects.
