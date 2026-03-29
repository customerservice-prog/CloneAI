# CloneAI billing — testing guide

Enforcement is **server-side only**. The frontend sends `X-CloneAI-User-Id` (UUID in `localStorage`); limits are stored in `backend/data/billing.json` (gitignored) when `BILLING_ENABLED=true`.

## 1. Stripe Dashboard setup

1. Create **Products / Prices**:
   - Starter — recurring monthly **$5** → copy Price ID → `STRIPE_PRICE_STARTER`
   - Pro — recurring monthly **$12** → `STRIPE_PRICE_PRO`
   - Optional: Extra run — one-time **$3** → `STRIPE_PRICE_EXTRA_RUN`
2. In **Developers → Webhooks**, add endpoint: `https://<your-api-host>/api/billing/webhook`
3. Subscribe to at least: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` (optional log).
4. Copy signing secret → `STRIPE_WEBHOOK_SECRET`.

Local webhook forwarding:

```bash
stripe listen --forward-to localhost:3001/api/billing/webhook
```

Use the printed `whsec_...` as `STRIPE_WEBHOOK_SECRET` while testing.

## 2. Backend `.env`

```
BILLING_ENABLED=true
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_EXTRA_RUN=price_...
FRONTEND_URL=http://localhost:5173
```

Match `FRONTEND_URL` to your Vite origin (Checkout success/cancel redirects).

## 3. Test matrix

### Free plan

1. New UUID: clear `localStorage` key `cloneai_user_id` or use a fresh browser profile.
2. Run analysis once → should succeed; header shows `Free: 1 / 1 runs (lifetime)` after refresh or next status poll.
3. Run again → HTTP **403** JSON `{ "success": false, "code": "LIMIT_REACHED", "error": "LIMIT_REACHED", ... }`; paywall modal opens.

### Starter (10 / month)

1. Complete Checkout for Starter (test card `4242 4242 4242 4242`).
2. Wait for webhook (or trigger `stripe trigger checkout.session.completed` only if session metadata matches — real Checkout is easier).
3. Confirm `GET /api/billing/status` with same `X-CloneAI-User-Id` shows `plan: "starter"`, `limit: 10`.
4. Run 10 successful analyses → each success increments usage.
5. 11th run → `LIMIT_REACHED`.

### Pro (50 / month)

Same as Starter with Pro price; expect `limit: 50`.

### Extra run ($3)

1. From paywall, choose **Buy 1 extra run**.
2. After webhook, `bonusRuns` increases; next run consumes **bonus** before monthly quota.

### Persistence

- Refresh page → same `cloneai_user_id` → usage unchanged.
- New session / same browser → same id until storage cleared.

### Bypass attempt

- Omit `X-CloneAI-User-Id` → **400** `MISSING_USER_ID`.
- Forge another UUID → **new** free tier (abuse control: add auth, CAPTCHA, or device binding later).

### Stripe cancel

- Abandon Checkout → no webhook → plan unchanged.

### Webhook retry

- Stripe retries failed webhooks; events are **deduped** by Stripe event `id` in `billing.json` `events` map.

## 4. Automated unit tests (no Stripe network)

From `backend/`:

```bash
npm test
```

Covers free / starter / pro caps, monthly reset, webhook idempotency, pay-as-you-go bonus runs, parallel request safety, and analytics counters.

## 5. Smoke script with billing

`scripts/smoke.mjs` sends a stable `X-CloneAI-User-Id` on `/api/analyze` so smoke passes when `BILLING_ENABLED=true` (requests still fail early on validation / SSRF as before).

## 6. Production checklist

- [ ] `BILLING_ENABLED=true`
- [ ] Live Stripe keys + live webhook URL
- [ ] `FRONTEND_URL` exact match to deployed SPA
- [ ] `CORS_ORIGINS` includes that frontend
- [ ] Persist `BILLING_DATA_PATH` on durable disk (not ephemeral container FS) if you scale to multiple instances, **or** move to Redis/Postgres (file store is single-node).
