# Static Meme API

A static, CORS-friendly mirror of [justmeme.wtf](https://justmeme.wtf/api-docs) — meme
templates (JSON) **and the images themselves** — built into flat files and served from
GitHub Pages. One Node script, one manual GitHub Action. No server, no database.

## What it produces (`dist/`)

```
dist/
  index.html                          landing + docs
  images/{slug}.jpg|png|gif           self-hosted template images
  api/v1/
    index.json                        endpoint map + counts
    templates.json                    all templates
    templates/{slug}.json             one template
    categories.json                   all categories
    categories/{slug}.json            templates in a category
```

Each template: `{ id, name, slug, image, source_url, categories }`. `image` points at the
self-hosted copy (absolute when deployed, relative locally); `source_url` keeps the upstream
imgflip URL as a fallback.

## Run locally

Needs Node 18+ (built-in `fetch`). Zero dependencies.

```bash
node generate.mjs                 # full build → dist/
```

Env knobs:

| Var | Default | Purpose |
|-----|---------|---------|
| `SOURCE_API` | `https://justmeme.wtf/api/v1` | upstream base |
| `PUBLIC_BASE` | _(unset → relative paths)_ | public site URL; makes image URLs absolute |
| `MAX_TEMPLATES` | all | cap count for a fast test run |
| `SKIP_IMAGES` | _(off)_ | `1` to skip image download |

Quick test run (10 templates, no waiting on ~2400 images):

```bash
# PowerShell
$env:MAX_TEMPLATES=10; node generate.mjs
# bash
MAX_TEMPLATES=10 node generate.mjs
```

## Deploy (one-time setup)

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions tab → "Build & Deploy Static Meme API" → Run workflow.**

The workflow (`.github/workflows/deploy.yml`) is `workflow_dispatch` only — it runs when you
click it. It generates the API fresh, downloads all images, and deploys the `dist/` artifact
to Pages. Images are never committed to git (built per-run), so history stays clean.

Re-run the workflow any time to refresh against upstream.

## Notes

- Generation hits the upstream API ~25 times (paginated), well under its 60 req/min limit.
  Images come from imgflip's CDN and download with bounded concurrency.
- Per-template JSON is built from the list endpoint, so richer single-template fields
  (e.g. editor `page_url`) are intentionally omitted — add a per-slug fetch in `generate.mjs`
  if you need them.
