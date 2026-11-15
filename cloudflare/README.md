# Craft Suite on Cloudflare (free plan)

The same site as the Railway deployment. Every file under 25 MiB is a Workers
static asset (free, unlimited, never runs the Worker); the Worker serves the
~10 bigger `.wasm` files from R2 storage, plus the `/relay/` proxy. Cloudflare Pages can't host it: Pages caps each file at 25 MiB and ten
of the apps' `.wasm` files are larger (up to ~85 MB). R2 has no such cap and its
downloads are free, so visitors' traffic doesn't cost the site owner anything.

| File | What it does |
|---|---|
| `worker.js` | Serves the site from R2 with the headers the apps need (COOP/COEP/CORP), MIME types, caching, precompressed `.gz` copies, directory pages, and the `/relay/` proxy |
| `wrangler.toml` | Worker name, R2 bucket, and the relay `/relay/` forwards to |
| `build_site.py` | Builds the site like the Dockerfile does (reads its app versions) |
| `split_assets.py` | Copies the files under 25 MiB into the static assets folder and writes its `_headers` |
| `sync_r2.py` | Uploads only changed files to R2 (keeps a SHA-256 manifest in the bucket) |
| `../.github/workflows/cloudflare.yml` | Runs them on every push to `main` that touches the site |

## Free-plan limits

- **R2:** 10 GB storage (the site is ~0.85 GB with its `.gz` copies), 10 million reads a month, free downloads.
- **Static assets:** free and unlimited; they don't count as Worker requests.
- **Workers:** 100,000 requests a day, now used only by the big `.wasm` files (about one per app opened), `/relay/` and 404s. Past that, visitors get an error until midnight UTC; nothing is billed. The Workers Paid plan ($5/month) lifts the cap if it's ever needed.

## Set up (once)

1. A Cloudflare account; open **Workers & Pages** once to choose the `workers.dev` subdomain; enable **R2**.
2. An API token with Account → Workers Scripts: Edit, Workers R2 Storage: Edit, Account Settings: Read.
3. GitHub repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Run **Publish to Cloudflare** from the Actions tab (or push to `main`). The site is then at
   `https://craft-suite.<subdomain>.workers.dev/`.

## Test locally

```sh
python3 cloudflare/build_site.py /tmp/site
WRANGLER="npx --yes wrangler@4.161.0" python3 cloudflare/sync_r2.py /tmp/site craft-suite-site --local
python3 cloudflare/split_assets.py /tmp/site cloudflare/public
cd cloudflare && npx --yes wrangler@4.161.0 dev --local
```
