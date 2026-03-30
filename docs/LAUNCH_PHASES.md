# Launch phases — CloneAI (bulletproof order)

Complete each phase before moving on. Skipping steps causes broken CORS, wrong domain, missing paywall, or unpaid API usage.

---

## Phase 0 — Repo & automated checks (5 min)

Run locally from the **repository root**:

```bash
npm run verify
```

With `backend/.env` filled (OpenAI key), you can also run:

```bash
npm run preflight
```

(`verify` + `launch-check:dev`, which forces `NODE_ENV=development` for the check so a global production shell does not false-fail CORS.)

For **strict** production validation (same as Render): `npm run launch-check:prod` (requires full `CORS_ORIGINS`, Stripe webhook, `https` `FRONTEND_URL` unless you intentionally use `LAUNCH_CHECK_RELAX_BILLING_LOCAL` — **never on production hosts**).

This runs backend tests + production Vite build (same as GitHub Actions). Fix failures before any deploy.

Optional local secrets check (uses `backend/.env`):

```bash
npm run launch-check
npm run launch-check:prod
```

`launch-check:prod` requires **`CORS_ORIGINS`** and, if **`BILLING_ENABLED=true`**, full Stripe + **`FRONTEND_URL`**.

---

## Phase 1 — API on Render (minimum viable)

1. Follow **[RENDER_EASY.md](./RENDER_EASY.md)** through **Docker** deploy.
2. In **Render → Environment**, set at least:

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Required for analyze |
| `NODE_ENV` | `production` |
| `PORT` | Omit on Render (platform sets it). Local/Docker: `3001` or match container. |
| `CORS_ORIGINS` | Exact frontend origins, comma-separated, **no** `*` |
| `FRONTEND_URL` | Canonical app URL (Stripe return URLs + apex browser redirect) |

3. Confirm: `https://<your-api>.onrender.com/api/health` returns JSON OK.

**Leave `BILLING_ENABLED=false`** until Phase 4 if Stripe is not ready (avoids broken checkout).

---

## Phase 2 — Frontend on Render (`cloneai-web`)

1. Prefer the **Blueprint** in **`render.yaml`** (creates **`cloneai-web`** with build `cd frontend && npm ci && npm run build`, publish **`frontend/dist`**).
2. Set **`cloneai-web`** env **`VITE_API_URL`** to **`cloneai-api`’s** public `https://…onrender.com` (or **`https://api.yourdomain.com`** if you add a custom API domain).
3. Production defaults also come from **`frontend/.env.production`** at build time.
4. **Custom domains:** attach **`siteclonerpro.com`** (and **`www`** if you want) on **`cloneai-web`** in Render, then add the DNS records Render shows at **Namecheap**. See **[NAMECHEAP_RENDER.md](./NAMECHEAP_RENDER.md)**.
5. Redeploy **`cloneai-web`** after any env change.

*(Optional: deploy **`frontend/`** on Vercel instead — use `frontend/vercel.json` only in that case; do not point the same hostname at both Vercel and Render.)*

---

## Phase 3 — DNS & apex (avoid “wrong site” / error codes)

1. **Namecheap + Render:** **[NAMECHEAP_RENDER.md](./NAMECHEAP_RENDER.md)** — remove **URL Redirect** rows; add only the **CNAME** / records Render gives you for **`cloneai-web`**.
2. **Apex** must resolve to the **static site** (`cloneai-web`), not **`cloneai-api`**.
3. **API** stays on **`*.onrender.com`** or **`api.`** → **`cloneai-api`** custom domain.
4. If you use **Cloudflare** in front of DNS, use **www → apex** per **[CLOUDFLARE_APEX_REDIRECT.md](./CLOUDFLARE_APEX_REDIRECT.md)** (one redirect story only).

The API still **301-redirects** HTML requests on `/` to **`FRONTEND_URL`** when set, as a safety net.

---

## Phase 4 — Billing & Stripe (paid plans, crawl gates, paywall)

When you are ready to charge:

1. **Stripe (Live)** — Products/prices: Starter, Pro, one-time extra run. Copy **`price_...`** IDs.
2. **Webhook** — `https://<api-host>/api/billing/webhook`  
   Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.  
   Or run: `cd backend && npm run stripe-webhook:create -- https://<api-host>/api/billing/webhook`
3. **Render env:**

| Variable |
|----------|
| `BILLING_ENABLED=true` |
| `STRIPE_SECRET_KEY` |
| `STRIPE_WEBHOOK_SECRET` |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` / `STRIPE_PRICE_EXTRA_RUN` |
| `FRONTEND_URL` = **`https://`…** (must match checkout return URL) |

4. **`CORS_ORIGINS`** must include every browser **`Origin`** (e.g. `www` **and** apex if both serve the app).

5. Test: free user → **Analyze** with **deep** crawl → **paywall** (not silent downgrade). Complete a test checkout; webhook should mark plan.

Full matrix: **[BILLING_TESTING.md](./BILLING_TESTING.md)**.

---

## Phase 5 — Optional hardening

| Item | Variable / action |
|------|-------------------|
| Ingress secret | `CLONEAI_INGRESS_KEY` + frontend `VITE_CLONEAI_KEY` (same value, 16+ chars) |
| Turnstile | `TURNSTILE_SECRET_KEY` + `VITE_TURNSTILE_SITE_KEY` |
| Owner override | `CLONEAI_PROMO_CODE` (server only); users leave “Authorized code” closed unless given a code |
| Trust proxy | `TRUST_PROXY=1` or `2` if behind Cloudflare + Render (see `server.js`) |

---

## Optional — Image pipeline (after a successful analyze ZIP)

See **[IMAGE_PIPELINE.md](./IMAGE_PIPELINE.md)** — CLI upscales harvested/screenshot assets and renames from URL-derived stems (optional OpenAI **index pick** only; no free-form names). Run on your machine or a worker; not required for first launch.

---

## Phase 6 — Go-live smoke (manual, 10 min)

- [ ] Open app on **www** → run **homepage** analyze → completes.
- [ ] Signed-out or free → select **deep** crawl → **paywall** with checkout buttons (billing on).
- [ ] Stripe Dashboard → webhook deliveries **2xx** after test payment.
- [ ] **`/api/health`** OK from public URL.
- [ ] No secrets in git; `backend/.env` gitignored.

---

## One-page reference

| Concern | Doc / command |
|---------|----------------|
| Render first deploy | [RENDER_EASY.md](./RENDER_EASY.md) |
| Apex / Cloudflare | [CLOUDFLARE_APEX_REDIRECT.md](./CLOUDFLARE_APEX_REDIRECT.md) |
| Stripe test matrix | [BILLING_TESTING.md](./BILLING_TESTING.md) |
| Env reference | `backend/.env.example`, `README.md` |
| Blueprint | `render.yaml` |
