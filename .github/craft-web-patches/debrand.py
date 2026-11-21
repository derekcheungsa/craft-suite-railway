#!/usr/bin/env python3
"""Remove the ArtCraft name and mark from an upstream Craft web app's interface.

Usage: debrand.py <app> <upstream checkout>

Why: the ArtCraft brand licence (docs/brand/LICENSE-brand.txt in each repo) lets modified builds
say, in plain text, "based on <app> by the ArtCraft team", but not carry the name or marks as
branding. The builds Craft Suite modifies (DesignCraft, SoundCraft, MaterialCraft, TextureCraft,
PhotoCraft) therefore get this script, run after the agent-API patch and before the build.

What it does, per app:
  * relabels the Discord / website / app-page items generically ("Join the community Discord",
    "Project Website", "Website"); the links still open the same places;
  * replaces the app's About blurb with the one credit line "Based on <App> by the ArtCraft team"
    (PhotoCraft's About had no such blurb, so the line is added);
  * DesignCraft only: removes the ArtCraft mark from the About window and the start screen;
  * drops the translation-catalog entries that carry the name (those few strings fall back to the
    English generic wording);
  * renames PhotoCraft's internal help.artcraftWebsite command to help.projectWebsite.
It leaves LICENSE*/NOTICE files and docs/ alone, and keeps link targets (discord.gg/artcraft,
getartcraft.com) as they are: those are addresses, not branding.

Every edit checks its anchor and fails loudly if upstream has changed, rather than guessing. At
the end the source tree is scanned; any "artcraft" left outside the credit line, link targets,
comments and licence files fails the job.
"""
import pathlib
import re
import sys

APPS = ("designcraft", "soundcraft", "materialcraft", "texturecraft", "photocraft")

# Literal string swaps, applied (longest first) wherever they occur in the app's code. A swap may
# match zero times in an app that doesn't have that string; the final scan catches what is missed.
GENERIC = [
    ("Join the ArtCraft community on Discord", "Join the community on Discord"),
    ("Join the ArtCraft community", "Join the community"),
    ("Join the ArtCraft Discord…", "Join the community Discord…"),
    ("Join the ArtCraft Discord", "Join the community Discord"),
    ("More ArtCraft apps", "More apps"),
    ("ArtCraft App Page…", "App Page…"),
    ("ArtCraft App Page", "App Page"),
    ("ArtCraft Website…", "Project Website…"),
    ("ArtCraft Website", "Project Website"),
    ("ArtCraft website...", "Project website..."),
    ("(ArtCraft Discord, website, DesignCraft page and repository)", "(Discord, website, DesignCraft page and repository)"),
    ('tl!("ArtCraft")', 'tl!("Website")'),
    ("discord.gg/artcraft — help, feedback and show-and-tell", "Help, feedback and show-and-tell"),
    ("help.artcraftWebsite", "help.projectWebsite"),
    ("ARTCRAFT_WEBSITE", "PROJECT_WEBSITE"),
]

# Regex swaps for link labels that are addresses ("getartcraft.com/apps/soundcraft").
GENERIC_RE = [
    (re.compile(r'hyperlink_to\("getartcraft\.com[^"]*",'), 'hyperlink_to("Website",'),
    (re.compile(r'hyperlink_to\("discord\.gg/artcraft",'), 'hyperlink_to("Discord",'),
    (re.compile(r'\("getartcraft\.com", "'), '("Website", "'),
]

# app -> (old About blurb, name used in the credit line). The credit is the ONE place the name stays.
CREDIT = {
    "designcraft": "Part of the ArtCraft suite of open creative tools.",
    "soundcraft": "An open-source digital audio workstation from the ArtCraft team.",
    "materialcraft": "An open-source Crafting App by the ArtCraft team and community.",
    "texturecraft": "Made by the ArtCraft team and community.",
}
APP_NAME = {
    "designcraft": "DesignCraft",
    "soundcraft": "SoundCraft",
    "materialcraft": "MaterialCraft",
    "texturecraft": "TextureCraft",
    "photocraft": "PhotoCraft",
}

