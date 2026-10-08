// Rules the person turned on from the profile pane ("Make it a rule").
//
// A rule is a rule-ready habit, (preceding_event → action), that the person approved. From then
// on, right after Claude takes the preceding step, Praxis tells Claude to take the next one,
// within what its reversibility tier allows (PRAXIS.md §7):
//   - safe           do it without being asked (tests, formatting, reading)
//   - consequential  ask the person in one line first (commit, push)
//   - destructive    only suggest it; never do it
//
// Pure: no I/O. The mod (hooks/praxis.mjs) keeps the rules in its store and adds the text this
// module writes to the step's result.

import { classifyReversibility, patternId } from "./detect.mjs";
import { describeAction } from "./profile/profile.mjs";

/** What Claude is asked to do, as a verb phrase ("run the tests"). */
const DO = Object.freeze({
  test_run: "run the tests",
  build_run: "build the project",
  lint_run: "run the type-check and linter",
  format_run: "format the code",
  install_run: "install the packages",
  file_read: "read the relevant files",
  git_status: "check git status",
  git_log: "read the git log",
  git_diff: "review the diff",
  git_add: "stage the changes",
  git_commit: "commit the changes",
  git_push: "push",
  git_pull: "get the latest code",
  web_search: "search the web",
});

/** The rule for a rule-ready habit. */
export function ruleFrom(habit, now = Date.now()) {
  return {
    id: patternId(habit.action, habit.preceding_event),
    action: habit.action,
    preceding_event: habit.preceding_event,
    tier: habit.tier ?? classifyReversibility(habit.action),
    sentence:
      habit.sentence ??
      `${describeAction(habit.preceding_event)} → ${describeAction(habit.action)}`,
    createdAt: now,
  };
}

/** The rules whose trigger is the step Claude just took. */
export function rulesAfter(rules, action) {
  return (rules ?? []).filter((r) => r.preceding_event === action);
}

/**
 * What Claude reads right after the trigger step, for one rule.
 * @param {{ action: string, preceding_event: string, tier: string }} rule
 */
export function ruleNote(rule) {
  const did = describeAction(rule.preceding_event);
  const next = DO[rule.action] ?? describeAction(rule.action);
  const lead = `Praxis rule the user turned on: after ${did}, ${next}.`;
  if (rule.tier === "safe") {
    return `${lead} You just did that step, so ${next} now, without being asked (skip it only if it clearly makes no sense here). Mention it in one short line starting "Praxis rule:".`;
  }
  if (rule.tier === "destructive") {
    return `${lead} This can't be undone, so never do it yourself: suggest it to the user in one line.`;
  }
  return `${lead} You just did that step. Ask the user in one line whether to ${next} now, and do it only if they say yes.`;
}

/** How the pane describes what a rule will do, by tier. */
export function ruleBehaviour(rule) {
  if (rule.tier === "safe") return "Claude does it by itself";
  if (rule.tier === "destructive") return "Claude only suggests it";
  return "Claude asks you first";
}
