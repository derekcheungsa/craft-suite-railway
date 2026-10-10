# Open Creative Suite (Craft apps) on Railway

One nginx service that serves the browser (WebAssembly) builds of six open-source
Rust apps from the [storytold](https://github.com/storytold) org — a self-hosted
creative suite in one deploy:

| Path | App | Like |
|---|---|---|
| `/photocraft/` | [PhotoCraft](https://github.com/storytold/photocraft) | Photoshop |
| `/lightcraft/` | [LightCraft](https://github.com/storytold/lightcraft) | Lightroom |
| `/pdfcraft/` | [PdfCraft](https://github.com/storytold/pdfcraft) | Acrobat |
| `/vectorcraft/` | [VectorCraft](https://github.com/storytold/vectorcraft) | Illustrator |
| `/filmcraft/` | [FilmCraft](https://github.com/storytold/filmcraft) | Premiere Pro |
| `/effectcraft/` | [EffectCraft](https://github.com/storytold/effectcraft) | After Effects |

All apps run 100% client-side (the server only hands over static files). Work is
saved in the browser's OPFS/IndexedDB, **keyed to the exact domain** — set any
custom domain *before* importing work, and export anything you care about.

## Deploy

Railway detects the Dockerfile. Build-time `ARG`s pin each app's version
(override to upgrade; build fails fast if an artifact is missing). Defaults
serve the FilmCraft/PhotoCraft `-main` web builds that ship the in-page
agent APIs:

```
PHOTOCRAFT_VERSION=0.5.0-main4  LIGHTCRAFT_VERSION=0.4.0  PDFCRAFT_VERSION=0.4.0
VECTORCRAFT_VERSION=0.7.0       FILMCRAFT_VERSION=0.4.0-main  EFFECTCRAFT_VERSION=0.6.0
FILMCRAFT_URL=... PHOTOCRAFT_URL=...  (fork release zips; see Dockerfile)
```

Local test: `docker build -t craft-suite . && docker run -p 8090:8080 craft-suite`
→ http://localhost:8090

## Server behavior (per upstream HOSTING.md of each app)

- `.wasm` served as `application/wasm`; `.js` as `text/javascript`
- gzip: precompressed at build (`gzip_static`), on-the-fly fallback
- Caching: `immutable` for hashed assets (photocraft/pdfcraft/vectorcraft/filmcraft);
  `no-cache` revalidation for unhashed ones (lightcraft/effectcraft) and all HTML
- COOP/COEP/CORP same-origin + `nosniff` on every response (needed the day
  lightcraft adds SharedArrayBuffer; harmless today — all resources same-origin)
- `/healthz` → 200 for healthchecks

Apps are MIT/Apache-2.0; ArtCraft name/logos are trademarked — this deployment
 redistributes unmodified upstream release artifacts and is not affiliated
 with Adobe or ArtCraft.

## Craft Relay — drive the apps from Claude Desktop (MCP)

A second service, `craft-relay`, exposes the browser apps as MCP tools. Claude
Desktop connects to the relay's public MCP endpoint; a bridge inside each app
page opens a WebSocket back to the relay (nothing connects until you click
**Connect agent** in the page and paste the bridge token).

The template deploys with everything pre-wired: nginx proxies `/relay/` to
the relay service over Railway's private network, so the bridge talks to the
relay **same-origin** — no `RELAY_URL` to configure and no origin allowlist to
keep in sync. `MCP_TOKEN` and `BRIDGE_TOKEN` are pre-filled with Railway's
`${{secret(...)}}` function, so every deployment gets fresh random tokens.
`ALLOWED_ORIGINS` defaults to allow-all (the bridge token remains the gate);
set it to your suite origin(s), comma-separated, to tighten.

**Setup (~3 minutes after deploy):**

1. Deploy this project (both services). Get the two generated tokens from the
   `craft-relay` service's Variables tab (`MCP_TOKEN`, `BRIDGE_TOKEN`).
2. In Claude Desktop → Settings → Connectors → Add custom connector:
   - URL: `https://<relay>.up.railway.app/mcp`
   - Request header: `Authorization: Bearer <MCP_TOKEN>`
3. Open an app (Chrome/Edge recommended), click the ⦿ button (or add `?agent=1`),
   paste the `BRIDGE_TOKEN` (relay URL is already `/relay`), Connect. Ask
   Claude: *"What tabs are connected?"*

**Tools:** `list_sessions`, `list_commands`, `run_command`, `run_batch` (≤20),
`inspect`, `get_image` (≤1 MB previews), `list_files`, `get_file` (small files
as base64+sha256), `send_file` (upload a file from the app to a URL you supply —
large media never enters the conversation), `put_file` (import INTO the app from
base64 or a URL the page fetches — generated images become documents/media;
PhotoCraft and FilmCraft and EffectCraft). Together they close the loop: export
→ send_file → transcribe/edit → put_file back in. Verified adapters: LightCraft v0.4 (`lightcraft.command`),
EffectCraft v0.6 (`execute/commands/inspect/renderFrame`), FilmCraft
`0.4.0-main` (`window.filmcraft`, 675 commands; built from unreleased `main`),
and PhotoCraft `0.5.0-main4` (`window.photocraft`, 851 commands — a minimal
fork of `main@0c72d95`; patch in `docs/photocraft-agent-api.patch`, PR
candidate). PhotoCraft `get_image` renders the document composite
engine-side (`document.render`), sidestepping eframe's web-screenshot limit.
PdfCraft/VectorCraft web builds expose no in-page agent API yet (checked 2026-10).

**Note on EffectCraft and FilmCraft:** both engines answer agent requests on
their UI frame loop. Keep the tab visible and the app running; in a fully
hidden/stalled tab, commands hang until the relay's 20 s timeout.

**Safety:** bearer-authed MCP, origin-allowlisted + token-gated bridge sockets,
destructive-command denylist, in-page read-only toggle and Disconnect,
10 calls/s rate limit, 20 s call timeout, max 5 tabs, no parameters or images
in relay logs. While connected, an agent can run commands in that tab only —
the page shows a persistent indicator.

**The one-pipeline pattern for agents** (verified end to end):

1. Generate/host an image, then `put_file` its **URL** (the page fetches it —
   bytes never enter the conversation; URL must send CORS headers, e.g.
   raw.githubusercontent.com). A **local file** is read by the agent itself and
   passed as `base64`. Works in PhotoCraft, FilmCraft, EffectCraft.
2. Edit: `run_command` / `run_batch` (PhotoCraft: `document.render`-backed
   `get_image`, `document.thumbnailGrid` for coarse colour checks).
3. Check: `get_image` returns the flattened composite as an image.
4. Export: `run_command layer.exportAs {path}` (or any export command) — lands
   in the in-app file table.
5. Retrieve: `get_file` (small) or `send_file` to a URL you control (large).

See `docs/PRD-Craft-Relay.pdf` for the design document.