# Skipped by the edits and the final scan: licences, notices, docs, packaging, icons' licence.
SKIP_NAME = re.compile(r"^(LICENSE|NOTICE)", re.I)
SKIP_DIRS = {"docs", "packaging", ".git", ".github", "target", "node_modules", "assets"}
CODE_SUFFIXES = {".rs", ".tsv", ".toml", ".json", ".html", ".js", ".css", ".ftl", ".txt", ".yml", ".yaml"}

ALLOWED = [
    re.compile(r"discord\.gg/artcraft"),
    re.compile(r"getartcraft\.com"),
    re.compile(r"Based on \w+ by the ArtCraft team"),
]


def files(root):
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix not in CODE_SUFFIXES or SKIP_NAME.match(p.name):
            continue
        rel = p.relative_to(root)
        if rel.parts and rel.parts[0] in SKIP_DIRS:
            continue
        if any(part in SKIP_DIRS - {"assets"} for part in rel.parts):
            continue
        yield p


def read(p):
    return p.read_text(encoding="utf-8")


def replace_once(path, old, new):
    text = read(path)
    n = text.count(old)
    if n != 1:
        sys.exit(f"debrand: {path}: expected the anchor once, found it {n} times:\n  {old[:160]}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_between(path, start, end, new):
    """Replace text from `start` up to (not including) `end`."""
    text = read(path)
    if text.count(start) != 1 or text.count(end) != 1:
        sys.exit(f"debrand: {path}: markers not unique: {start[:60]!r} / {end[:60]!r}")
    i, j = text.index(start), text.index(end)
    if i >= j:
        sys.exit(f"debrand: {path}: markers out of order")
    path.write_text(text[:i] + new + text[j:], encoding="utf-8")


# ---- translation catalogs ----------------------------------------------------------------------

def depth_change(line):
    """Net ( [ { depth change of a line, ignoring string literals and // comments."""
    d, i, n = 0, 0, len(line)
    while i < n:
        c = line[i]
        if c == '"':
            i += 1
            while i < n and line[i] != '"':
                i += 2 if line[i] == "\\" else 1
        elif c == "/" and line[i : i + 2] == "//":
            break
        elif c in "([{":
            d += 1
        elif c in ")]}":
            d -= 1
        i += 1
    return d


def drop_rust_entries(path):
    """Drop `( ... ),` tuple entries (one or several lines) that mention artcraft. Returns count."""
    lines = read(path).split("\n")
    out, dropped, i = [], 0, 0
    while i < len(lines):
        line = lines[i]
        if line.lstrip().startswith("(") and (line.rstrip().endswith(",") or line.strip() == "("):
            j, depth = i, 0
            while True:
                depth += depth_change(lines[j])
                if depth <= 0 or j + 1 >= len(lines):
                    break
                j += 1
            if depth != 0:
                sys.exit(f"debrand: {path}:{i + 1}: unbalanced catalog entry")
            block = lines[i : j + 1]
            if any("artcraft" in b.lower() for b in block):
                dropped += 1
            else:
                out.extend(block)
            i = j + 1
            continue
        out.append(line)
        i += 1
    path.write_text("\n".join(out), encoding="utf-8")
    return dropped


def drop_tsv_entries(path):
    lines = read(path).split("\n")
    out, dropped = [], 0
    for line in lines:
        if line.startswith("#"):
            out.append(re.sub(r"\bArtCraft,\s*", "", line))  # a comment; the loader ignores it
        elif "artcraft" in line.lower():
            dropped += 1
        else:
            out.append(line)
    path.write_text("\n".join(out), encoding="utf-8")
    return dropped


# ---- per-app edits -----------------------------------------------------------------------------

def designcraft(root):
    ui = root / "crates/ui-egui/src"
    about, start = ui / "about.rs", ui / "chrome/start_screen.rs"
    # The mark: delete the constants and the painter, then the two places that drew it.
    replace_between(about, "/// ArtCraft brand blue", "/// Discord's brand colour", "")
    replace_between(about, "/// The ArtCraft mark outline", "/// The other ArtCraft apps", "")
    replace_between(about, "/// Paint the ArtCraft mark", "/// A speech-bubble glyph", "")
    replace_once(
        about,
        "            let (r, _) = ui.allocate_exact_size(vec2(72.0, 72.0), Sense::hover());\n"
        "            paint_mark(ui, r, BRAND);\n"
        "            ui.add_space(6.0);\n",
        "            ui.add_space(14.0);\n",
    )
    replace_once(
        start,
        "            let (r, _) = ui.allocate_exact_size(vec2(44.0, 44.0), Sense::hover());\n"
        "            crate::about::paint_mark(ui, r, crate::about::BRAND);\n"
        "            ui.add_space(8.0);\n",
        "",
    )


def photocraft(root):
    ui = root / "crates/ui-egui/src"
    # PhotoCraft's About has no blurb to reword, so add the credit line under the version.
    replace_once(
        ui / "dialogs.rs",
        '            ui.label(crate::i18n::fmt(tl!("Version {version}"), &[("version", &photocraft_engine::build_info::long_version())]));\n'
        "            ui.add_space(12.0);\n",
        '            ui.label(crate::i18n::fmt(tl!("Version {version}"), &[("version", &photocraft_engine::build_info::long_version())]));\n'
        '            ui.label("Based on PhotoCraft by the ArtCraft team");\n'
        "            ui.add_space(12.0);\n",
    )


PER_APP = {"designcraft": designcraft, "photocraft": photocraft}


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in APPS:
        sys.exit(f"usage: debrand.py <{'|'.join(APPS)}> <upstream checkout>")
    app, root = sys.argv[1], pathlib.Path(sys.argv[2])

    if app in PER_APP:
        PER_APP[app](root)

    # The About credit line replaces the app's old blurb (the blurb is the only text that changes).
    if app in CREDIT:
        old = CREDIT[app]
        hits = [p for p in files(root) if p.suffix == ".rs" and f'"{old}"' in read(p) and "i18n" not in p.parts]
        if len(hits) != 1:
            sys.exit(f"debrand: expected the About blurb in exactly one file, found {len(hits)}: {old}")
        replace_once(hits[0], f'"{old}"', f'"Based on {APP_NAME[app]} by the ArtCraft team"')

    swaps = sorted(GENERIC, key=lambda s: -len(s[0]))
    changed = 0
    for p in files(root):
        if p.suffix not in (".rs", ".tsv") or "i18n" in p.parts:
            continue
        text = read(p)
        new = text
        for old, rep in swaps:
            new = new.replace(old, rep)
        for rx, rep in GENERIC_RE:
            new = rx.sub(rep, new)
        if new != text:
            p.write_text(new, encoding="utf-8")
            changed += 1

    dropped = 0
    for p in files(root):
        if "i18n" not in p.parts:
            continue
        if p.suffix == ".rs":
            dropped += drop_rust_entries(p)
        elif p.suffix == ".tsv":
            dropped += drop_tsv_entries(p)

    # Final scan: nothing but the credit line, link targets, comments and licence files may remain.
    left = []
    for p in files(root):
        for n, line in enumerate(read(p).split("\n"), 1):
            s = line.strip()
            if s.startswith(("//", "#", "*", "/*", "<!--")):
                continue
            for rx in ALLOWED:
                line = rx.sub("", line)
            if "artcraft" in line.lower():
                left.append(f"{p.relative_to(root)}:{n}: {s[:150]}")
    if left:
        sys.exit("debrand: the name is still there:\n  " + "\n  ".join(left))
    print(f"debrand: {app}: edited {changed} code files, dropped {dropped} catalog entries; source is clean")


if __name__ == "__main__":
    main()
