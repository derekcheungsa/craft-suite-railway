# Craft Suite — 6 Open-Source Creative Apps (Rust + WASM)

Deploy an entire open-source creative suite in one click. Six desktop-grade apps, rewritten from scratch in pure Rust and compiled to WebAssembly, running entirely in your browser:

| Path | App | An open alternative to |
|---|---|---|
| `/photocraft/` | PhotoCraft | Photoshop — layers, masks, PSD import, GPU compositing |
| `/lightcraft/` | LightCraft | Lightroom — photo library, RAW developer, batch edits |
| `/pdfcraft/` | PdfCraft | Acrobat — view, merge, split, annotate, fill, encrypt PDFs |
| `/vectorcraft/` | VectorCraft | Illustrator — vector graphics, typography, SVG/PDF export |
| `/filmcraft/` | FilmCraft | Premiere Pro — timeline video editing, grading, codecs |
| `/effectcraft/` | EffectCraft | After Effects — motion graphics, keyframes, render queue |

## How it works

Every app is 100% client-side — the server is just nginx handing over static WASM files. No database, no storage service, no accounts. That means near-zero idle resource usage; it fits comfortably in the Hobby plan. WASM payloads are precompressed and cached aggressively, so repeat loads are fast.

## Your data stays in your browser

Documents and projects persist to browser storage (OPFS/IndexedDB) — nothing is sent to or stored on the server. Note that browser storage is tied to the exact domain: **configure your custom domain before importing important work**, and export anything you can't afford to lose.

## Tips

- Chrome or Edge recommended (WebGPU). Other browsers fall back to WebGL2/CPU paths.
- Each app's version is pinned via a variable (e.g. `PHOTOCRAFT_VERSION`) — bump it to upgrade that app, then redeploy.
- A `/healthz` endpoint is available for healthchecks.

## Credits

All six apps are built by the [storytold](https://github.com/storytold) org (MIT / Apache-2.0); this template redistributes their unmodified release artifacts behind an nginx portal. Not affiliated with Adobe or ArtCraft.
