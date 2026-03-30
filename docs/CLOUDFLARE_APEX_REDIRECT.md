# Point apex `siteclonerpro.com` → `www` (Cloudflare)

Do this in **Cloudflare** for the `siteclonerpro.com` zone so visitors who type the bare domain always hit the app on **www**.

## Option A — Single Redirect (recommended)

1. Cloudflare Dashboard → **siteclonerpro.com** → **Rules** → **Redirect Rules**.
2. **Create rule** → **Single redirect**.
3. **Rule name:** `Apex to www`
4. **If incoming requests match…** → **Custom filter expression**:

   ```text
   (http.host eq "siteclonerpro.com")
   ```

5. **Then…** → **URL redirect** — **Dynamic**:
   - **Expression:** `concat("https://www.siteclonerpro.com", http.request.uri.path)`
   - Or choose **Static** → **301** → `https://www.siteclonerpro.com$1` depending on the UI (use **301** permanent).

   Simpler static pattern if the UI offers it:

   - **Target URL:** `https://www.siteclonerpro.com${uri}` or the wizard’s “wildcard” equivalent so **path and query** are preserved.

6. **Save** and **Deploy**.

## Option B — DNS only (no redirect rule)

1. **DNS** → ensure **www** is a **CNAME** to your frontend (e.g. `cname.vercel-dns.com` if Vercel shows that).
2. **Apex** (`siteclonerpro.com`): use your registrar/Cloudflare **CNAME flattening** / **ALIAS** to the **same** frontend target Vercel gives you for the root domain (Vercel: Project → **Settings** → **Domains** → add `siteclonerpro.com`).

Then both apex and www serve the Vite app; no traffic to Render for HTML.

## Render API

- Keep **`FRONTEND_URL=https://www.siteclonerpro.com`** on Render (Stripe return URLs + browser redirect from `/` when apex wrongly points at the API).
- Prefer the API on **`api.siteclonerpro.com`** (CNAME → `cloneai-xxxx.onrender.com`) so apex never hits the API.
