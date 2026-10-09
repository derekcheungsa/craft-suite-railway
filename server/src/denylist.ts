/** Destructive-command denylist. Enforced in the relay for every run_command
 *  and run_batch entry, and re-enforced by the bridge's read-only toggle.
 *  Command ids come from the apps' control-channel catalogs; extend via the
 *  DENYLIST env var (comma-separated, matched case-insensitively as substrings). */

const DEFAULT_PATTERNS = [
  // cross-app: quit / close / delete / wipe anything
  "app.quit", "quit",
  "project.close", "document.close", "close.project",
  "library.delete", "delete.library", "photo.delete", "photos.delete",
  "library.wipe", "library.clear", "catalog.delete",
  "file.delete", "delete.file",
  "history.clear", "undo.all",
  // lightcraft develop pipeline
  "library.remove", "reject.delete",
  // effectcraft / filmcraft project mutation beyond editing
  "composition.delete.all", "project.new", "project.revert",
];

export class Denylist {
  private patterns: string[];

  constructor(extraCsv = "") {
    this.patterns = [...DEFAULT_PATTERNS];
    for (const p of extraCsv.split(",")) {
      const t = p.trim().toLowerCase();
      if (t && !this.patterns.includes(t)) this.patterns.push(t);
    }
  }

  /** Returns a matching pattern, or null if the command is allowed. */
  check(command: string): string | null {
    const c = command.toLowerCase();
    // "bulk" / "all" + overwrite-flavored verbs are denied as a class
    if (/(bulk|all)\.(overwrite|replace|delete)/.test(c)) return c;
    return this.patterns.find((p) => c === p || c.includes(p)) ?? null;
  }
}
