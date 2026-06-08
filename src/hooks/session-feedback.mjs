#!/usr/bin/env node
// PRAXIS feedback path — the SessionStart injection hook (PRAXIS.md §1, §8).
//
// SessionStart is the one lifecycle event whose stdout Claude Code injects into the
// model's context. This hook reads the approved rules from `active-rules.md`, renders them
// into an imperative directive, and prints it — so the model acts on the user's own
// inferred rules this session. That is the entire feedback loop: Praxis does not automate
// actions, it writes rules into the context the model reads (the honest, inspectable
// "Option A", PRAXIS.md §8).
//
// NO SOURCE FILTER (unlike the detection hook): injection is read-only and cheap, and
// re-injecting after a `compact` is desirable — compaction can summarize the rules away, so
// re-stating them keeps them live. The startup/resume filter is a non-negotiable for
// DETECTION (PRAXIS.md §12), which must not run mid-work; it does not bind read-only output.
//
// Like every Praxis hook it is defensive: any failure is swallowed to `errors.log` and it
// exits 0, so a feedback problem can never block a session from starting. If there are no
// rules (or the file is absent), it prints nothing.

import { readFileSync } from "node:fs";
import { resolveProjectDir, paths } from "../state/paths.mjs";
import { parseActiveRules } from "../review/store.mjs";
import { renderInjection } from "../feedback/context.mjs";
import { readStdin, clean, noteError } from "./io.mjs";

/**
 * Build the injection text for a project root. Missing/unreadable `active-rules.md` => "".
 * @param {string} root
 * @returns {string}
 */
function buildInjection(root) {
  const p = paths(root);
  let markdown;
  try {
    markdown = readFileSync(p.activeRules, "utf8");
  } catch {
    return ""; // no active rules yet — nothing to inject
  }
  return renderInjection(parseActiveRules(markdown));
}

const raw = clean(await readStdin());
if (raw) {
  try {
    const event = JSON.parse(raw);
    const text = buildInjection(resolveProjectDir(event));
    if (text) process.stdout.write(text);
  } catch (err) {
    noteError(err);
  }
}
process.exit(0);
