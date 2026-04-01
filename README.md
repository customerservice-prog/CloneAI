# CloneAI

Production-oriented full-stack AI website clone analyzer: Vite + vanilla frontend, Node/Express backend, OpenAI streaming over SSE.

### Deploying with GitHub + Render + Namecheap?

**Start here:** **[docs/NAMECHEAP_RENDER.md](docs/NAMECHEAP_RENDER.md)** (one stack, no Vercel required).  
Shorter API-focused checklist: **[docs/RENDER_EASY.md](docs/RENDER_EASY.md)** — **Docker** + `backend/Dockerfile`, **`OPENAI_API_KEY`**, **`CORS_ORIGINS`**, **`FRONTEND_URL`**. Do **not** use plain Node + `yarn build` for the API.

## Prerequisites

- Node.js 20+ recommended (Sharp prebuilds)
- [OpenAI API key](https://platform.openai.com/api-keys)

## Backend (`backend/.env`)

Copy `backend/.env.example` to `backend/.env` and set your key. Required:

```env
OPENAI_API_KEY=sk-...
```

Optional model override (default **`gpt-4o`**):

```env
OPENAI_MODEL=gpt-4o
```

Recommended for production:

```env
NODE_ENV=production
PORT=3001
CORS_ORIGINS=https://siteclonerpro.com,https://www.siteclonerpro.com
```

| Variable | Purpose |
|----------|---------|
| `CORS_ORIGINS` | **Required in production:** comma-separated frontend origins (no `*`). Dev defaults include `http://localhost:5173`. |
| `CLONEAI_INGRESS_KEY` | Optional shared secret; browser sends `X-CloneAI-Key` (set `VITE_CLONEAI_KEY` on the frontend). |
| `RATE_LIMIT_PER_MINUTE` | Max `POST /api/analyze` per IP per minute (default **10**, clamped **3–15**). |
| `RATE_LIMIT_DAILY_PER_IP` | Max analyses per IP per 24h (default **200**, clamped 20–5000). |
| `HTML_FETCH_TIMEOUT_MS` | HTML fetch timeout (default **15000**, clamped 8s–20s). |
| `HTML_FETCH_MAX_REDIRECTS` | Follow redirects only on the **same registrable host** (default **2**, max **5**). |
| `OPENAI_MAX_TOKENS` | Output cap (default **8000**, max **16384**). |
| `OPENAI_STREAM_TIMEOUT_MS` | Abort OpenAI stream if stalled (default **180000**). |
| `CLAUDE_MAX_TOKENS` / `CLAUDE_STREAM_TIMEOUT_MS` | Legacy fallbacks if the `OPENAI_*` vars are unset. |
| `HTML_FETCH_MAX_CONTENT_LENGTH` | Axios max HTML download size (default matches `MAX_HTML_BYTES`, ceiling **50MB**). |
| `MAX_HTML_BYTES` | HTML kept to discover image URLs (default **8MB**, max **25MB**). |
| `MAX_HTML_FOR_MODEL` | Max HTML characters sent to the model (default **120000**, max **250000**). |
| `IMAGE_HARVEST_MAX` | **Unset / blank / `0` = no limit** (every image URL found in HTML). Otherwise max count. |
| `IMAGE_HARVEST_MAX_BYTES` | Per-image cap (default **50MB**). |
| `IMAGE_HARVEST_ZIP_CAP` | **Unset / blank / `0` = no limit** on total ZIP payload (uses RAM). |
| `IMAGE_HARVEST_CONCURRENCY` | Parallel downloads (default **12**, max **32**). |
| `CRAWL_MAX_PAGES` | **Deep** scan: max same-host HTML pages to fetch (default **100**, max **250**). **Shallow** uses `min(25, CRAWL_MAX_PAGES)`. **Homepage / 1 page** skips BFS. |
| `CRAWL_FETCH_CONCURRENCY` | Parallel HTML fetches during crawl (default **20**, max **40**). |
| `CRAWL_SCREENSHOT_CONCURRENCY` | Parallel Playwright tabs for full-page PNGs (default **10**, max **24**). |
| `SCREENSHOT_TIMEOUT_MS` | Per-page navigation timeout for screenshots (default **50000**, max **120000**). |
| `ENABLE_PAGE_SCREENSHOTS` | Set to `false` to skip Playwright snapshots (images-only ZIP). |
| `ENABLE_INTERACTION_CRAWL` | Set to `false` to skip theme/demo clicks and checkout walk (default: on when screenshots on). |
| `INTERACTION_HUB_PAGES` | Max crawled URLs used as “hubs” for clicking theme grids (default **12**, max **25**). |
| `INTERACTION_THEME_CLICKS_PER_HUB` | Max theme/demo/preview clicks per hub page, reloading hub between clicks (default **100**, max **200**). |
| `INTERACTION_CHECKOUT_MAX_STEPS` | Max “Next / Continue / Pay” steps on first cart/checkout URL found (default **15**, max **30**). |
| `INTERACTION_EXTRA_URL_CAP` | Extra same-host pages to fetch after URLs discovered from interactions (default **120**, max **300**). |
| `SITE_ASSET_TTL_MS` | How long the one-click ZIP download link stays valid (default **30 minutes**). |
| `RELAX_ANALYZE_ORIGIN_CHECK` | Set to `true` only if you must call `/api/analyze` without a browser `Origin` (discouraged). |
| `BILLING_ENABLED` | Set to `true` to enforce usage limits and require `X-CloneAI-User-Id` on `/api/analyze`. |
| `STRIPE_SECRET_KEY` | Stripe secret key (subscriptions + one-time extra run). |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `POST /api/billing/webhook` (register URL in Stripe Dashboard). |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` | Recurring price IDs ($5/mo and $12/mo). |
| `STRIPE_PRICE_EXTRA_RUN` | One-time price ID ($3) for bonus runs. |
| `FRONTEND_URL` | Origin for Stripe Checkout `success_url` / `cancel_url` (e.g. `https://siteclonerpro.com`). |
| `BILLING_DATA_PATH` | Optional path to `billing.json` store (default: `backend/data/billing.json`). |
| `CLONEAI_PROMO_CODE` | Optional server secret: valid `promoCode` form field or `X-CloneAI-Promo-Code` header grants a **Pro-class** run for billing checks only (still rate-limited). **Body:** exact string match (no trim). **Header:** trimmed. |
| `HTML_MODEL_MAX_CHARS_PER_PAGE` | After HTML cleaning, max characters per crawled page sent toward the model budget (default **80k**, max **150k**). |
| `MAX_ANALYSIS_IMAGES` | Max screenshots per analyze request (default **8**, max **12**). |
| `MAX_OPENAI_REQUEST_JSON_BYTES` | Hard stop if the OpenAI JSON body exceeds this size (default **14MiB**). |
| `GLOBAL_ANALYZE_BURST_MAX` / `GLOBAL_ANALYZE_BURST_WINDOW_MS` | Global analyze starts per rolling window (abuse / cost spike guard). |
| `ANALYZE_MAX_CONCURRENT_PER_USER` | Max parallel analyses per `X-CloneAI-User-Id` (or IP fallback), default **1**. |
| `OPENAI_API_BASE` | Override API base URL (e.g. proxy or Azure OpenAI-compatible endpoint). |
| `OPENAI_STREAM_INCLUDE_USAGE` | Set `false` if the chat provider rejects `stream_options.include_usage`. |
| `COST_ESTIMATE_INPUT_PER_MILLION_USD` / `COST_ESTIMATE_OUTPUT_PER_MILLION_USD` | Optional overrides for `adminCost` USD estimates in `GET /api/billing/analytics`. |

Full Stripe test matrix: [docs/BILLING_TESTING.md](docs/BILLING_TESTING.md).

**Post-download image pipeline** (screenshot ZIP → HD pass + URL-grounded renames): [docs/IMAGE_PIPELINE.md](docs/IMAGE_PIPELINE.md) · `npm run image-pipeline --prefix backend` (see doc for args).

## Frontend (local / Render static / optional Vercel)

| Variable | Purpose |
|----------|---------|
| `VITE_API_URL` | **Required for production builds:** API origin only, e.g. `https://cloneai-api.onrender.com` (no path, no trailing slash). Local dev falls back to `http://localhost:3001`. |
| `VITE_CLONEAI_KEY` | Matches `CLONEAI_INGRESS_KEY` when enabled. |
| `VITE_PUBLIC_APP_URL` | Optional; canonical app URL for branding links in exports (see backend table). |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile (with `TURNSTILE_SECRET_KEY` on the API) for captcha after first successful analyze per IP. |

## Run locally

**Recommended (API + Vite together)** — from the **repository root**:

```bash
npm install --prefix backend
npm install --prefix frontend
cd backend; npx playwright install chromium; cd ..
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173). The dev script starts the backend on a free port (usually `3001`) and configures Vite to proxy `/api/*` to it. If you only run `npm run dev` inside `frontend/`, the UI loads but **“Could not reach the API”** appears until something is listening on the proxy target (default `http://127.0.0.1:3001`).

**Backend** (on its own, e.g. port 3001)

```bash
cd backend
npm install
npx playwright install chromium
npm start
```

The first time (or on a new machine), **`npx playwright install chromium`** is required so full-page snapshots work.

**Automated smoke checks** (with the server running on port 3001):

```bash
cd backend
npm run smoke
```

Covers health, empty input, SSRF rejection on `127.0.0.1`, and honeypot rejection. End-to-end streaming still needs a valid `OPENAI_API_KEY` and manual browser checks.

**Billing logic tests** (no Stripe network; run anytime):

```bash
cd backend
npm test
```

From the **repository root** you can also run `npm test` or `npm run smoke` (they delegate to `backend/`).

**Frontend** (without root `npm run dev`)

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) **and** keep the backend running on **`VITE_DEV_API_PROXY`** (default `http://127.0.0.1:3001`), or set `VITE_API_URL` to your API origin in `frontend/.env.local`.

## Deploy

**Launch order (phased checklist)** — do this once for a bulletproof go-live: **[docs/LAUNCH_PHASES.md](docs/LAUNCH_PHASES.md)** (API → frontend → DNS → Stripe → smoke tests).

**Pre-flight (local)**  
From repo root after filling `backend/.env`:

```bash
npm run launch-check              # OpenAI key + optional ingress length (inherits shell NODE_ENV)
npm run launch-check:dev          # same, but forces NODE_ENV=development (use if your shell sets production)
npm run launch-check:prod         # + CORS (https-only origins in prod); if BILLING_ENABLED=true, Stripe + https FRONTEND_URL
npm run verify                    # tests + production frontend build
```

**Docker (backend)**  
Chromium + Playwright are included in the image (no separate `playwright install` on the host).

```bash
docker build -t cloneai-api ./backend
docker run --env-file backend/.env -p 3001:3001 cloneai-api
```

**Render + GitHub + Namecheap (recommended)**  
- **One-page stack:** [docs/NAMECHEAP_RENDER.md](docs/NAMECHEAP_RENDER.md)  
- **API details:** [docs/RENDER_EASY.md](docs/RENDER_EASY.md)  
- **Phased go-live:** [docs/LAUNCH_PHASES.md](docs/LAUNCH_PHASES.md)  
- Blueprint [`render.yaml`](render.yaml): **`cloneai-api`** (Docker) + **`cloneai-web`** (static). Set **`OPENAI_API_KEY`** in the dashboard; `CORS_ORIGINS` / `FRONTEND_URL` preset for `https://siteclonerpro.com`.

**Node-only (Railway, Fly, etc.)**  
Root directory `backend`, start command `npm start`, install `npx playwright install chromium` on first deploy or use the Dockerfile.

**Vercel (optional alternative frontend)**  
Only if you do not use **`cloneai-web`** on Render: project root `frontend`, [`vercel.json`](frontend/vercel.json), **`VITE_API_URL`** → public API (no trailing slash).

**CI**  
GitHub Actions runs `npm run verify` on push/PR to `main` / `master` (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Security & limits (launch checklist)

- **CORS:** Explicit allowlist only; `*` entries in `CORS_ORIGINS` are stripped with a warning.
- **Browser origin (production):** `POST /api/analyze` and `POST /api/analyze-revise` require an `Origin` header that matches `CORS_ORIGINS` (reduces scripted abuse). Override with `RELAX_ANALYZE_ORIGIN_CHECK=true` only if needed.
- **Rate limits:** Per-minute **and** per-24h caps on `/api/analyze` and `/api/analyze-revise` (cost protection).
- **SSRF:** DNS resolution with blocking of private/link-local/CGNAT ranges and metadata-style hostnames (`backend/ssrf.js`). URLs with embedded credentials are rejected.
- **Redirects:** Only same host key (after stripping leading `www.`) as the initial URL; `http`/`https` only.
- **Uploads:** PNG/JPEG/WebP only, magic-byte verification, **20MB** per file, up to **10** files in multipart; **analyze** accepts at most **`MAX_ANALYSIS_IMAGES` (default 8)** per run. Files renamed to `upload-N.ext` server-side.
- **Honeypot:** Hidden `hp` field must be empty.
- **Errors:** Production uses generic client messages; stack traces and internals stay in logs only.
- **Secrets:** OpenAI key server-only; never returned to the browser.
- **Sharp** re-encodes **uploaded** screenshots before the vision model; **harvested** site images are stored as downloaded (no recompression).
- **Multi-page crawl:** **Shallow** / **Deep** runs a same-host BFS (internal `<a href>` links only), with parallel fetches (`CRAWL_FETCH_CONCURRENCY`). **Playwright** captures a **full-page PNG per crawled URL** into `snapshots/` inside the ZIP.
- **Interaction crawl (heuristic):** On hub pages, Playwright **clicks** theme/demo/preview/template controls (up to `INTERACTION_THEME_CLICKS_PER_HUB` per hub), saves PNGs under **`snapshots/interaction/`**, and queues discovered same-host URLs for HTML fetch. If a **cart/checkout** URL exists in the crawl, it walks **Continue / Next / Pay**-style controls up to `INTERACTION_CHECKOUT_MAX_STEPS` with per-step screenshots. This is **best-effort** (selectors and labels vary by vendor; it is not a guarantee for every theme store or payment flow). Disable with `ENABLE_INTERACTION_CRAWL=false`.
- **Assets bundle:** `GET /api/site-images/:token` returns **`site-assets.zip`** (images + `snapshots/` + `_urls.txt` + `_snapshots.txt`). Set `ENABLE_PAGE_SCREENSHOTS=false` to skip Chromium. Pure SPAs may still hide links from HTML-only crawls.
- **Logs:** `analyze_request`, `analyze_success`, `analyze_failure`, `analyze_openai_timeout`, `analyze_honeypot_triggered`, `analyze_blocked_origin`, `html_fetch_failed`, etc.

## License

Use freely for your own projects.
