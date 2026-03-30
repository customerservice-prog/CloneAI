# Image pipeline — screenshots, HD pass, grounded names

Three stages you can run **after** a normal analyze produced `site-assets.zip`:

1. **Capture inventory** — Uses `_urls.txt` and `_snapshots.txt` inside the ZIP (real URLs from the crawl). No invented page list.
2. **HD enhancement** — [Sharp](https://sharp.pixelplumbing.com/) **Lanczos** upscale for images whose long side is below ~1920px (configurable in code). This improves pixel density; it does **not** generatively invent new image content.
3. **Grounded filenames** — Stems come from **URL path segments** (and snapshot path patterns) only. Optional OpenAI step **only reorders** a fixed candidate list — it cannot output a new string.

## CLI

```bash
cd backend
npm install
node scripts/image-pipeline-from-zip.mjs path/to/site-assets.zip path/to/output-folder
```

Outputs:

- `output-folder/pipeline-manifest.json` — map `original` → `output`, `sourceUrl`, `candidates`
- `output-folder/site-assets-processed.zip` — processed binaries + copied `_*.txt` manifests

### Environment

| Variable | Effect |
|----------|--------|
| `IMAGE_PIPELINE_SKIP_HD=true` | Rename / manifest only; no upscale |
| `IMAGE_PIPELINE_AI_NAMING=true` | Use OpenAI to pick **which candidate index** fits the URL best (needs `OPENAI_API_KEY`) |
| `IMAGE_PIPELINE_NAMING_MODEL` | Default `gpt-4o-mini` |
| `SCREENSHOT_DEVICE_SCALE` | During live crawl, Playwright `deviceScaleFactor` (default `1`, try `2` for sharper PNGs — more RAM/CPU) |

## Live deploy

- **Render:** redeploy API after `git pull` so `adm-zip` installs; pipeline is **CLI-only** (no new public HTTP surface).
- **GitHub:** commit and push this repo; Vercel frontend unchanged unless you add UI to download + re-upload ZIPs (not required).

## Honest limits

- **Names** cannot be “perfect” if the source URL is a CDN hash (`/a/b/x7f9…webp`). We use that literal stem (sanitized) or optional AI **index pick** among variants — never a free-form label.
- **HD** is mathematical upscale, not a dedicated photo super-resolution model; for that you’d plug an external API separately.
