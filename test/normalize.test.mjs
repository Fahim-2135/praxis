import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../src/normalize.mjs";

test("collapses git push argument variants into one action", () => {
  assert.equal(
    normalize({ tool_name: "Bash", tool_input: { command: "git push" } }).action,
    "git_push",
  );
  assert.equal(
    normalize({
      tool_name: "Bash",
      tool_input: { command: "git push origin main --force-with-lease" },
    }).action,
    "git_push",
  );
});

test("recognizes test runners behind common prefixes", () => {
  for (const command of [
    "npm test",
    "npm run test",
    "pnpm test",
    "yarn test",
    "pytest -q",
    "go test ./...",
    "cargo test",
  ]) {
    assert.equal(
      normalize({ tool_name: "Bash", tool_input: { command } }).action,
      "test_run",
      command,
    );
  }
});

test("distinguishes git subcommands", () => {
  assert.equal(
    normalize({ tool_name: "Bash", tool_input: { command: "git commit -m 'x'" } }).action,
    "git_commit",
  );
  assert.equal(
    normalize({ tool_name: "Bash", tool_input: { command: "git status" } }).action,
    "git_status",
  );
  assert.equal(
    normalize({ tool_name: "Bash", tool_input: { command: "git switch main" } }).action,
    "git_checkout",
  );
});

test("maps editing tools to a single file_edit action", () => {
  for (const tool_name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.equal(normalize({ tool_name }).action, "file_edit", tool_name);
  }
});

test("maps read and search tools", () => {
  assert.equal(normalize({ tool_name: "Read" }).action, "file_read");
  assert.equal(normalize({ tool_name: "Grep" }).action, "file_search");
  assert.equal(normalize({ tool_name: "Glob" }).action, "file_search");
});

test("unmatched bash preserves the raw command for later discovery", () => {
  const result = normalize({ tool_name: "Bash", tool_input: { command: "docker compose up -d" } });
  assert.equal(result.action, "unmatched");
  assert.equal(result.raw, "docker compose up -d");
});

test("unmatched tool preserves the tool name", () => {
  const result = normalize({ tool_name: "SomeFutureTool" });
  assert.equal(result.action, "unmatched");
  assert.equal(result.raw, "SomeFutureTool");
});

test("never throws on malformed input", () => {
  assert.equal(normalize({}).action, "unmatched");
  assert.equal(normalize({ tool_name: "Bash" }).action, "unmatched"); // missing tool_input
  assert.equal(normalize(undefined).action, "unmatched");
});

const bash = (command) => normalize({ tool_name: "Bash", tool_input: { command } });

test("compound command resolves to its terminal intent", () => {
  assert.equal(bash("git add . && git commit -m 'x' && git push").action, "git_push");
  assert.equal(bash("npm test && git push origin main").action, "git_push");
});

test("anchored rules still match when the command is chained or prefixed", () => {
  // A leading `^git` rule would miss these without segment splitting.
  assert.equal(bash("cd packages/api && git push").action, "git_push");
  assert.equal(bash("git fetch; git status").action, "git_status");
  assert.equal(bash("git log | head -20").action, "git_log");
});

test("a chain with no recognized verb stays unmatched with raw preserved", () => {
  const result = bash("docker build . && docker push myimage");
  assert.equal(result.action, "unmatched");
  assert.equal(result.raw, "docker build . && docker push myimage");
});

test("non-actionable leading segment yields the actionable trailing one", () => {
  assert.equal(bash("echo deploying && npm run build").action, "build_run");
});
