// Plumbing shared by every Praxis hook process: read the event from stdin, clean it,
// and note failures without ever throwing. Both the hot-path hook (post-tool-use) and
// the cold-path hook (session-detect) are held to the same rule — a hook must never
// disturb Claude Code — so they share the same defensive I/O.

import { mkdirSync, appendFileSync } from "node:fs";
import { paths } from "../state/paths.mjs";

/**
 * Read all of stdin to a string. Claude Code delivers the hook event as JSON on stdin.
 * @returns {Promise<string>}
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Strip a leading UTF-8 BOM (some shells prepend one when piping to a process's stdin)
 * and trim surrounding whitespace.
 * @param {string} text
 * @returns {string}
 */
export function clean(text) {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.trim();
}

/**
 * Best-effort failure note to `.praxis/errors.log`. Never throws: if even error
 * logging fails, stay silent so the caller can still exit 0.
 * @param {unknown} err
 */
export function noteError(err) {
  try {
    const p = paths(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    mkdirSync(p.base, { recursive: true });
    appendFileSync(p.errors, `${new Date().toISOString()} ${err?.stack ?? err}\n`);
  } catch {
    /* swallow — a logging failure must never propagate out of a hook */
  }
}
