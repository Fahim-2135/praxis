// Single source of truth for where Praxis keeps its state. Every other module
// resolves paths through here so the on-disk layout is defined in exactly one place.
//
// All state lives under `.praxis/` in the project root (PRAXIS.md §3).

import { join } from "node:path";

/**
 * Resolve the project root for a hook invocation. Prefer the explicit
 * `$CLAUDE_PROJECT_DIR` Claude Code sets for hooks; fall back to the event's `cwd`,
 * then to the process cwd. The layered fallback keeps the hook working even if the
 * environment variable is absent on a given platform.
 * @param {{ cwd?: string }} [event]
 * @returns {string}
 */
export function resolveProjectDir(event) {
  return process.env.CLAUDE_PROJECT_DIR || event?.cwd || process.cwd();
}

/**
 * Turn an arbitrary session id into a filesystem-safe filename component.
 * @param {unknown} id
 * @returns {string}
 */
export function sanitize(id) {
  return String(id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Build the set of state-file paths for a given project root.
 * @param {string} root
 */
export function paths(root) {
  const base = join(root, ".praxis");
  return {
    /** `.praxis/` — the state directory. */
    base,
    /** `log.jsonl` — append-only raw event stream. */
    log: join(base, "log.jsonl"),
    /** `last_processed` — detection read cursor (count of analyzed records). */
    lastProcessed: join(base, "last_processed"),
    /** `candidates.json` — patterns that cleared all gates, awaiting approval. */
    candidates: join(base, "candidates.json"),
    /** `active-rules.md` — approved rules only; the single file injected into context. */
    activeRules: join(base, "active-rules.md"),
    /** `rejected.json` — declined patterns (rejection memory; written from Stage 3). */
    rejected: join(base, "rejected.json"),
    /** `sessions/` — per-session "preceding event" markers. */
    sessions: join(base, "sessions"),
    /** `errors.log` — best-effort hot-path failure notes. */
    errors: join(base, "errors.log"),
    /**
     * Per-session marker file holding the session's most recent action, used to
     * reconstruct `preceding_event` for the next event in that session.
     * @param {unknown} sessionId
     */
    marker: (sessionId) => join(base, "sessions", `${sanitize(sessionId)}.last`),
  };
}
