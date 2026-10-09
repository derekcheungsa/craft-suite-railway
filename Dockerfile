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

RUN apk add --no-cache curl unzip gzip
WORKDIR /site

RUN set -eux; \
    fetch() { \
      repo="$1"; ver="$2"; \
      url="https://github.com/storytold/${repo}/releases/download/v${ver}/${repo}-web-${ver}.zip"; \
      echo "fetching ${url}"; \
      curl -fsSL --retry 3 -o /tmp/app.zip "${url}"; \
      unzip -q /tmp/app.zip -d /tmp/app; \
      mv "/tmp/app/${repo}-web-${ver}" "/site/${repo}"; \
      rm -rf /tmp/app /tmp/app.zip; \
    }; \
    fetch photocraft  "${PHOTOCRAFT_VERSION}"; \
    fetch lightcraft  "${LIGHTCRAFT_VERSION}"; \
    fetch pdfcraft    "${PDFCRAFT_VERSION}"; \
    fetch vectorcraft "${VECTORCRAFT_VERSION}"; \
    fetch filmcraft   "${FILMCRAFT_VERSION}"; \
    fetch effectcraft "${EFFECTCRAFT_VERSION}"; \
    printf '{"photocraft":"v%s","lightcraft":"v%s","pdfcraft":"v%s","vectorcraft":"v%s","filmcraft":"v%s","effectcraft":"v%s"}\n' \
      "${PHOTOCRAFT_VERSION}" "${LIGHTCRAFT_VERSION}" "${PDFCRAFT_VERSION}" \
      "${VECTORCRAFT_VERSION}" "${FILMCRAFT_VERSION}" "${EFFECTCRAFT_VERSION}" \
      > /site/versions.json

# Precompress the heavy payloads once at build time; nginx serves the .gz
# copies via gzip_static instead of compressing on every request.
RUN find /site -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.html' \) \
      -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \;

# ---- Stage 2: nginx serving the six apps + portal ----
FROM nginx:1.27-alpine

ENV PORT=8080

COPY nginx/templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=fetch /site /usr/share/nginx/html
COPY portal/index.html /usr/share/nginx/html/index.html

EXPOSE 8080
