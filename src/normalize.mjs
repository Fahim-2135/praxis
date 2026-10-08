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
 * Shell command rules, shared by the Bash and PowerShell tools. First match wins within a
 * segment, so order matters. Patterns anchor on the leading verb (so argument noise collapses)
 * except test/build/lint/format, which may appear behind a runner prefix and so match anywhere.
 *
 * A rule marked `filter` names a command that usually sits in a pipeline to trim another
 * command's output (`git log | head -20`). It labels a segment only when nothing earlier in the
 * chain was recognized, so it never overrides the command whose output it is filtering.
 * @type {ReadonlyArray<{ pattern: RegExp, action: string, filter?: true }>}
 */
const BASH_RULES = [
  { pattern: /^git\s+push\b/, action: "git_push" },
  { pattern: /^git\s+commit\b/, action: "git_commit" },
  { pattern: /^git\s+pull\b/, action: "git_pull" },
  { pattern: /^git\s+add\b/, action: "git_add" },
  { pattern: /^git\s+status\b/, action: "git_status" },
  { pattern: /^git\s+(checkout|switch)\b/, action: "git_checkout" },
  { pattern: /^git\s+diff\b/, action: "git_diff" },
  { pattern: /^git\s+log\b/, action: "git_log" },
  {
    pattern:
      /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:jest|vitest|pytest|mocha)\b|\b(?:go|cargo)\s+test\b|\bnode\s+--test\b/,
    action: "test_run",
  },
  {
    pattern:
      /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|^(?:make|cmake|gcc|g\+\+|clang|cargo\s+build)\b/,
    action: "build_run",
  },
  {
    pattern:
      /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?lint\b|\b(?:eslint|tsc|golangci-lint)\b|\bruff\s+check\b/,
    action: "lint_run",
  },
  {
    pattern:
      /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?format\b|\b(?:prettier|black|gofmt)\b|\bruff\s+format\b/,
    action: "format_run",
  },
  {
    pattern: /^(?:npm|pnpm|yarn)\s+(?:install|i|add|ci)\b|^pip3?\s+install\b/,
    action: "install_run",
  },
  { pattern: /^(?:ls|dir|Get-ChildItem|gci|tree)\b/i, action: "list_dir" },
  { pattern: /^(?:curl|wget|Invoke-WebRequest|iwr)\b/i, action: "web_fetch" },
  { pattern: /^(?:node|python3?|py|deno|bun|tsx|ts-node)\b/, action: "script_run" },
  { pattern: /^(?:mkdir|cp|mv|touch|New-Item|Copy-Item|Move-Item)\b/i, action: "file_manage" },
  { pattern: /^(?:cat|Get-Content|gc|type)\b/i, action: "file_read" },
  { pattern: /^(?:head|tail|less|more|sed|awk|wc)\b/, action: "file_read", filter: true },
  { pattern: /^(?:grep|rg|ag|find|fd|Select-String)\b/i, action: "file_search", filter: true },
];

/**
 * Segments that set up a command rather than being one (`cd src && …`, `echo ---`). They are
 * never an action, and they are skipped when naming an unrecognized command by its verb.
 */
const SETUP_SEGMENT =
  /^(?:cd|pushd|popd|echo|Write-Output|Write-Host|export|set|pwd|true|sleep)\b|^\w+=\S*$/i;

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
  Agent: "subagent_run",
  TodoWrite: "todo_update",
  TaskCreate: "todo_update",
  TaskUpdate: "todo_update",
  AskUserQuestion: "ask_user",
  Skill: "skill_run",
});

/** Tools that run a shell command; their `command` input is classified like Bash's. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * Shell segment separators: `&&`, `||`, `;`, `|`, and newlines. Splitting on these
 * lets us classify each link of a chained command independently, so a leading verb
 * anchor (`^git …`) still matches when the command is chained or prefixed.
 */
const SEGMENT_SEPARATORS = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;

/**
 * Leading noise that precedes the real verb: an environment assignment (`CI=1`),
 * or a wrapper command (`sudo`, `env`, `time`, `nice`, `command`, `exec`). Stripping
 * these lets a leading-anchored rule (`^git …`) still match `sudo git push` or
 * `CI=1 git push`. Applied repeatedly to peel a stack of prefixes.
 */
const LEADING_NOISE = /^(?:\w+=\S*|sudo|env|time|nice|command|exec)\s+/;

/**
 * Strip leading environment assignments and wrapper commands from a segment.
 * @param {string} segment
 * @returns {string}
 */
function stripLeadingNoise(segment) {
  let current = segment;
  let previous;
  do {
    previous = current;
    current = current.replace(LEADING_NOISE, "");
  } while (current !== previous);
  return current;
}

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
  const segments = command
    .split(SEGMENT_SEPARATORS)
    .map((s) => s.trim())
    .filter(Boolean);

  let action = null;
  for (const rawSegment of segments) {
    const segment = stripLeadingNoise(rawSegment);
    for (const rule of BASH_RULES) {
      if (rule.pattern.test(segment)) {
        // Keep scanning; a later segment may override (terminal intent) unless it is a filter.
        if (!(rule.filter && action)) action = rule.action;
        break;
      }
    }
  }

  if (action) return { action };
  return { action: "unmatched", raw: command || "(empty command)" };
}

/**
 * The verb of a shell command: the first word of its last segment that is not setup (`cd`,
 * `echo`, a bare variable assignment), without any leading path. Used to name an unrecognized
 * command without keeping its arguments, which is where paths, tokens and URLs live.
 * @param {unknown} command
 * @returns {string}
 */
export function commandVerb(command) {
  const segments = String(command ?? "")
    .split(SEGMENT_SEPARATORS)
    .map((s) => stripLeadingNoise(s.trim()))
    .filter((s) => s && !SETUP_SEGMENT.test(s));
  const last = segments[segments.length - 1];
  if (!last) return "(setup only)";
  const word = last.split(/\s+/)[0].replace(/^["']|["']$/g, "");
  const parts = word.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || "(empty command)";
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

  if (SHELL_TOOLS.has(toolName)) {
    return classifyBash(String(event?.tool_input?.command ?? "").trim());
  }

  const mapped = TOOL_RULES[toolName];
  if (mapped) return { action: mapped };

  // Connector tools are named `mcp__<server>__<tool>`. One label covers them all, and the
  // server name is kept as the raw signal so the profile can say which services you use.
  if (toolName.startsWith("mcp__")) return { action: "mcp_call", raw: toolName.split("__")[1] };

  return { action: "unmatched", raw: toolName || "(unknown tool)" };
}
