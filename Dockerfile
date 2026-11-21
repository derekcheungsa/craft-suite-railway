# syntax=docker/dockerfile:1

# ---- Stage 1: fetch pinned upstream release artifacts ----
# Versions are bare semver (no "v"); release tags are v${VER} and assets are
# ${repo}-web-${VER}.zip per upstream packaging convention.
FROM alpine:3.20 AS fetch

ARG PHOTOCRAFT_VERSION=0.5.0-main4-nobrand
ARG LIGHTCRAFT_VERSION=0.21.1
ARG PDFCRAFT_VERSION=0.21.1
ARG VECTORCRAFT_VERSION=0.24.1
ARG FILMCRAFT_VERSION=0.20.1
ARG EFFECTCRAFT_VERSION=0.22.0
# Additional ArtCraft-launcher apps. All but Craft Anything have the in-page agent API
# (see the *_URL args below); Craft Anything has no control channel to drive.
ARG CADCRAFT_VERSION=0.20.1
ARG DECKCRAFT_VERSION=0.18.1
ARG GRIDCRAFT_VERSION=0.19.1
ARG SOUNDCRAFT_VERSION=0.17.0-main-agent-fonts-nobrand
ARG CRAFT_ANYTHING_VERSION=0.3.0
ARG DESIGNCRAFT_VERSION=0.17.0-main-agent-fonts-nobrand
ARG FIGCRAFT_VERSION=0.18.1
ARG MATERIALCRAFT_VERSION=0.1.3-main-agent-fonts-nobrand
ARG TEXTURECRAFT_VERSION=0.3.1-main-agent-fonts-nobrand
ARG WORDCRAFT_VERSION=0.18.1
# The PhotoCraft web build that ships the in-page agent API (window.photocraft) is built here
# from the ArtCraft team's public source (commit 0c72d95) plus docs/photocraft-agent-api.patch,
# with the ArtCraft name removed from the interface (a "patchfile" entry in
# .github/craft-web-builds.json). Until Nov 20, 2026 it was a copy of Derek Cheung's build.
# PdfCraft used to be such a build too (0.5.0-main2, with form.* commands); since Nov 13, 2026
# it is the official release, whose in-page API is opt-in with ?control (the bridge adds it).
# Upstream's own releases, unchanged, mirrored here by the build workflow ("mirror"
# entries in .github/craft-web-builds.json) because GitHub keeps answering Railway's
# builder with 504 for storytold's release assets. Keep each in step with its *_VERSION.
# GitHub's downloads are flaky at times, so each file is retried for ~10 minutes,
# switching between a mirror and the original upstream copy.
ARG LIGHTCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/lightcraft-web-0.21.1-v0.21.1/lightcraft-web-0.21.1.zip"
ARG VECTORCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/vectorcraft-web-0.24.1-v0.24.1/vectorcraft-web-0.24.1.zip"
ARG FILMCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/filmcraft-web-0.20.1-v0.20.1/filmcraft-web-0.20.1.zip"
ARG CRAFT_ANYTHING_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/craft-anything-web-0.3.0-v0.3.0/craft-anything-web-0.3.0.zip"
ARG GRIDCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/gridcraft-web-0.19.1-v0.19.1/gridcraft-web-0.19.1.zip"
ARG WORDCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/wordcraft-web-0.18.1-v0.18.1/wordcraft-web-0.18.1.zip"
ARG FIGCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/figcraft-web-0.18.1-v0.18.1/figcraft-web-0.18.1.zip"
ARG DECKCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/deckcraft-web-0.18.1-v0.18.1/deckcraft-web-0.18.1.zip"
ARG CADCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/cadcraft-web-0.20.1-v0.20.1/cadcraft-web-0.20.1.zip"
ARG EFFECTCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/effectcraft-web-0.22.0-v0.22.0/effectcraft-web-0.22.0.zip"
ARG PHOTOCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/photocraft-web-0.5.0-main4-nobrand-0c72d95/photocraft-web-0.5.0-main4-nobrand.zip"
ARG PDFCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/pdfcraft-web-0.21.1-v0.21.1/pdfcraft-web-0.21.1.zip"
# GridCraft, WordCraft, FigCraft, DeckCraft and CADCraft releases ship the in-page agent
# API (window.<app> from craft-web-api) themselves, so they are mirrored above.
# DesignCraft, SoundCraft, MaterialCraft and TextureCraft releases don't yet: these are
# upstream main plus .github/craft-web-patches (the agent API, then debrand.py, which removes
# the ArtCraft name from the interface), built by .github/workflows/build-craft-web.yml.
ARG DESIGNCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/designcraft-web-0.17.0-main-agent-fonts-nobrand-49f6b85/designcraft-web-0.17.0-main-agent-fonts-nobrand.zip"
ARG SOUNDCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/soundcraft-web-0.17.0-main-agent-fonts-nobrand-ddeb7e7/soundcraft-web-0.17.0-main-agent-fonts-nobrand.zip"
ARG MATERIALCRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/materialcraft-web-0.1.3-main-agent-fonts-nobrand-767dd65/materialcraft-web-0.1.3-main-agent-fonts-nobrand.zip"
ARG TEXTURECRAFT_URL="https://github.com/derekcheungsa/craft-suite-railway/releases/download/texturecraft-web-0.3.1-main-agent-fonts-nobrand-4be75a2/texturecraft-web-0.3.1-main-agent-fonts-nobrand.zip"

