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
(override to upgrade; build fails fast if an artifact is missing):

```
PHOTOCRAFT_VERSION=0.5.0  LIGHTCRAFT_VERSION=0.4.0  PDFCRAFT_VERSION=0.4.0
VECTORCRAFT_VERSION=0.7.0 FILMCRAFT_VERSION=0.4.0   EFFECTCRAFT_VERSION=0.6.0
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

**Setup (~5 minutes):**

1. Deploy this project (both services). Note the two domains:
   - suite: `https://<suite>.up.railway.app`
   - relay: `https://<relay>.up.railway.app` (`railway domain --service craft-relay`)
2. On the `craft-relay` service, set variables:
   - `MCP_TOKEN` — 32+ random bytes (`openssl rand -base64 32`)
   - `BRIDGE_TOKEN` — another random string
   - `ALLOWED_ORIGINS` — your suite origin (`https://<suite>.up.railway.app`)
3. On the `craft-suite` service, set `RELAY_URL=https://<relay>.up.railway.app`
   (passed to the Dockerfile as a build arg; the bridge then pre-fills itself).
4. In Claude Desktop → Settings → Connectors → Add custom connector:
   - URL: `https://<relay>.up.railway.app/mcp`
   - Request header: `Authorization: Bearer <MCP_TOKEN>`
5. Open an app (Chrome/Edge recommended), click the ⦿ button (or add `?agent=1`),
   paste the `BRIDGE_TOKEN`, Connect. Ask Claude: *"What tabs are connected?"*

**Tools:** `list_sessions`, `list_commands`, `run_command`, `run_batch` (≤20),
`inspect`, `get_image` (≤1 MB previews; EffectCraft renders frames). Verified
adapters: LightCraft v0.4 (`lightcraft.command`), EffectCraft v0.6
(`execute/commands/inspect/renderFrame`). FilmCraft/PhotoCraft/PdfCraft/
VectorCraft web builds expose no in-page agent API yet (checked 2026-10).

**Safety:** bearer-authed MCP, origin-allowlisted + token-gated bridge sockets,
destructive-command denylist, in-page read-only toggle and Disconnect,
10 calls/s rate limit, 20 s call timeout, max 5 tabs, no parameters or images
in relay logs. While connected, an agent can run commands in that tab only —
the page shows a persistent indicator.

See `docs/PRD-Craft-Relay.pdf` for the design document.
