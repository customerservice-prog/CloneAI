# Render deploy — GitHub + Render + Namecheap

**Recommended production stack:** push code to **GitHub**, deploy with **Render** (API + static site from [`render.yaml`](../render.yaml)), point DNS at **Namecheap** using the records Render shows. No Vercel required.

Full DNS steps: **[NAMECHEAP_RENDER.md](./NAMECHEAP_RENDER.md)**.

---

## Before you open Render

1. **OpenAI:** Create an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).  
   - Never paste it in chat. Only in **Render → Environment** for **`cloneai-api`**.

2. **Canonical site URL** (CORS / Stripe):
   - **`https://siteclonerpro.com`** (apex). **`https://www.siteclonerpro.com`** is included in `CORS_ORIGINS` in `render.yaml`.

---

## Fast path — Blueprint (both services)

1. Render → **New** → **Blueprint** → connect **GitHub** → select this repo.
2. Approve **`render.yaml`**: creates **`cloneai-api`** (Docker) + **`cloneai-web`** (static).
3. Set **`OPENAI_API_KEY`** when prompted.
4. After deploy, set **`cloneai-web`** → **Environment** → **`VITE_API_URL`** to your **`cloneai-api`** URL if it is not already correct.
5. Add **custom domains** and Namecheap records per **[NAMECHEAP_RENDER.md](./NAMECHEAP_RENDER.md)**.

---

## Manual path — API only (then add static site)

If you prefer not to use the Blueprint for the API:

### A. Connect GitHub

- **New** → **Web Service** → select repo → branch **main**.

### B. Use Docker (important)

- **Runtime:** **Docker** (not “Node”).
- **Dockerfile path:** `backend/Dockerfile`
- **Docker context:** `backend`

### C. Name, region, size

- **Name:** e.g. `cloneai-api`.
- **Region:** closest to you.
- **Starter** is OK; upgrade RAM if Chromium crashes on large sites.

### D. Environment variables (first deploy)

| Key | Value |
|-----|--------|
| `OPENAI_API_KEY` | *(your key)* |
| `NODE_ENV` | `production` |
| `PORT` | *(omit — Render sets this automatically)* |
| `CORS_ORIGINS` | `https://siteclonerpro.com,https://www.siteclonerpro.com` |
| `FRONTEND_URL` | `https://siteclonerpro.com` |

`render.yaml` presets **`CORS_ORIGINS`** / **`FRONTEND_URL`** when you use the Blueprint.

### E. Deploy

- Wait for **Live**. Test: `https://YOUR-SERVICE.onrender.com/api/health`.

### F. Static frontend on Render

Either let the **Blueprint** create **`cloneai-web`**, or **New** → **Static Site** → same repo, **build** `cd frontend && npm ci && npm run build`, **publish directory** `frontend/dist`, add a **rewrite** `/*` → `/index.html`, and set **`VITE_API_URL`** + **`VITE_PUBLIC_APP_URL`** like in `render.yaml`.

---

## If Render shows “Check for errors above”

- Fix any **red** env rows (no trailing spaces in **Key** names).
- Remove variables you do not need.

---

## DNS: apex must hit the static site, not the API

- Follow **[NAMECHEAP_RENDER.md](./NAMECHEAP_RENDER.md)** (remove Namecheap **URL Redirect** rows).
- **Apex** → **`cloneai-web`** (per Render’s custom-domain instructions).
- **API** → default `*.onrender.com` or **`api.`** subdomain on **`cloneai-api`**.

If **`https://siteclonerpro.com`** shows JSON from the API, apex DNS still points at the wrong host.

---

## Quick test

```text
https://YOUR-API.onrender.com/api/health
```

→ JSON `ok`.

---

## Still stuck?

- **`render.yaml`** comments list more env vars.
- Full checklist: **[LAUNCH_PHASES.md](./LAUNCH_PHASES.md)**.
- Local: `cd backend && cp .env.example .env` → `OPENAI_API_KEY` → `npm start`.
