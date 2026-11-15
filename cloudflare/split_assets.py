#!/usr/bin/env python3
"""Copy the built site's small files into a Workers static-assets folder.

Requests for static assets are free and unlimited on Cloudflare and never run
the Worker, so they don't count toward the free plan's 100,000 Worker requests
a day. Static assets are capped at 25 MiB a file, so the ~10 big .wasm files
stay out of this folder: those requests fall through to the Worker, which
serves them from R2 (R2 still holds the whole site).

Also left out: the precompressed .gz copies (Cloudflare compresses static
assets itself) and files a visitor never needs (the apps' own _headers,
.htaccess, .trunk-lock). Writes a root _headers file with the headers the apps
need (COOP/COEP/CORP, nosniff) and a year's caching for the content-hashed
.wasm/.js files, the same rules worker.js applies.

Usage: python3 cloudflare/split_assets.py SITE_DIR ASSETS_DIR
"""
import os
import re
import shutil
import sys

MAX = 25 * 1024 * 1024
HIDDEN = re.compile(r"(^|/)(\.htaccess|_headers|_redirects|_manifest\.json|[^/]*\.trunk-lock)$")
# Keep these two in step with worker.js.
UNHASHED = re.compile(r"^(lightcraft|effectcraft|filmcraft)/")
HASHED = re.compile(r"^(photocraft|pdfcraft|vectorcraft|cadcraft|deckcraft|gridcraft|soundcraft|craft-anything"
                    r"|designcraft|figcraft|materialcraft|texturecraft|wordcraft)/.*\.(wasm|js)$")
BASE = ("/*\n"
        "  Cross-Origin-Opener-Policy: same-origin\n"
        "  Cross-Origin-Embedder-Policy: require-corp\n"
        "  Cross-Origin-Resource-Policy: same-origin\n"
        "  X-Content-Type-Options: nosniff\n")


def main():
    site, out = (os.path.abspath(a) for a in sys.argv[1:3])
    if os.path.exists(out):
        shutil.rmtree(out)
    kept, big, immutable = 0, [], []
    for dirpath, _, names in os.walk(site):
        for n in names:
            src = os.path.join(dirpath, n)
            key = os.path.relpath(src, site).replace(os.sep, "/")
            if key.endswith(".gz") or HIDDEN.search(key):
                continue
            if os.path.getsize(src) > MAX:
                big.append(key)
                continue
            dst = os.path.join(out, key)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            kept += 1
            if HASHED.match(key) and not UNHASHED.match(key):
                immutable.append(key)
    rules = [BASE] + [f"/{k}\n  Cache-Control: public, max-age=31536000, immutable\n" for k in sorted(immutable)]
    if len(rules) > 100:
        sys.exit(f"_headers would have {len(rules)} rules; Cloudflare allows 100")
    with open(os.path.join(out, "_headers"), "w") as f:
        f.write("\n".join(rules))
    print(f"{kept} files as static assets ({len(immutable)} cached for a year); "
          f"{len(big)} served by the Worker from R2: {', '.join(sorted(big))}")


if __name__ == "__main__":
    main()
