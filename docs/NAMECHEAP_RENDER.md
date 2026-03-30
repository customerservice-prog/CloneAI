# GitHub + Render + Namecheap (recommended stack)

Use **only** these three: code on **GitHub**, hosting on **Render**, DNS at **Namecheap**. No Vercel or Cloudflare required.

## What Render runs (from `render.yaml`)

| Service | Purpose |
|---------|---------|
| **`cloneai-api`** | Docker API (`backend/Dockerfile`) |
| **`cloneai-web`** | Static Vite app (`frontend/` → `frontend/dist`) |

Both deploy from the **same GitHub repo** when you connect Render to GitHub (Blueprint or manual services matching the YAML).

---

## 1) GitHub

- Push this repo to GitHub (`main` is fine).
- Optional: CI already runs on push via [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

---

## 2) Render + GitHub

> **Hobby plan:** Render allows **two custom domains total** across all services in the workspace. If you add apex + `api.` + extra hosts, upgrade or drop a custom domain. See [Render custom domains](https://render.com/docs/custom-domains).

1. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**.
2. Connect **GitHub**, select the **CloneAI** repo, branch **`main`**.
3. Render reads **`render.yaml`** and creates **`cloneai-api`** + **`cloneai-web`**.
4. When prompted, set **`OPENAI_API_KEY`** (secret) for **`cloneai-api`**.
5. On **`cloneai-web`**, set **`VITE_API_URL`** to your API’s public URL (same value as **cloneai-api** shows after deploy, e.g. `https://cloneai-api-xxxx.onrender.com` — copy from the dashboard if it differs from the example in the YAML).

Wait until both services are **Live**.

---

## 3) Namecheap DNS (no URL redirects)

**Do this first** — removes most **-310 / too many redirects** issues:

**Namecheap** → **Domain List** → **Manage** → **Advanced DNS** → delete any **URL Redirect Record** for **`@`** or **`www`** (they fight Render’s HTTPS and custom domains).

---

## 4) Custom domains on Render (then copy to Namecheap)

### App (`siteclonerpro.com`)

1. Render → **`cloneai-web`** → **Settings** → **Custom Domains** → add **`siteclonerpro.com`** (and **`www.siteclonerpro.com`** if you want it; Render can send **`www` → apex**).
2. Render shows **exact** DNS records (often **CNAME** targets). Add those at Namecheap **only** as instructed — do **not** guess IPs.

### API (optional pretty URL)

1. Render → **`cloneai-api`** → **Settings** → **Custom Domains** → add e.g. **`api.siteclonerpro.com`**.
2. Add the **CNAME** Render gives you, **Host** = `api`, **Value** = their target.

If you use **`https://api.siteclonerpro.com`** as the public API:

- **`cloneai-web`** → **Environment** → **`VITE_API_URL`** = `https://api.siteclonerpro.com` → **Manual Deploy** / rebuild.
- **`cloneai-api`** → **`CORS_ORIGINS`** must still list `https://siteclonerpro.com` and `https://www.siteclonerpro.com` (see `render.yaml`).

---

## 5) Environment summary (Render dashboard)

**`cloneai-api`:** `FRONTEND_URL` = `https://siteclonerpro.com`, `CORS_ORIGINS` includes apex + `www` (preset in blueprint).

**`cloneai-web`:** `VITE_API_URL` = your API URL, `VITE_PUBLIC_APP_URL` = `https://siteclonerpro.com`.

---

## 6) Stripe (when billing is on)

Success/cancel URLs must use **`https://siteclonerpro.com`** (same as **`FRONTEND_URL`**).

---

## Quick checks

- `https://<your-api>.onrender.com/api/health` → JSON OK.
- `https://siteclonerpro.com` loads the SPA (after DNS propagates).
- `https://siteclonerpro.com/robots.txt` returns plain text.

---

## If you also use Cloudflare

See [CLOUDFLARE_APEX_REDIRECT.md](./CLOUDFLARE_APEX_REDIRECT.md) — use **one** redirect story only (www → apex to match `FRONTEND_URL`).

## Optional: Vercel

`frontend/vercel.json` is only for teams that deploy the SPA on Vercel. If you use **Render only**, ignore it.
