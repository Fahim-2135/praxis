// Ensures the on-disk state scaffold exists. Run once at setup; safe to re-run.
//
// The hot path deliberately does NOT own the `last_processed` cursor — that file
// belongs to the cold detection path (Stage 2). This module just guarantees the
// directory and the cursor exist with a well-defined initial value.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { paths } from "./paths.mjs";

/**
 * Create `.praxis/` (and `sessions/`) and seed `last_processed` if absent.
 *
 * Cursor format: a single integer = the number of `log.jsonl` lines the cold path
 * has already analyzed. `0` means "nothing processed yet". Keeping this cursor in a
 * file separate from the log is what makes the dual SessionEnd/SessionStart
 * detection triggers idempotent — each event is analyzed exactly once (PRAXIS.md §3).
 *
 * @param {string} root  Project root.
 * @returns {ReturnType<typeof paths>}
 */
export function ensureScaffold(root) {
  const p = paths(root);
  mkdirSync(p.sessions, { recursive: true }); // also creates `.praxis/`
  if (!existsSync(p.lastProcessed)) writeFileSync(p.lastProcessed, "0\n");
  return p;
}
