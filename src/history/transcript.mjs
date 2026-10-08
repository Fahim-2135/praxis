// Pure reader for Claude Code's own session transcripts (`~/.claude/projects/<project>/<session>.jsonl`).
//
// Praxis 1 had to log every tool call itself before it could learn anything, so a new install
// started empty and needed days of sessions to clear the gates. Claude Code already keeps a
// full transcript of every session on disk. Reading those is what lets Praxis 2 show a profile
// the moment it is installed: the history is already there.
//
// This module holds NO I/O. It takes one transcript line and returns the facts Praxis uses, so
// the Node scanner (bin/praxis-history.mjs) and the mod's own fallback scanner share one parser.
//
// Privacy: only what the profile needs leaves this module. Bash commands are reduced to their
// normalized action (and, when unrecognized, to the first word of the command), and file paths
// to their base name, so a command's arguments — where tokens and URLs live — are never kept.

import { normalize, commandVerb } from "../normalize.mjs";

/**
 * @typedef {object} ToolEvent
 * @property {"tool"} kind
 * @property {string} sessionId
 * @property {string} timestamp   ISO 8601, as Claude Code wrote it.
 * @property {string} project     Base name of the session's working directory.
 * @property {string} action      Normalized action label (src/normalize.mjs).
 * @property {string} [raw]       For `unmatched` only: the tool name, or the Bash verb.
 * @property {string} [file]      Base name of the file a Read/Edit/Write touched.
 * @property {string} [model]     The model that made the call.
 */

/**
 * @typedef {object} PromptEvent
 * @property {"prompt"} kind
 * @property {string} sessionId
 * @property {string} timestamp
 * @property {boolean} interrupted   True for Claude Code's "[Request interrupted by user]" marker.
 */

/** Tools whose `command` input is a shell command. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Tools whose `file_path` input names the file the call touched. */
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Text Claude Code writes into a user turn when the person stops Claude mid-answer. */
const INTERRUPT_MARKER = "[Request interrupted by user";

/**
 * User-role text that Claude Code writes on the person's behalf (slash-command echoes, hook and
 * system reminders, local command output). None of it is something the person typed.
 */
const SYNTHETIC_PROMPT =
  /^\s*<(?:command-|local-command|system-reminder|bash-|task-notification)|^Caveat: /;

/**
 * Last segment of a path, for either separator. Used for project and file names.
 * @param {unknown} path
 * @returns {string}
 */
export function baseName(path) {
  const parts = String(path ?? "")
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Text of a user message, whether Claude Code stored it as a string or as content blocks.
 * @param {unknown} content
 * @returns {string}
 */
function userText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Turn one tool_use block into a ToolEvent.
 * @param {{ name?: string, input?: Record<string, unknown> }} block
 * @param {{ sessionId: string, timestamp: string, project: string, model?: string }} where
 * @returns {ToolEvent}
 */
function toolEvent(block, where) {
  const tool = String(block.name ?? "");
  const input = block.input ?? {};
  const norm = normalize({ tool_name: tool, tool_input: { command: input.command } });

  /** @type {ToolEvent} */
  const event = { kind: "tool", ...where, action: norm.action };
  // normalize() keeps a whole unrecognized command as its raw signal; history keeps only its verb.
  if (norm.raw !== undefined) {
    event.raw = SHELL_TOOLS.has(tool) ? commandVerb(input.command) : norm.raw;
  }
  if (FILE_TOOLS.has(tool) && input.file_path) event.file = baseName(input.file_path);
  return event;
}

/**
 * Parse one transcript line into the events it holds: the tool calls of an assistant message,
 * or one prompt the person typed. Malformed lines, subagent (sidechain) lines, and line types
 * Praxis does not use all return an empty list, so one odd line never stops a scan.
 * @param {string} line
 * @returns {Array<ToolEvent | PromptEvent>}
 */
export function parseTranscriptLine(line) {
  // Cheap substring checks first: most lines are tool results and other records Praxis skips,
  // and JSON-parsing every one of them dominates a scan of a large history.
  const maybeTool = line.includes('"tool_use"');
  const maybePrompt = line.includes('"type":"user"');
  if (!maybeTool && !maybePrompt) return [];

  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  if (!entry || entry.isSidechain || !entry.sessionId || !entry.timestamp) return [];

  const sessionId = String(entry.sessionId);
  const timestamp = String(entry.timestamp);

  if (entry.type === "assistant" && Array.isArray(entry.message?.content)) {
    const where = { sessionId, timestamp, project: baseName(entry.cwd) };
    if (entry.message.model) where.model = String(entry.message.model);
    return entry.message.content
      .filter((block) => block?.type === "tool_use")
      .map((block) => toolEvent(block, where));
  }

  if (entry.type === "user" && !entry.isMeta) {
    const text = userText(entry.message?.content);
    if (!text) return []; // tool results carry no text blocks
    if (text.includes(INTERRUPT_MARKER)) {
      return [{ kind: "prompt", sessionId, timestamp, interrupted: true }];
    }
    if (SYNTHETIC_PROMPT.test(text)) return [];
    return [{ kind: "prompt", sessionId, timestamp, interrupted: false }];
  }

  return [];
}

/**
 * Parse a whole transcript file's text.
 * @param {string} text
 * @returns {Array<ToolEvent | PromptEvent>}
 */
export function parseTranscript(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (line) events.push(...parseTranscriptLine(line));
  }
  return events;
}
