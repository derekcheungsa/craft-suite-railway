# PRD — "Craft Suite" Railway Template

**Status:** Draft v1 for review
**Date:** 2026-10-08
**Owner:** Derek
**Repo target:** new repo (proposed: `craft-suite-railway`) + Railway template generated from the deployed project

---

## 1. Summary

Create a one-click **Railway template** that deploys all six of storytold's Adobe-reimplementation apps — **photocraft** (Photoshop), **lightcraft** (Lightroom), **pdfcraft** (Acrobat), **vectorcraft** (Illustrator), **filmcraft** (Premiere Pro), and **effectcraft** (After Effects) — so anyone can spin up a browser-based, self-hosted "open creative suite" in one click, then publish that setup as a reusable Railway template.

## 2. Background

The [storytold](https://github.com/storytold) org (the "ArtCraft" project) publishes clean-room reimplementations of creative software in pure Rust (MIT/Apache-2.0). The six Adobe-style apps are:

| Repo | Reimplements | Stars (approx) | Web build |
|---|---|---|---|
| [photocraft](https://github.com/storytold/photocraft) | Photoshop | 27.4k | static WASM zip |
| [lightcraft](https://github.com/storytold/lightcraft) | Lightroom | 5.7k | static WASM zip |
| [pdfcraft](https://github.com/storytold/pdfcraft) | Acrobat | 4.6k | static WASM zip |
| [vectorcraft](https://github.com/storytold/vectorcraft) | Illustrator | 3.9k | static WASM zip |
| [filmcraft](https://github.com/storytold/filmcraft) | Premiere Pro | 5.4k | static WASM zip |
| [effectcraft](https://github.com/storytold/effectcraft) | After Effects | 2.8k | static WASM zip |

**The load-bearing architectural fact:** these are *not* client-server apps. Each is a native egui desktop app that also compiles to WebAssembly. The web build is a **fully static site** shipped as `*-web-<ver>.zip` in GitHub Releases ("runs in a modern browser; host it on any static server"). There is **no backend, no database, no storage service, and no Dockerfile** in any of the six repos. Documents/projects persist client-side (OPFS/IndexedDB). Headless CLI/MCP/control-channel features are desktop automation surfaces and are **out of scope** for this deployment.

Therefore "deploying all 6 on Railway" means: **build/serve six static WASM sites and route to them** — a static-hosting problem, not an application-hosting problem.

## 3. Goals

- **G1** — One template that stands up all six apps in a single Railway deployment, one click, no code changes to upstream repos.
- **G2** — Fast, reliable deploys: template build completes in **< 5 minutes** (no 20+ minute Rust/WASM compiles in the deploy path).
- **G3** — Version pinning with safe override: each app pinned to a known-good release tag, overridable via template variables.
- **G4** — Publishable, redistributable template on Railway (marketplace-ready), with correct open-source attribution and no trademark problems.
- **G5** — Cheap to run: target a single small static-serving service (idles near zero usage; fits comfortably in Hobby plan).

## 4. Non-goals

- **NG1** — No server-side document storage, accounts, auth, or multi-user collaboration (the apps are local-first by design; files stay in the user's browser).
- **NG2** — No desktop packaging, CLI/MCP servers, or control-channel bridging on Railway.
- **NG3** — No forking or patching of the six upstream apps unless a subpath-hosting bug forces it (see R1).
- **NG4** — The non-Adobe siblings (soundcraft, cadcraft, gridcraft, deckcraft) are **excluded** for v1; the template structure should make adding them later trivial.
- **NG5** — No CDN/edge product in v1 — Railway + nginx only.

## 5. Target users

- **Self-hosters / homelab users** who want a browser-based creative suite at a personal URL.
- **Railway users browsing the marketplace** looking for impressive one-click demos.
- **The ArtCraft community** — a canonical "try it in your browser" deployment.
- (Secondary) **Derek's audience** — template + writeup/video material ("self-host your own Adobe suite").

## 6. Proposed architecture

### Recommended: Option A — single "suite gateway" service

One repo, one Dockerfile, one Railway service:

```
craft-suite-railway/
├── Dockerfile            # FROM nginx (or caddy); downloads 6 pinned release zips at build
├── nginx.conf            # subpath routing, wasm/brotli, COOP/COEP, cache headers
├── portal/index.html     # landing page linking all six apps
├── .railway/railway.ts   # (if needed) IaC per new Railway standard
└── README.md
```

- **Build step (in Dockerfile):** `curl` each app's pinned `*-web-<ver>.zip` from GitHub Releases, unzip into `/usr/share/nginx/html/<app>/`.
- **Routing:** path-based — `<domain>/photocraft/`, `/lightcraft/`, `/pdfcraft/`, `/vectorcraft/`, `/filmcraft/`, `/effectcraft/`, with `/` serving a small portal page.
- **Why not build from source:** each repo is a 20+-crate Rust workspace; release WASM builds would take 15–45 min each (×6) and risk Railway builder limits — directly violating G2. Prebuilt release zips are the upstream-supported distribution ("host it on any static server").
- **Healthcheck:** `/healthz` → 200 from nginx.

### Alternatives considered

| | Option A: single gateway, subpaths (recommended) | Option B: six static services, one per app | Option C: build from source in Docker |
|---|---|---|---|
| Deploy UX | 1 service, 1 domain | 6 services, 6 domains | same as A or B |
| Build time | ~2–4 min (downloads) | ~2–4 min (6× small builds) | 1.5–4+ hours total |
| Subpath risk | **Yes — must validate (R1)** | None (each at root) | None (Trunk `--public-url`) |
| Cost/ops | Minimal | 6× (still cheap) | Same runtime, brutal builds |
| Verdict | **v1** | Fallback if R1 bites, or v2 "per-app" variant | Opt-in advanced variant only |

**Decision:** Option A for v1, with Option B held as the designed fallback if subpath serving of prebuilt zips proves broken (see §9, R1).

### Railway mechanics (current, verified)

- Template creation: deploy the project → **Project → Settings → "Generate Template from Project" → Create Template**; publish later via **Workspace settings → Templates → Publish** (or CLI `railway templates`). Publish flow per [docs](https://docs.railway.com/templates/create).
- **Do not build the repo around `railway.json`/`railway.toml`** — Config-as-Code is deprecated with a **2026-12-01 hard cutoff**, and new services cannot opt in ([deprecation note](https://docs.railway.com/config-as-code)). Use a plain **Dockerfile** (auto-detected) and, if service config must live in code, the new **Infrastructure-as-Code `.railway/railway.ts`** ([IaC docs](https://docs.railway.com/infrastructure-as-code)).
- Template variables become user-configurable fields at deploy time (used here for version pins).

## 7. Functional requirements

| ID | Requirement |
|---|---|
| FR-1 | Template deploys **one Railway service** that serves all six apps at `/photocraft/`, `/lightcraft/`, `/pdfcraft/`, `/vectorcraft/`, `/filmcraft/`, `/effectcraft/`. |
| FR-2 | Root `/` serves a portal page: name, one-line description, "open" link per app; upstream license attribution; version badge per app. |
| FR-3 | Each app version is **pinned by default** to a tested release tag; overridable via template variables `PHOTOCRAFT_VERSION`, `LIGHTCRAFT_VERSION`, `PDFCRAFT_VERSION`, `VECTORCRAFT_VERSION`, `FILMCRAFT_VERSION`, `EFFECTCRAFT_VERSION`. |
| FR-4 | Build fails loudly (non-zero exit) if a pinned artifact 404s — no silent partial deploys. |
| FR-5 | `/healthz` returns 200; configured as the service healthcheck. |
| FR-6 | A `latest`-style variable value (e.g. `VERSION=latest`) resolves the newest release at build time via the GitHub API, with the resolved tag echoed in build logs and portal footer. |
| FR-7 | README covers: what it deploys, screenshots, one-click deploy button, custom-domain instructions, version override, browser support caveats, licenses. |
| FR-8 | Template generation executed from the deployed project; template tested by deploying **from the template** into a fresh project (not just the source project). |

## 8. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | **Compression:** nginx serves `.wasm` (and text assets) with gzip/brotli; WASM payloads are the entire app — uncompressed serving is unacceptable. |
| NFR-2 | **Caching:** hashed assets get `Cache-Control: public, max-age=31536000, immutable`; `index.html` gets no-cache so version bumps propagate. |
| NFR-3 | **Cross-origin isolation:** send `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` — required if any app uses multithreaded WASM (`SharedArrayBuffer`/wasm-bindgen-rayon); harmless otherwise since everything is same-origin. Verify per app in M0. |
| NFR-4 | **Correct MIME:** `application/wasm` for `.wasm` (instant `WebAssembly.instantiateStreaming`; wrong MIME silently forces slow fallback). |
| NFR-5 | **Runtime footprint:** single service, < 256 MB RAM, near-zero CPU at idle. |
| NFR-6 | **Build time:** < 5 min cold build (G2). |
| NFR-7 | **Attribution/trademarks:** keep upstream `LICENSE` files from each zip served at `/<app>/LICENSE`; template name must not use "Adobe" or ArtCraft branding (see R7). |

## 9. Risks & mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **R1** | **Prebuilt zips assume root deployment** — absolute `/index.js`-style asset paths break under `/photocraft/` subpaths | Medium | High | M0 spike: serve one zip at a subpath and inspect. If broken: (a) check for relative paths (wasm-bindgen default is often relative — may just work), (b) nginx `sub_filter` rewrite (last resort, fragile), (c) fall back to **Option B** (six services at root) — this risk is exactly why Option B is pre-designed. |
| **R2** | WASM apps need COOP/COEP or multithreading off | Medium | Medium | NFR-3 headers; test each app; document any app that degrades to single-thread. |
| **R3** | Large WASM payloads (tens of MB per app) → slow first load | High | Medium | Brotli + immutable caching (NFR-1/2); show sizes on portal page so it's an expectation, not a surprise. |
| **R4** | WebGPU gaps (lightcraft explicitly in-progress on Safari/Firefox) → CPU-fallback slowness | Medium | Low | Document browser support (Chrome/Edge recommended); nothing server-side to fix. |
| **R5** | Upstream release rename/artifact 404 breaks template builds | Medium | High | FR-4 fail-fast; quarterly pin-bump checklist; `latest` mode (FR-6) as escape hatch. |
| **R6** | GitHub rate limits during image builds (unauthenticated API for `latest` resolution) | Low | Medium | Prefer pinned tags (direct release-download URLs, not API); document a `GITHUB_TOKEN` build arg for heavy use. |
| **R7** | Naming/licensing: ArtCraft name & logos trademarked (must not imply affiliation); "Adobe" in a marketplace listing name is asking for trouble | Medium | Medium | Name template neutrally, e.g. **"Open Creative Suite (Craft apps)"**; upstream READMEs reference Adobe only descriptively — mirror that pattern; keep MIT/Apache-2.0 + brand-license attribution (NFR-7). |
| **R8** | Railway Config-as-Code deprecation (2026-12-01) breaks template if built on `railway.json` | Certain if ignored | High | Already designed around: Dockerfile-only + `.railway/railway.ts` IaC if needed (§6). |

## 10. Milestones & deliverables

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Spike (½ day)** | Locally: nginx + photocraft release zip at `/photocraft/`; test in Chrome. Resolve R1 (subpaths) and R2 (COOP/COEP) for one app. | App loads and is interactive under a subpath, or decision recorded to switch to Option B. |
| **M1 — Suite repo (1 day)** | Repo with Dockerfile, nginx.conf, portal page, pinned versions for all six, fail-fast checks, healthz, README skeleton. | `docker run` locally serves all six apps + portal. |
| **M2 — Railway deploy (½ day)** | Deploy as a Railway project; generate a domain; verify all six apps in-browser; set healthcheck. | All six apps load from the public Railway URL. |
| **M3 — Template (½ day)** | Project → Settings → **Generate Template from Project**; define variables (FR-3); deploy **from the template** into a fresh test project; iterate. | Fresh one-click deploy from template is green; all six apps work. |
| **M4 — Publish & polish (½ day)** | Publish template to marketplace (Workspace → Templates → Publish); finalize README (screenshots, custom domains, browser caveats); optional: add `latest` mode, optional soundcraft/cadcraft/gridcraft/deckcraft variant. | Template live & shareable; README complete. |

## 11. Success criteria

1. A stranger can deploy all six apps from the marketplace template in **one click, under 5 minutes**, and every app loads and runs in Chrome.
2. Idle cost fits in the Railway Hobby plan ($5/mo) with room to spare.
3. Upgrading one app = changing one template variable, redeploying.
4. No upstream code forked or patched (or, if R1 forces it, one minimal documented patch).
5. Template passes Railway publish review: accurate description, no trademark issues, working variables.

## 12. Open questions (for review)

1. **Option A vs B preference** — single gateway (recommended, one domain) vs six services (six domains, zero subpath risk). Are six separate Railway domains acceptable/desirable for you either way?
2. **Template name** — proposing "Open Creative Suite (Craft apps)"; open to alternatives that dodge both Adobe and ArtCraft marks.
3. **Marketplace publish** — M4 publishes publicly. OK, or keep the template private/share-by-link initially?
4. **Scope creep check** — include the four non-Adobe siblings (soundcraft, cadcraft, gridcraft, deckcraft) in a v1.1 variant, or leave out indefinitely?
5. **Version defaults** — pin all six to latest-at-build releases at M1, or wait for M0 stability testing first? (Proposed: pin at M1, verify at M2.)

---

## Appendix A — Reference facts (verified 2026-10-08)

- All six repos: MIT/Apache-2.0 dual license; egui native UI; wgpu GPU + CPU fallback; WASM builds via wasm-bindgen/Trunk; release artifacts include `*-web-<ver>.zip` static bundles; no Dockerfiles; no DB/storage deps; optional `CRAFT_FONTS_DIR` (fonts are bundled in official releases).
- Control/MCP surfaces exist (e.g., filmcraft `--control 9876`, lightcraft `--control 7980`, vectorcraft `--control 7979`, effectcraft `--control 9877`) but are loopback/desktop automation — **not** part of web deployment.
- Railway: templates generated from a project via Settings → "Generate Template from Project" ([create docs](https://docs.railway.com/templates/create)); publishing via Workspace → Templates ([publish docs](https://docs.railway.com/templates/publish-and-share)); Config-as-Code deprecated → `.railway/railway.ts` IaC ([reference](https://docs.railway.com/config-as-code), [IaC](https://docs.railway.com/infrastructure-as-code)).
