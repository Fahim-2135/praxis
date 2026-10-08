import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleBehaviour, ruleFrom, ruleNote, rulesAfter } from "../src/rules.mjs";

const habit = {
  action: "test_run",
  preceding_event: "git_pull",
  sentence: "getting the latest code → running tests",
};

test("a rule-ready habit becomes a rule with its reversibility tier", () => {
  const rule = ruleFrom(habit, 5);
  assert.equal(rule.tier, "safe");
  assert.equal(rule.sentence, "getting the latest code → running tests");
  assert.equal(rule.createdAt, 5);
  assert.equal(rule.id, ruleFrom(habit, 9).id, "the same habit is the same rule");
});

test("a rule fires only after its own trigger step", () => {
  const rules = [ruleFrom(habit), ruleFrom({ action: "git_push", preceding_event: "git_commit" })];
  assert.deepEqual(
    rulesAfter(rules, "git_pull").map((r) => r.action),
    ["test_run"],
  );
  assert.deepEqual(rulesAfter(rules, "file_read"), []);
});

test("safe steps are done, recoverable ones asked about, irreversible ones only suggested", () => {
  assert.match(ruleNote(ruleFrom(habit)), /run the tests now, without being asked/);
  assert.match(
    ruleNote(ruleFrom({ action: "git_push", preceding_event: "git_commit" })),
    /Ask the user in one line whether to push/,
  );
  const risky = { action: "rm_rf", preceding_event: "git_commit", tier: "destructive" };
  assert.match(ruleNote(risky), /never do it yourself/);
  assert.equal(ruleBehaviour(ruleFrom(habit)), "Claude does it by itself");
  assert.equal(ruleBehaviour({ tier: "consequential" }), "Claude asks you first");
});
