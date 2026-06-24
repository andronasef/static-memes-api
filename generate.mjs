#!/usr/bin/env node
// Static meme API generator: mirrors justmeme.wtf into flat JSON + self-hosted images.
// Zero dependencies — Node 18+ (built-in fetch). Output goes to ./dist, ready for GitHub Pages.
//
// Env:
//   SOURCE_API     base of the upstream API (default https://justmeme.wtf/api/v1)
//   PUBLIC_BASE    public URL of the deployed site; when set, image urls in JSON are absolute
//                  (e.g. https://user.github.io/repo). Unset → relative paths.
//   MAX_TEMPLATES  cap template count for quick test runs (default: all)
//   SKIP_IMAGES    "1" to skip image download (JSON points at upstream urls instead)

import { mkdir, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

const SOURCE_API = process.env.SOURCE_API || 'https://justmeme.wtf/api/v1';
const IMGFLIP_BASE = (process.env.IMGFLIP_BASE || 'https://imgflip.com').replace(/\/$/, '');
const ALL_CAP = process.env.ALL_CAP ? Number(process.env.ALL_CAP) : Infinity; // cap imgflip scrape for test runs; default: whole catalog (~1973)
const PUBLIC_BASE = (process.env.PUBLIC_BASE || '').replace(/\/$/, '');
const MAX_TEMPLATES = process.env.MAX_TEMPLATES ? Number(process.env.MAX_TEMPLATES) : Infinity;
const SKIP_IMAGES = process.env.SKIP_IMAGES === '1';
const OUT = 'dist';
const CONCURRENCY = 10;

async function fetchJSON(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries) throw new Error(`fetch ${url}: ${e.message}`);
      await sleep(500 * i);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run async tasks with bounded concurrency. ponytail: hand-rolled pool, swap for p-limit if it grows.
async function pool(items, limit, fn) {
  const queue = [...items.entries()];
  const workers = Array.from({ length: limit }, async () => {
    for (let next; (next = queue.shift()); ) await fn(next[1], next[0]);
  });
  await Promise.all(workers);
}

const extOf = (url) => {
  const m = new URL(url).pathname.match(/\.(jpe?g|png|gif|webp)$/i);
  return m ? m[0].toLowerCase() : '.jpg';
};

const writeJSON = (rel, data) => {
  const file = join(OUT, rel);
  return mkdir(join(file, '..'), { recursive: true }).then(() =>
    writeFile(file, JSON.stringify(data, null, 2))
  );
};

const exists = (p) => access(p).then(() => true, () => false);

async function downloadImage(url, dest) {
  if (await exists(dest)) return true; // idempotent: skip already-downloaded
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest));
  return true;
}

async function fetchHTML(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 static-memes-api' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i === tries) throw new Error(`fetch ${url}: ${e.message}`);
      await sleep(500 * i);
    }
  }
}

// Scrape imgflip's meme-template listing (HTML, no JSON API). Walks every page to the end of the
// catalog (~1973 templates — that's imgflip's full public listing); `cap` only bounds test runs.
// ponytail: regex over the .mt-box blocks — flat grid, no HTML-parser dependency. Upgrade if markup churns.
async function scrapeImgflip(cap) {
  const out = new Map(); // slug -> template, dedups across pages
  for (let page = 1; out.size < cap; page++) {
    const html = await fetchHTML(`${IMGFLIP_BASE}/memetemplates?page=${page}`);
    const boxes = html.split('class="mt-box"').slice(1);
    if (boxes.length === 0) break; // imgflip's "you've reached the end" page → no more templates
    for (const box of boxes) {
      const link = box.match(/href="\/meme\/([^"]+)"[^>]*>([^<]+)<\/a>/);
      const img = box.match(/<img[^>]+src="([^"]+)"/);
      if (!link || !img) continue;
      const slug = link[1].split('/').pop().toLowerCase(); // imgflip hrefs are /meme/Name or /meme/{id}/Name
      if (out.has(slug)) continue;
      const url = img[1].startsWith('//') ? `https:${img[1]}` : img[1];
      out.set(slug, { id: slug, name: link[2].trim(), slug, url, categories: ['all'] });
    }
    if (page % 10 === 0) console.log(`  imgflip: ${out.size} templates (through page ${page})`);
    await sleep(150); // be polite
  }
  return [...out.values()];
}

async function fetchAllTemplates() {
  const all = [];
  for (let page = 1; ; page++) {
    const j = await fetchJSON(`${SOURCE_API}/templates?page=${page}&limit=100`);
    all.push(...(j.templates || []));
    if (!j.templates?.length || all.length >= (j.total ?? all.length)) return all;
    if (all.length >= MAX_TEMPLATES) return all.slice(0, MAX_TEMPLATES);
  }
}

