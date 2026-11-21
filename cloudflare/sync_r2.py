#!/usr/bin/env python3
"""Upload a built site folder to the R2 bucket, sending only what changed.

Keeps a manifest of every file's SHA-256 in the bucket (_manifest.json); files
whose hash matches the last upload are skipped, files that are gone are
deleted. Uses `wrangler r2 object put/get/delete --remote`, so it needs
CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.

Usage: python3 cloudflare/sync_r2.py SITE_DIR [BUCKET] [--local]
  --local  write to Wrangler's local R2 simulation (for `wrangler dev` tests)
"""
import concurrent.futures as cf
import hashlib
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = "_manifest.json"
WRANGLER = os.environ.get("WRANGLER", "npx --yes wrangler@4").split()


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def wrangler(args, where, check=True):
    cmd = WRANGLER + ["r2", "object"] + args + [where]
    for attempt in range(5):
        r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
        if r.returncode == 0 or not check:
            return r
        print(f"  retry {attempt + 1}: {' '.join(args[:2])}: {r.stderr.strip()[-300:]}", flush=True)
    sys.exit(f"wrangler failed: {' '.join(cmd)}\n{r.stderr}")


def main():
    site = os.path.abspath(sys.argv[1])
    rest = sys.argv[2:]
    where = "--local" if "--local" in rest else "--remote"
    bucket = next((a for a in rest if not a.startswith("--")), "craft-suite-site")

    files = {}
    for dirpath, _, names in os.walk(site):
        for n in names:
            p = os.path.join(dirpath, n)
            files[os.path.relpath(p, site).replace(os.sep, "/")] = sha256(p)

    old = {}
    with tempfile.TemporaryDirectory() as tmp:
        m = os.path.join(tmp, "m.json")
        r = wrangler(["get", f"{bucket}/{MANIFEST}", "--file", m], where, check=False)
        if r.returncode == 0 and os.path.exists(m):
            try:
                old = json.load(open(m))
            except ValueError:
                old = {}

    upload = sorted(k for k, h in files.items() if old.get(k) != h)
    delete = sorted(k for k in old if k not in files)
    print(f"{len(files)} files: {len(upload)} to upload, {len(delete)} to delete, "
          f"{len(files) - len(upload)} unchanged", flush=True)

    def put(key):
        wrangler(["put", f"{bucket}/{key}", "--file", os.path.join(site, key)], where)
        return key

    def rm(key):
        wrangler(["delete", f"{bucket}/{key}"], where, check=False)
        return key

    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        for i, key in enumerate(pool.map(put, upload), 1):
            if i % 25 == 0 or i == len(upload):
                print(f"  uploaded {i}/{len(upload)}", flush=True)
        list(pool.map(rm, delete))

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(files, f)
    wrangler(["put", f"{bucket}/{MANIFEST}", "--file", f.name], where)
    os.unlink(f.name)
    print("sync done", flush=True)


if __name__ == "__main__":
    main()