RUN apk add --no-cache curl unzip gzip
WORKDIR /site

RUN set -eux; \
    fetch() { \
      repo="$1"; ver="$2"; override="${3:-}"; \
      upstream="https://github.com/storytold/${repo}/releases/download/v${ver}/${repo}-web-${ver}.zip"; \
      url="${override:-$upstream}"; alt="$url"; \
      case "$override" in */${repo}-web-${ver}-v${ver}/*) alt="$upstream";; esac; \
      n=0; \
      until echo "fetching ${url}" && curl -fsSL --connect-timeout 30 --max-time 600 -o /tmp/app.zip "${url}"; do \
        n=$((n+1)); [ "$n" -ge 40 ] && exit 1; \
        t="$url"; url="$alt"; alt="$t"; sleep 15; \
      done; \
      unzip -q /tmp/app.zip -d /tmp/app; \
      mv "/tmp/app/${repo}-web-${ver}" "/site/${repo}"; \
      rm -rf /tmp/app /tmp/app.zip; \
      printf '%s"%s":"v%s"' "${sep:-}" "$repo" "$ver" >> /tmp/versions.part; sep=","; \
    }; \
    fetch photocraft     "${PHOTOCRAFT_VERSION}" "${PHOTOCRAFT_URL}"; \
    fetch lightcraft     "${LIGHTCRAFT_VERSION}" "${LIGHTCRAFT_URL}"; \
    fetch pdfcraft       "${PDFCRAFT_VERSION}" "${PDFCRAFT_URL}"; \
    fetch vectorcraft    "${VECTORCRAFT_VERSION}" "${VECTORCRAFT_URL}"; \
    fetch filmcraft      "${FILMCRAFT_VERSION}" "${FILMCRAFT_URL}"; \
    fetch effectcraft    "${EFFECTCRAFT_VERSION}" "${EFFECTCRAFT_URL}"; \
    fetch cadcraft       "${CADCRAFT_VERSION}" "${CADCRAFT_URL}"; \
    fetch deckcraft      "${DECKCRAFT_VERSION}" "${DECKCRAFT_URL}"; \
    fetch gridcraft      "${GRIDCRAFT_VERSION}" "${GRIDCRAFT_URL}"; \
    fetch soundcraft     "${SOUNDCRAFT_VERSION}" "${SOUNDCRAFT_URL}"; \
    fetch craft-anything "${CRAFT_ANYTHING_VERSION}" "${CRAFT_ANYTHING_URL}"; \
    fetch designcraft    "${DESIGNCRAFT_VERSION}" "${DESIGNCRAFT_URL}"; \
    fetch figcraft       "${FIGCRAFT_VERSION}" "${FIGCRAFT_URL}"; \
    fetch materialcraft  "${MATERIALCRAFT_VERSION}" "${MATERIALCRAFT_URL}"; \
    fetch texturecraft   "${TEXTURECRAFT_VERSION}" "${TEXTURECRAFT_URL}"; \
    fetch wordcraft      "${WORDCRAFT_VERSION}" "${WORDCRAFT_URL}"; \
    { printf '{'; cat /tmp/versions.part; printf '}\n'; } > /site/versions.json; \
    rm /tmp/versions.part

# Craft Relay bridge: static script served same-origin. Inject the script
# tags BEFORE precompressing, so index.html.gz matches the on-disk file.
# RELAY_URL may be absolute (https://relay.example) or relative ("/relay"),
# which resolves against the page origin through nginx's /relay/ proxy.
ARG RELAY_URL="/relay"
COPY bridge/ /site/bridge/
RUN printf 'window.CRAFT_RELAY = { url: "%s" };\n' "$RELAY_URL" > /site/bridge/config.js && \
    for f in /site/*/index.html; do \
      grep -q 'bridge/loader.js' "$f" || \
      sed -i 's#</body>#<script src="/bridge/config.js"></script><script src="/bridge/adapters.js"></script><script src="/bridge/loader.js" defer></script></body>#' "$f"; \
    done

# Precompress the heavy payloads once at build time; nginx serves the .gz
# copies via gzip_static instead of compressing on every request.
RUN find /site -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.html' \) \
      -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \;

# ---- Stage 2: nginx serving the apps, portal, guide and bridge ----
FROM nginx:1.27-alpine

# Port nginx listens on, plus the relay proxy's upstream (host:port on
# Railway private networking — the platform injects PORT=8080 into the relay
# container) and the DNS resolver used to re-resolve it per request.
ENV PORT=8080
ARG RELAY_UPSTREAM="craft-relay.railway.internal:8080"
ENV RELAY_UPSTREAM=${RELAY_UPSTREAM}
ARG RESOLVER="[fd12::10]"
ENV RESOLVER=${RESOLVER}

COPY nginx/templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=fetch /site /usr/share/nginx/html
COPY portal/ /usr/share/nginx/html/

EXPOSE 8080