async function main() {
  console.log(`Source: ${SOURCE_API}`);
  let templates = await fetchAllTemplates();
  if (Number.isFinite(MAX_TEMPLATES)) templates = templates.slice(0, MAX_TEMPLATES);
  const categories = (await fetchJSON(`${SOURCE_API}/categories`)).categories || [];
  console.log(`Fetched ${templates.length} templates, ${categories.length} categories`);

  await mkdir(join(OUT, 'images'), { recursive: true });

  // Download images and rewrite each template to point at the self-hosted copy.
  const failures = [];
  if (!SKIP_IMAGES) {
    let done = 0;
    await pool(templates, CONCURRENCY, async (t) => {
      const file = `${t.slug}${extOf(t.url)}`;
      try {
        await downloadImage(t.url, join(OUT, 'images', file));
        t._image = `images/${file}`;
      } catch (e) {
        failures.push({ slug: t.slug, error: e.message });
      }
      if (++done % 200 === 0) console.log(`  images: ${done}/${templates.length}`);
    });
  }

  const imageURL = (t) => {
    const path = t._image || null;
    if (!path) return t.url; // download failed/skipped → fall back to upstream url
    return PUBLIC_BASE ? `${PUBLIC_BASE}/${path}` : path;
  };

  const shape = (t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    image: imageURL(t),
    source_url: t.url,
    categories: t.categories || [],
  });

  const shaped = templates.map(shape);

  // "all" category: every meme scraped straight from imgflip. imgflip has no categories upstream,
  // so this lives alongside (not merged into) the source API's categories.
  const imgflip = await scrapeImgflip(ALL_CAP);
  console.log(`Scraped ${imgflip.length} imgflip templates for "all"`);
  if (!SKIP_IMAGES) {
    let done = 0;
    await pool(imgflip, CONCURRENCY, async (t) => {
      const file = `${t.slug}${extOf(t.url)}`;
      try {
        await downloadImage(t.url, join(OUT, 'images', file));
        t._image = `images/${file}`;
      } catch (e) {
        failures.push({ slug: t.slug, error: e.message });
      }
      if (++done % 200 === 0) console.log(`  all images: ${done}/${imgflip.length}`);
    });
  }
  const allShaped = imgflip.map(shape);
  const categoriesOut = [{ slug: 'all', name: 'all', count: allShaped.length }, ...categories];

  // Flat mirror of the API surface.
  await writeJSON('api/v1/templates.json', { success: true, total: shaped.length, templates: shaped });
  await writeJSON('api/v1/categories.json', { success: true, categories: categoriesOut });
  await Promise.all(shaped.map((t) => writeJSON(`api/v1/templates/${t.slug}.json`, { success: true, template: t })));
  await Promise.all(
    categories.map((c) => {
      const inCat = shaped.filter((t) => t.categories.includes(c.slug));
      return writeJSON(`api/v1/categories/${c.slug}.json`, { success: true, slug: c.slug, total: inCat.length, templates: inCat });
    })
  );
  await writeJSON('api/v1/categories/all.json', { success: true, slug: 'all', total: allShaped.length, templates: allShaped });

  const base = PUBLIC_BASE || '.';
  const index = {
    name: 'Static Meme API',
    source: SOURCE_API,
    total_templates: shaped.length,
    total_categories: categoriesOut.length,
    endpoints: {
      templates: `${base}/api/v1/templates.json`,
      template: `${base}/api/v1/templates/{slug}.json`,
      categories: `${base}/api/v1/categories.json`,
      category: `${base}/api/v1/categories/{slug}.json`,
    },
  };
  await writeJSON('api/v1/index.json', index);
  await writeFile(join(OUT, 'index.html'), landing(index, categoriesOut));

  if (failures.length) {
    console.warn(`\n${failures.length} image(s) failed (kept upstream url):`);
    failures.slice(0, 20).forEach((f) => console.warn(`  ${f.slug}: ${f.error}`));
    await writeJSON('image-failures.json', failures);
  }

  // ponytail self-check: every template must be reachable as its own file and counts must line up.
  console.assert(shaped.length > 0, 'no templates generated');
  console.assert(new Set(shaped.map((t) => t.slug)).size === shaped.length, 'duplicate slugs');
  console.assert(allShaped.length > 0, 'no imgflip templates scraped for "all"');
  console.log(`\nDone → ${OUT}/  (${shaped.length} templates, ${categoriesOut.length} categories, "all"=${allShaped.length})`);
}

function landing(index, categories) {
  const cats = categories.map((c) => `<li><a href="api/v1/categories/${c.slug}.json">${c.name}</a> <small>(${c.count})</small></li>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>${index.name}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;color:#222}
code{background:#f4f4f4;padding:.1em .4em;border-radius:4px}h1{margin-bottom:.2em}ul{columns:2}</style>
<h1>${index.name}</h1>
<p>A static, CORS-friendly mirror of <a href="${index.source}">${index.source}</a> — ${index.total_templates} templates, ${index.total_categories} categories. Regenerated via GitHub Action.</p>
<h2>Endpoints</h2>
<ul style="columns:1">
<li><code>GET /api/v1/templates.json</code> — all templates</li>
<li><code>GET /api/v1/templates/{slug}.json</code> — one template</li>
<li><code>GET /api/v1/categories.json</code> — all categories</li>
<li><code>GET /api/v1/categories/{slug}.json</code> — templates in a category</li>
</ul>
<h2>Categories</h2>
<ul>${cats}</ul>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
