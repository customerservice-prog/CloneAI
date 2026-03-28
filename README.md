# CloneAI

Full-stack AI website clone analyzer: a vanilla Vite frontend and Node.js/Express backend that streams a detailed developer brief from Claude (Anthropic).

## Prerequisites

- Node.js 18+ (includes native `fetch` used by the backend)
- An [Anthropic API key](https://console.anthropic.com/)

## Anthropic API key

1. Create `backend/.env` if it is not present (it is not committed).
2. Add your key:

```env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Never commit real keys. `backend/.env` is listed in `.gitignore`.

## Run locally

**Terminal 1 — backend**

```bash
cd backend
npm install
npm start
```

Server listens on [http://localhost:3001](http://localhost:3001). Health check: [http://localhost:3001/api/health](http://localhost:3001/api/health).

**Terminal 2 — frontend**

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Submit a URL and/or images; the UI streams the brief from the backend via SSE.

## Deploy

**Frontend (Vercel)**

1. Push this repo to GitHub.
2. In [Vercel](https://vercel.com), import the repository.
3. Set **Root Directory** to `frontend`, framework **Vite**, build command `npm run build`, output `dist`.
4. Add an environment variable if you later proxy API calls through Vercel; for a split setup, point the frontend at your hosted backend URL (you would change `API_ANALYZE` in `frontend/src/main.js` or use `import.meta.env`).

**Backend (Railway or Render)**

1. Create a new **Web Service** from the same repo (or a backend-only repo).
2. Set **Root Directory** to `backend`, start command `npm start` (or `node server.js`).
3. Set `ANTHROPIC_API_KEY` in the provider’s environment variables.
4. Enable HTTPS; update the frontend `API_ANALYZE` URL to `https://your-service.onrender.com/api/analyze` (or your Railway URL).

CORS is open for all origins in `server.js` for easier local dev; tighten `cors()` for production if needed.

## Project layout

```
backend/     Express API, Claude streaming, multer uploads
frontend/    Vite + vanilla HTML/CSS/JS
```

## License

Private / use as you like for your own projects.
