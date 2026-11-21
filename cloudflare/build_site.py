#!/usr/bin/env python3
"""Build the Craft Suite site into a folder, the same way the Dockerfile does.

Reads every `fetch <app> "${<APP>_VERSION}" ["${<APP>_URL}"]` line and the ARG
defaults from ../Dockerfile, so Railway and Cloudflare always serve the same
app versions. Then copies portal/ and bridge/, injects the bridge script tags
into each app's index.html, writes versions.json and adds a .gz copy of the
compressible files (the Worker serves those to browsers that accept gzip).

Usage: python3 cloudflare/build_site.py OUT_DIR
"""
import gzip
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GZ_EXT = (".wasm", ".js", ".mjs", ".html", ".htm", ".css", ".json", ".svg", ".txt", ".webmanifest")
BRIDGE_TAGS = ('<script src="/bridge/config.js"></script><script src="/bridge/adapters.js"></script>'
               '<script src="/bridge/loader.js" defer></script></body>')


def apps_from_dockerfile():
    text = open(os.path.join(ROOT, "Dockerfile"), encoding="utf-8").read()
    args = dict(re.findall(r'^ARG ([A-Z_]+)="?([^"\n]*)"?$', text, re.M))
    apps = []
    for app, ver_arg, url_arg in re.findall(r'^\s+fetch ([a-z-]+)\s+"\$\{(\w+)\}"(?: "\$\{(\w+)\}")?', text, re.M):
        apps.append((app, args[ver_arg], args.get(url_arg, "") if url_arg else ""))
    relay_url = args.get("RELAY_URL", "/relay")
    return apps, relay_url


def download(urls, dest):
    """Try each URL in turn, retrying for ~10 minutes (GitHub sometimes answers 504)."""
    for attempt in range(40):
        url = urls[attempt % len(urls)]
        try:
            with urllib.request.urlopen(url, timeout=600) as r, open(dest, "wb") as f:
                shutil.copyfileobj(r, f)
            return
        except Exception as e:  # noqa: BLE001
            print(f"  attempt {attempt + 1} failed for {url}: {e}", flush=True)
            time.sleep(15)
    sys.exit(f"could not download {urls[0]}")


def main():
    out = os.path.abspath(sys.argv[1])
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    apps, relay_url = apps_from_dockerfile()
    versions = {}
    with tempfile.TemporaryDirectory() as tmp:
        for app, ver, override in apps:
            upstream = f"https://github.com/storytold/{app}/releases/download/v{ver}/{app}-web-{ver}.zip"
            urls = [override or upstream]
            if override and f"/{app}-web-{ver}-v{ver}/" in override:
                urls.append(upstream)  # a mirror of an upstream release: either copy will do
            print(f"fetching {app} {ver}", flush=True)
            z = os.path.join(tmp, app + ".zip")
            download(urls, z)
            with zipfile.ZipFile(z) as zf:
                zf.extractall(os.path.join(tmp, app))
            shutil.move(os.path.join(tmp, app, f"{app}-web-{ver}"), os.path.join(out, app))
            versions[app] = "v" + ver
    with open(os.path.join(out, "versions.json"), "w") as f:
        f.write(json.dumps(versions, separators=(",", ":")) + "\n")

    shutil.copytree(os.path.join(ROOT, "bridge"), os.path.join(out, "bridge"))
    with open(os.path.join(out, "bridge", "config.js"), "w") as f:
        f.write(f'window.CRAFT_RELAY = {{ url: "{relay_url}" }};\n')
    for app, _, _ in apps:
        idx = os.path.join(out, app, "index.html")
        html = open(idx, encoding="utf-8").read()
        if "bridge/loader.js" not in html:
            open(idx, "w", encoding="utf-8").write(html.replace("</body>", BRIDGE_TAGS, 1))
    shutil.copytree(os.path.join(ROOT, "portal"), out, dirs_exist_ok=True)

    for dirpath, _, files in os.walk(out):
        for name in files:
            if name.endswith(GZ_EXT):
                p = os.path.join(dirpath, name)
                # mtime=0 keeps the .gz byte-identical across builds, so unchanged
                # files keep their hash and aren't uploaded again.
                with open(p, "rb") as src, open(p + ".gz", "wb") as raw, \
                        gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as dst:
                    shutil.copyfileobj(src, dst)
    print(f"built {len(apps)} apps into {out}")


if __name__ == "__main__":
    main()
