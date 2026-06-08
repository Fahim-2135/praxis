#!/usr/bin/env node
// PRAXIS safety gate — the PreToolUse hook (PRAXIS.md §7, §12).
//
// Fires BEFORE every Bash tool call. If the command is irreversible (force-push, recursive/
// forced deletion, disk overwrite, external send), it returns an "ask" permission decision so
// Claude Code must obtain explicit human confirmation before running it. This enforces the
// destructive tier at the HOOK layer, not by convention: even a buggy or malicious rule, or a
// model slip, cannot auto-execute an irreversible action — the spec's central safety guarantee.
//
// Contract (mirrors the hot path — it runs before every Bash call):
//   - Minimal: no model, no network, pure regex (src/safety.mjs).
//   - Fails OPEN. On any error it allows the call and notes the error to `errors.log`. A safety
//     hook that crashed must not wedge every command — the same "never disturb Claude Code"
//     rule every Praxis hook follows. Failing closed would turn one parse bug into a frozen
//     terminal; logging keeps a silent failure visible instead.
//   - Scope is the Bash tool (the destructive vector); other tools are not gated in v1.
//
// Deviation from the spec's wording: PRAXIS.md §7/§2 say "hard-blocked (exit code 2)". We return
// "ask" rather than "deny" so the guarantee — never auto-executes — holds for every irreversible
// call while a human can still proceed deliberately. "Hard-blocked" is realized as "hard-gated."

import { inspectCommand } from "../safety.mjs";
import { readStdin, clean, noteError } from "./io.mjs";

const raw = clean(await readStdin());
if (raw) {
  try {
    const event = JSON.parse(raw);
    if (event?.tool_name === "Bash") {
      const hit = inspectCommand(event?.tool_input?.command ?? "");
      if (hit) {
        const decision = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason:
              `Praxis safety gate: ${hit.reason}. This is an irreversible ${hit.category} ` +
              `action — confirm before running it.`,
          },
        };
        process.stdout.write(JSON.stringify(decision));
      }
    }
  } catch (err) {
    noteError(err); // fail open: allow the call, but record why the gate did not run
  }
}
process.exit(0);
