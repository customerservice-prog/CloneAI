# Render deploy — simple checklist (CloneAI API)

Do these **in order**. Skip any step that does not apply.

---

## Before you open Render

1. **OpenAI:** Create an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).  
   - Never paste it in Discord, email, or chat. Only paste it inside **Render → Environment**.

2. **Know your site URL** (for CORS):
   - Example: `https://siteclonerpro.com`  
   - If you use **www**, you will add **both** URLs in one line (see below).

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
| `CORS_ORIGINS` | `https://siteclonerpro.com,https://www.siteclonerpro.com` |
| `FRONTEND_URL` | `https://siteclonerpro.com` |

**Replace** `siteclonerpro.com` with your real domain if different.

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
VITE_API_URL=https://YOUR-RENDER-URL-HERE.onrender.com
```

**No** trailing slash. Rebuild the frontend after changing this.

---

## Custom domain on Render (optional)

- Render dashboard → your Web Service → **Settings** → **Custom Domains** → follow Render’s DNS instructions.
- In **Namecheap** → **Advanced DNS**, add exactly what Render shows (often a **CNAME** for `www`).
- Update **`CORS_ORIGINS`** and **`FRONTEND_URL`** to use `https://yourdomain.com`.

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
