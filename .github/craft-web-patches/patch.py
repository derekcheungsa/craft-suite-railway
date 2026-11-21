#!/usr/bin/env python3
"""Give an upstream Craft web app the in-page agent API (window.<app>).

Usage: patch.py <app> <upstream checkout>

Upstream WordCraft, GridCraft, FigCraft, DeckCraft and CADCraft install window.<app> over
craft-web-api; these apps have the same JSON control channel (the one their desktop control
server drives) but don't install it in the web build yet. This adds WordCraft's api.rs to the web
app and hands its queue to the app at startup. Every edit checks its anchor and fails loudly if
upstream has changed, rather than guessing.
"""
import pathlib
import sys

# craft-libs revision with crates/web-api (the one WordCraft and GridCraft pin).
WEB_API = 'craft-web-api = { git = "https://github.com/storytold/craft-libs", rev = "fd5e2feff6ea25bed371a99cc732b3968d621505", version = "0.1.0" }'

# app -> (ui crate, the line that builds the app, what to put in its place)
WIRING = {
    "designcraft": (
        "designcraft_ui_egui",
        "let mut app = DesignApp::new(Session::new(), services(inbox.clone(), cc.egui_ctx.clone()));",
        "let mut app = DesignApp::new(Session::new(), services(inbox.clone(), cc.egui_ctx.clone()))\n"
        "                        .with_control(crate::api::install(cc.egui_ctx.clone()));",
    ),
    "soundcraft": (
        "soundcraft_ui_egui",
        "let app = SoundApp::new(engine, Some(player), Services::default());",
        "let app = SoundApp::new(engine, Some(player), Services::default())\n"
        "                        .with_control(crate::api::install(cc.egui_ctx.clone()));",
    ),
    "materialcraft": (
        "materialcraft_ui_egui",
        "let mut app = MaterialCraftApp::new(cc, session);",
        "let mut app = MaterialCraftApp::new(cc, session);\n"
        "                app.control = Some(crate::api::install(cc.egui_ctx.clone()));",
    ),
    "texturecraft": (
        "texturecraft_ui_egui",
        "let mut app = TextureCraftApp::new(cc, session);",
        "let mut app = TextureCraftApp::new(cc, session);\n"
        "                app.control = Some(crate::api::install(cc.egui_ctx.clone()));",
    ),
}


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        sys.exit(f"patch: {path}: expected the anchor once, found it {count} times:\n  {old}")
    path.write_text(text.replace(old, new, 1))


def main():
    app, root = sys.argv[1], pathlib.Path(sys.argv[2])
    if app not in WIRING:
        sys.exit(f"patch: no patch for {app}")
    crate, old, new = WIRING[app]
    web = root / "apps" / f"{app}-web"
    src = web / "src"

    if "craft_web_api" in (src / "web.rs").read_text() or (src / "api.rs").exists():
        sys.exit(f"patch: {app} already has an api module upstream; build it unpatched")

    template = (pathlib.Path(__file__).parent / "api.rs.in").read_text()
    (src / "api.rs").write_text(template.replace("@APP@", app).replace("@CRATE@", crate))

    replace_once(src / "main.rs", "#[cfg(target_arch = \"wasm32\")]\nmod web;",
                 "#[cfg(target_arch = \"wasm32\")]\nmod web;\n\n#[cfg(target_arch = \"wasm32\")]\nmod api;")
    replace_once(src / "web.rs", old, new)

    cargo = web / "Cargo.toml"
    section = "[target.'cfg(target_arch = \"wasm32\")'.dependencies]"
    text = cargo.read_text()
    adds = [WEB_API]
    # api.rs names egui::Context and serde_json directly.
    for dep in ("egui", "serde_json"):
        if not any(line.startswith(f"{dep} ") or line.startswith(f"{dep}=") for line in text.splitlines()):
            adds.append(f"{dep} = {{ workspace = true }}")
    replace_once(cargo, section, section + "\n" + "\n".join(adds))
    print(f"patch: {app}: added src/api.rs, wired window.{app}, deps: {', '.join(a.split(' ')[0] for a in adds)}")


if __name__ == "__main__":
    main()
