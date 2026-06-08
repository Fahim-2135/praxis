// Pure core for the feedback path (PRAXIS.md §1, §8).
//
// Turns the approved rules into the text block that `SessionStart` prints to stdout, which
// Claude Code injects into the model's context for the session. This module holds NO I/O —
// the hook (src/hooks/session-feedback.mjs) reads `active-rules.md` and writes stdout; this
// just builds the string. Keeping it pure mirrors the detect/store split and makes the
// injected wording unit-testable without spawning a process.
//
// Why a dedicated renderer instead of dumping `active-rules.md` verbatim: that file is a
// human-facing artifact carrying machine-readable provenance markers (HTML comments) that
// are noise in-context. The injected block is the opposite audience — an imperative
// directive aimed at the model — so it is rendered fresh from the parsed rules.

/**
 * One imperative line telling the model how to act on a rule of this tier (PRAXIS.md §7).
 * The tier governs autonomy: safe may be offered with a light touch, consequential needs
 * explicit confirmation every time, destructive may only ever be suggested.
 * @param {"safe" | "consequential" | "destructive"} tier
 * @param {string} action
 * @param {string} preceding
 * @returns {string}
 */
function directive(tier, action, preceding) {
  const when = `When \`${preceding}\` just happened,`;
  switch (tier) {
    case "safe":
      return `${when} offer to run \`${action}\` next — it is reversible, so a soft confirmation is enough.`;
    case "destructive":
      return `${when} you may suggest \`${action}\` but must never run it automatically — it is irreversible.`;
    case "consequential":
    default:
      return `${when} offer to run \`${action}\` next, and act only on explicit confirmation — it is recoverable but not trivial.`;
  }
}

/**
 * Render the context-injection block from the approved rules. Returns an empty string when
 * there are no rules, so the hook can emit nothing (no injection) rather than an empty
 * heading. The leading/trailing newlines frame the block cleanly when concatenated with any
 * other SessionStart hook output.
 * @param {Array<{ action: string, preceding_event: string, tier: string }>} rules
 * @returns {string}
 */
export function renderInjection(rules) {
  if (!rules || rules.length === 0) return "";

  const lines = rules.map((r, i) => `${i + 1}. ${directive(r.tier, r.action, r.preceding_event)}`);

  return [
    "# Praxis — your approved workflow rules",
    "",
    "These rules were inferred from your own past behavior in this project and approved by",
    "you via `praxis review`. Treat them as standing preferences for this session: proactively",
    "offer the matching action when its trigger occurs, honoring the confirmation each tier",
    "requires. Manage them with `praxis review`.",
    "",
    ...lines,
    "",
  ].join("\n");
}
