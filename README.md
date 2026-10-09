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
