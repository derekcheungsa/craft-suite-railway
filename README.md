# Craft Suite: 16 open-source creative apps in your browser, with Claude

> **Credit:** Craft Suite was created by **Derek Cheung**
> ([derekcheungsa/craft-suite-railway](https://github.com/derekcheungsa/craft-suite-railway),
> [YouTube](https://www.youtube.com/@derekcheungsa), [Railway template](https://railway.com/deploy/craft-suite)).
> His original served six apps and let Claude drive them through a relay. This fork builds on
> that work; see [What's different in this fork](#whats-different-in-this-fork).

One site that serves the browser (WebAssembly) builds of 16 open-source apps by the
ArtCraft team ([storytold](https://github.com/storytold) on GitHub), plus a small relay
that lets Claude work in them. A main page groups the apps, and a guide at `/guide/`
explains how to use them.

| Group | App | Similar to | Works with Claude |
|---|---|---|---|
| Photo | [PhotoCraft](https://github.com/storytold/photocraft) | Photoshop | yes |
| | [LightCraft](https://github.com/storytold/lightcraft) | Lightroom | yes |
| Graphics & Design | [VectorCraft](https://github.com/storytold/vectorcraft) | Illustrator | yes |
| | [FigCraft](https://github.com/storytold/figcraft) | Figma | yes |
| | [DesignCraft](https://github.com/storytold/designcraft) | InDesign | yes |
| Video & Audio | [FilmCraft](https://github.com/storytold/filmcraft) | Premiere | yes |
| | [EffectCraft](https://github.com/storytold/effectcraft) | After Effects | yes |
| | [SoundCraft](https://github.com/storytold/soundcraft) | a DAW | yes |
| | [AniCraft](https://github.com/storytold/anicraft) | Animate | coming soon (no browser build yet) |
| Documents & Office | [WordCraft](https://github.com/storytold/wordcraft) | Word | yes |
| | [GridCraft](https://github.com/storytold/gridcraft) | Excel | yes |
| | [DeckCraft](https://github.com/storytold/deckcraft) | PowerPoint | yes |
| | [PdfCraft](https://github.com/storytold/pdfcraft) | Acrobat | yes |
| 3D & CAD | [CADCraft](https://github.com/storytold/cadcraft) | AutoCAD | yes |
| | [MaterialCraft](https://github.com/storytold/materialcraft) | Substance Designer | yes |
| | [TextureCraft](https://github.com/storytold/texturecraft) | Substance Painter | yes |
| Experimental | [Craft Anything](https://github.com/storytold/craft-anything) | | no |

Every app runs entirely in the browser; the server only hands over static files. Work
is saved in the browser's storage (OPFS / IndexedDB) **for that exact web address**, so
pick your address before doing real work, and export anything you care about. Chrome
or Edge is recommended (WebGPU).

## What's different in this fork

Compared with Derek's original (commit `f1420e8`, October 2026):

- **Ten more apps** (six to 16), plus a "coming soon" card for AniCraft.
- **Claude control for 15 of the 16.** The newer official releases include their own
  in-page Claude API; DesignCraft, SoundCraft, MaterialCraft and TextureCraft are built
  here from upstream source with a small patch that adds one (see "Builds" below).
- **Official releases** wherever they exist, kept as copies in this repo's GitHub
  Releases so the site doesn't depend on anyone else's downloads staying up.
- **Main page redesign** (apps grouped by kind, version list, a short Claude summary)
  and a **visitor guide** at `/guide/`.
- **A shared file "shelf"** so Claude can move files between app tabs, and an opt-in
  "also download new exports to this PC" box.
- **Relay version check:** the relay reports its version and the agent panel tells
  visitors whose own relay needs updating.
- **Free hosting on Cloudflare** (Worker + R2) alongside Railway; see `cloudflare/`.
- **Independence and trademark notices** on every page.

## Builds

App versions are pinned as `ARG`s in the `Dockerfile`, which both Railway and the
Cloudflare build read.

- **Official releases, unmodified:** LightCraft, VectorCraft, FilmCraft, EffectCraft,
  CADCraft, DeckCraft, GridCraft, FigCraft, WordCraft, PdfCraft and Craft Anything. They are
  copied from upstream releases into this repo's releases by
  `.github/workflows/build-craft-web.yml` (entries marked `"mirror": true` in
  `.github/craft-web-builds.json`).
- **Built here, modified, with the ArtCraft name removed:** DesignCraft, SoundCraft,
  MaterialCraft, TextureCraft and PhotoCraft. Each is built from the ArtCraft team's public
  source at a pinned commit, plus a small patch that adds the in-page Claude API (patches in
  `.github/craft-web-patches/`; PhotoCraft's is `docs/photocraft-agent-api.patch`, first
  written by Derek Cheung), and then `.github/craft-web-patches/debrand.py`, which removes
  the ArtCraft name and logo from the interface and translations, because the brand licence
  doesn't allow modified builds to carry them. The only mention left is the plain-text
  credit in each About window, "Based on <App> by the ArtCraft team"; the licence and
  NOTICE files are untouched, and the Discord and website links still go to the ArtCraft
  team's pages, with generic labels. The workflow fails a build if the name is left in it.
  (PhotoCraft was a copy of Derek's build until November 20, 2026. PdfCraft was also his
  custom build, `0.5.0-main2`, until November 2026, when it moved to the official release.
  His PdfCraft patch, `docs/pdfcraft-agent-api.patch`, added form commands, such as filling
  a field by name, that the official release doesn't have yet; there, Claude fills a form by
  clicking a field and typing.)

Server behaviour follows each app's HOSTING notes: `.wasm` as `application/wasm`,
precompressed gzip, `immutable` caching for hashed assets and `no-cache` for the rest,
COOP/COEP/CORP same-origin and `nosniff` on every response, and `/healthz` for health
checks.

## Hosting

### Railway

Two services: `craft-suite` (nginx, built from the root `Dockerfile`) and
`craft-relay` (a small Node service in `server/`). nginx forwards `/relay/` to the relay
over Railway's private network, so the in-page panel reaches it on the same address.
The relay rebuilds only when files under `server/` change.

Local test: `docker build -t craft-suite . && docker run -p 8090:8080 craft-suite`,
then open http://localhost:8090.

### Cloudflare (free)

The same site, served by a Cloudflare Worker from R2 storage, so visitors' downloads
cost nothing. Every push to `main` that touches the site republishes it
(`.github/workflows/cloudflare.yml`). The Worker forwards `/relay/` to the Railway relay.
Setup and free-plan limits are in [cloudflare/README.md](cloudflare/README.md).

## Claude: the Craft Relay

The relay exposes the browser apps to Claude as MCP tools. Claude connects to the
relay's `/mcp` address; a small panel in each app page (the ⦿ button) opens a
connection back to the relay once you click **Connect** and paste the bridge token.
Nothing connects until you do, and a Disconnect button is always visible.

**Setting up your own relay** (needed to use Claude with someone else's Craft Suite
site, whose relay belongs to its owner):

1. Fork this repo on GitHub.
2. In Railway: **New Project → Deploy from GitHub repo →** your fork. In the service's
   **Settings**, set **Root Directory** to `server`.
3. In **Variables**, add `MCP_TOKEN` (32+ random characters, e.g.
   `openssl rand -base64 32`) and `BRIDGE_TOKEN` (16+ characters). Optionally set
   `ALLOWED_ORIGINS` to the suite's address so only that site can open bridge connections.
4. **Settings → Networking → Generate Domain.**
5. In Claude: **Settings → Connectors → Add custom connector**, URL
   `https://<your-relay-domain>/mcp`, header `Authorization: Bearer <MCP_TOKEN>`.
6. On the suite site, open an app, click ⦿, set the relay address to
   `https://<your-relay-domain>`, paste your `BRIDGE_TOKEN`, and Connect.

The guide's "Using Claude" section walks through the same steps for visitors. Keep both
tokens private: anyone with `MCP_TOKEN` can drive tabs connected to your relay, and
anyone with `BRIDGE_TOKEN` can connect tabs to it. When this repo's relay changes, the
agent panel shows a notice; update your fork with GitHub's **Sync fork** button.

**Tools:** `list_sessions`, `list_commands`, `run_command`, `run_batch` (up to 20),
`inspect`, `get_image` (previews up to 1 MB), `list_files`, `get_file` (small files),
`send_file` (upload a file from the app to a URL you give, so large media never enters
the conversation) and `put_file` (import into the app from base64 or a URL the page
fetches). Each app's adapter is in `bridge/adapters.js`.

**Moving files between apps (the shelf).** Every app is served from the same address,
so their tabs share one browser store. `send_file` with url `https://shelf/<name>` puts
a file on the shelf; `put_file` with that url in another tab imports it; `list_files`
lists shelf entries. Files stay in the browser, never on the relay or in the
conversation.

**Note on EffectCraft and FilmCraft:** both answer Claude on their drawing loop. Keep
the tab visible; in a hidden tab, commands wait until the relay's 20-second timeout.

**Safety:** token-protected MCP; origin-checked, token-gated bridge connections; a
denylist of destructive commands; a read-only switch and Disconnect in the page; 10
calls a second, 20-second timeout, at most 5 tabs; no parameters or images in relay
logs. While connected, Claude can act only in that tab, and the page shows that it is
connected.

The relay's original design is Derek Cheung's: see `PRD.md` and
`docs/PRD-Craft-Relay.pdf`.

## Credits, licences and trademarks

- **Craft Suite** was created by Derek Cheung. His repository does not include a
  licence yet, so his original code remains his; this fork will adopt whatever licence
  he chooses.
- **The apps** are by the ArtCraft team (storytold), MIT / Apache-2.0. This is an
  independent community project, not made, sponsored or endorsed by the ArtCraft team.
  The five builds listed under "Built here" above are modified to add Claude control and
  show no ArtCraft name or logo except the credit "Based on <App> by the ArtCraft team".
  The ArtCraft name, wordmark and logos are trademarks of the ArtCraft Team (see
  `docs/brand/LICENSE-brand.txt` in any of their repositories).
- **Font:** Archivo, SIL Open Font License (`portal/fonts/OFL-Archivo.txt`).
- Adobe, Microsoft, Figma and Autodesk product names are trademarks of their owners,
  used only to describe similar apps.
