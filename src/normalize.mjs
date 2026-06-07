// Deterministic normalization: a raw tool invocation -> one stable `action` label.
//
// Why deterministic (and never an LLM) here: this runs in the hot path on every
// single tool call, so it must be free, instant, and — above all — CONSISTENT.
// A non-deterministic classifier would map the same command to different labels on
// different runs, fragmenting the counts the detection engine depends on. Collapsing
// argument noise (`git push`, `git push origin main --force-with-lease`) into one
// countable `action` is the entire point (PRAXIS.md §5).
//
// Coverage is intentionally NOT exhaustive. We label the handful of actions a
// developer actually repeats; anything else is logged as `unmatched` with its raw
// signal preserved, so the unmatched pile reveals which rules to add next.

/**
 * Bash command rules. First match wins, so order matters. Patterns anchor on the
 * leading verb (so argument noise collapses) except test/build/lint/format, which
 * may appear behind a runner prefix and so match anywhere in the command.
 * @type {ReadonlyArray<[RegExp, string]>}
 */
const BASH_RULES = [
  [/^git\s+push\b/, "git_push"],
  [/^git\s+commit\b/, "git_commit"],
  [/^git\s+pull\b/, "git_pull"],
  [/^git\s+add\b/, "git_add"],
  [/^git\s+status\b/, "git_status"],
  [/^git\s+(checkout|switch)\b/, "git_checkout"],
  [/^git\s+diff\b/, "git_diff"],
  [/^git\s+log\b/, "git_log"],
  [/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:jest|vitest|pytest|mocha)\b|\b(?:go|cargo)\s+test\b/, "test_run"],
  [/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b/, "build_run"],
  [/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?lint\b|\b(?:eslint|tsc|golangci-lint)\b|\bruff\s+check\b/, "lint_run"],
  [/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?format\b|\b(?:prettier|black|gofmt)\b|\bruff\s+format\b/, "format_run"],
  [/^(?:ls|dir)\b/, "list_dir"],
];

/**
 * Non-Bash tool names mapped to a stable action. The model's file and search tools
 * are part of the observed workflow stream, so they get first-class labels.
 * @type {Readonly<Record<string, string>>}
 */
const TOOL_RULES = Object.freeze({
  Read: "file_read",
  Edit: "file_edit",
  Write: "file_edit",
  MultiEdit: "file_edit",
  NotebookEdit: "file_edit",
  Glob: "file_search",
  Grep: "file_search",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  Task: "subagent_run",
  TodoWrite: "todo_update",
});

/**
 * Shell segment separators: `&&`, `||`, `;`, `|`, and newlines. Splitting on these
 * lets us classify each link of a chained command independently, so a leading verb
 * anchor (`^git …`) still matches when the command is chained or prefixed.
 */
const SEGMENT_SEPARATORS = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;

/**
 * Classify a Bash command. The command is split into shell segments; each segment
 * is matched against the rule table, and the LAST segment that matches wins — the
 * chain's terminal intent (`git add … && git commit … && git push` -> `git_push`).
 * Unrecognized commands keep their raw text for later rule discovery (PRAXIS.md §5).
 *
 * Capturing intermediate segments (not just the terminal one) is a calibration
 * decision deliberately deferred until there is real logged behavior to tune against.
 *
 * @param {string} command
 * @returns {Normalized}
 */
function classifyBash(command) {
  const segments = command.split(SEGMENT_SEPARATORS).map((s) => s.trim()).filter(Boolean);

  let action = null;
  for (const segment of segments) {
    for (const [pattern, label] of BASH_RULES) {
      if (pattern.test(segment)) {
        action = label; // keep scanning; a later segment may override (terminal intent)
        break;
      }
    }
  }

  if (action) return { action };
  return { action: "unmatched", raw: command || "(empty command)" };
}

/**
 * @typedef {object} Normalized
 * @property {string} action   The stable, countable intent label.
 * @property {string} [raw]    Present only when `action === "unmatched"`: the raw
 *                             signal (command text or tool name) kept for discovery.
 */

/**
 * Normalize a hook event into a stable action label.
 * @param {{ tool_name?: string, tool_input?: { command?: string } }} event
 * @returns {Normalized}
 */
export function normalize(event) {
  const toolName = event?.tool_name ?? "";

  if (toolName === "Bash") {
    return classifyBash(String(event?.tool_input?.command ?? "").trim());
  }

  const mapped = TOOL_RULES[toolName];
  if (mapped) return { action: mapped };

  return { action: "unmatched", raw: toolName || "(unknown tool)" };
}
