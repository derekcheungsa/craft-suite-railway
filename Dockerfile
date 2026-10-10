# syntax=docker/dockerfile:1

# ---- Stage 1: fetch pinned upstream release artifacts ----
# Versions are bare semver (no "v"); release tags are v${VER} and assets are
# ${repo}-web-${VER}.zip per upstream packaging convention.
FROM alpine:3.20 AS fetch

ARG PHOTOCRAFT_VERSION=0.5.0
ARG LIGHTCRAFT_VERSION=0.4.0
ARG PDFCRAFT_VERSION=0.4.0
ARG VECTORCRAFT_VERSION=0.7.0
ARG FILMCRAFT_VERSION=0.4.0
ARG EFFECTCRAFT_VERSION=0.6.0
# Optional: serve a custom FilmCraft web build instead of the upstream release
# (e.g. a build from main that ships the window.filmcraft agent API).
ARG FILMCRAFT_URL=""
# Optional: custom PhotoCraft web build (the fork that installs window.photocraft).
ARG PHOTOCRAFT_URL=""

RUN apk add --no-cache curl unzip gzip
WORKDIR /site

RUN set -eux; \
    fetch() { \
      repo="$1"; ver="$2"; override="${3:-}"; \
      if [ -n "$override" ]; then url="$override"; \
      else url="https://github.com/storytold/${repo}/releases/download/v${ver}/${repo}-web-${ver}.zip"; fi; \
      echo "fetching ${url}"; \
      curl -fsSL --retry 3 -o /tmp/app.zip "${url}"; \
      unzip -q /tmp/app.zip -d /tmp/app; \
      mv "/tmp/app/${repo}-web-${ver}" "/site/${repo}"; \
      rm -rf /tmp/app /tmp/app.zip; \
    }; \
    fetch photocraft  "${PHOTOCRAFT_VERSION}" "${PHOTOCRAFT_URL}"; \
    fetch lightcraft  "${LIGHTCRAFT_VERSION}"; \
    fetch pdfcraft    "${PDFCRAFT_VERSION}"; \
    fetch vectorcraft "${VECTORCRAFT_VERSION}"; \
    fetch filmcraft   "${FILMCRAFT_VERSION}" "${FILMCRAFT_URL}"; \
    fetch effectcraft "${EFFECTCRAFT_VERSION}"; \
    printf '{"photocraft":"v%s","lightcraft":"v%s","pdfcraft":"v%s","vectorcraft":"v%s","filmcraft":"v%s","effectcraft":"v%s"}\n' \
      "${PHOTOCRAFT_VERSION}" "${LIGHTCRAFT_VERSION}" "${PDFCRAFT_VERSION}" \
      "${VECTORCRAFT_VERSION}" "${FILMCRAFT_VERSION}" "${EFFECTCRAFT_VERSION}" \
      > /site/versions.json

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

# ---- Stage 2: nginx serving the six apps + portal ----
FROM nginx:1.27-alpine

# Port nginx listens on, and the internal address of craft-relay that the
# same-origin /relay/ proxy forwards to (Railway private networking).
ENV PORT=8080
ARG RELAY_UPSTREAM="http://craft-relay.railway.internal:8091"
ENV RELAY_UPSTREAM=${RELAY_UPSTREAM}

COPY nginx/templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=fetch /site /usr/share/nginx/html
COPY portal/index.html /usr/share/nginx/html/index.html

EXPOSE 8080
