# Cloudflare: redirect **www** → **apex** (`siteclonerpro.com`)

Part of **Phase 3** in [LAUNCH_PHASES.md](./LAUNCH_PHASES.md).

This repo uses **apex** as the canonical app URL (`FRONTEND_URL` = `https://siteclonerpro.com`). Use Cloudflare only if your DNS is on Cloudflare (Namecheap-only users: **[NAMECHEAP_RENDER.md](./NAMECHEAP_RENDER.md)**).

## Single redirect (recommended)

1. Cloudflare Dashboard → **siteclonerpro.com** → **Rules** → **Redirect Rules**.
2. **Create rule** → **Single redirect**.
3. **Rule name:** `www to apex`
4. **If incoming requests match…** → **Custom filter expression**:

   ```text
   (http.host eq "www.siteclonerpro.com")
   ```

5. **Then…** → **URL redirect** — preserve path and query (use your UI’s “dynamic” / wildcard option), target:

   - **`https://siteclonerpro.com`** + same path and query (e.g. expression like `concat("https://siteclonerpro.com", http.request.uri.path)` plus query if the wizard supports it).

6. **301** permanent, **Save**, **Deploy**.

## DNS

- **Apex** `siteclonerpro.com`: point to your **frontend** (Vercel / Render static), not the Render API.
- **`www`**: either **CNAME** to the same frontend target **or** rely on the redirect rule above after traffic hits Cloudflare.

## Render API

- Keep **`FRONTEND_URL=https://siteclonerpro.com`** on Render (Stripe return URLs + HTML redirect from `/` when someone hits the API root).
- Prefer the API on **`api.siteclonerpro.com`** (CNAME → your `*.onrender.com` host) so apex never resolves to the API.
