# Render deploy — simple checklist (CloneAI API)

Do these **in order**. Skip any step that does not apply.

---

## Before you open Render

1. **OpenAI:** Create an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).  
   - Never paste it in Discord, email, or chat. Only paste it inside **Render → Environment**.

2. **Know your site URL** (for CORS):
   - Live site: **`https://www.siteclonerpro.com`** (apex `https://siteclonerpro.com` is included in `CORS_ORIGINS` in `render.yaml`).

---

## On Render: create the API (Web Service)

### A. Connect GitHub

- **New** → **Web Service** → select repo **CloneAI** → branch **main**.

### B. Use Docker (important)

- **Runtime:** **Docker** (not “Node”).
- **Dockerfile path:** `backend/Dockerfile`
- **Docker context:** `backend`  
  (If the form only shows one path, set **Dockerfile path** to `backend/Dockerfile` and leave **Root Directory** empty unless Render says otherwise.)

### C. Name and region

- **Name:** anything (e.g. `cloneai-api`).
- **Region:** pick closest to you.

### D. Instance size

- **Starter** is OK to try.  
- If the app **crashes** on big sites, upgrade to **Standard (2 GB RAM)**.

### E. Environment variables (only these at first)

Click **Add Environment Variable** for each row:

| Key | Value |
|-----|--------|
| `OPENAI_API_KEY` | *(paste your OpenAI key)* |
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `CORS_ORIGINS` | `https://www.siteclonerpro.com,https://siteclonerpro.com` |
| `FRONTEND_URL` | `https://www.siteclonerpro.com` |

**Repo default:** `render.yaml` already sets `CORS_ORIGINS` and `FRONTEND_URL` for this domain when you use the Blueprint. Override in the dashboard if your canonical URL changes.

**Do not add** random keys from other tutorials: no `DATABASE_URL`, `UPSTASH_*`, `TURBO_*`, `NEXT_PUBLIC_*`, `RESEND_*` unless you really use them. They are **not** required for CloneAI.

### F. Billing (Stripe) — optional, later

- Leave **`BILLING_ENABLED`** unset or set to **`false`** until Stripe is configured.
- When ready, set `BILLING_ENABLED=true` and add Stripe keys (see `backend/.env.example` and main `README.md`).

### G. Deploy

- Click **Create Web Service** / **Deploy**.
- Wait for **Live**. Copy the URL, e.g. `https://cloneai-api-xxxx.onrender.com`.

---

## If Render shows “Check for errors above”

- Any **red** row: click the **Key** field, delete the name, **type it again** with **no space** at the end.
- Remove env rows you do not need.

---

## Connect your website (frontend) to the API

Wherever the **frontend** is built (Render Static Site, Vercel, etc.), set:

```text
VITE_API_URL=https://cloneai-mf0z.onrender.com
```

The frontend repo includes **`frontend/.env.production`** with this URL and **`VITE_PUBLIC_APP_URL=https://www.siteclonerpro.com`** so Vercel/production builds work without extra dashboard env (you can still override in the host UI).

**No** trailing slash. Rebuild the frontend after changing this.

---

## DNS: do not point the **apex** at the API

Step-by-step Cloudflare redirect: **[CLOUDFLARE_APEX_REDIRECT.md](./CLOUDFLARE_APEX_REDIRECT.md)**.

If **`https://siteclonerpro.com`** (no `www`) opens a blank page, wrong content, or a browser error, the **apex record** is probably aimed at **Render** (the API). The **website** lives on **Vercel** (or similar).

**Correct setup**

- **`www.siteclonerpro.com`** → your **frontend** host (Vercel).
- **`siteclonerpro.com` (apex)** → also the **frontend** host (Vercel apex / ALIAS), **or** a **redirect** to `https://www.siteclonerpro.com` in Cloudflare (**Rules** → redirect).
- **`api.siteclonerpro.com`** (optional) → **Render** if you want a pretty API hostname.

The API already **redirects** browser visits on `/` to **`FRONTEND_URL`** when `FRONTEND_URL` is set on Render, but fixing DNS (or Cloudflare redirect) is still best.

## Custom domain on Render (optional)

- Render dashboard → your Web Service → **Settings** → **Custom Domains** → follow Render’s DNS instructions.
- Prefer **`api.`** subdomain for the API so **apex** stays on the static app.
- Update **`CORS_ORIGINS`** and **`FRONTEND_URL`** to match the URLs users see in the browser.

---

## Quick test

Open in a browser:

```text
https://YOUR-SERVICE.onrender.com/api/health
```

You should get a JSON OK response.

---

## Still stuck?

- Read **`render.yaml`** in the repo (comments list more env vars).
- Run locally: `cd backend && cp .env.example .env` → fill `OPENAI_API_KEY` → `npm start`.
