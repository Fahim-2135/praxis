import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../src/hooks/pre-tool-use.mjs", import.meta.url));

/** Run the PreToolUse hook as Claude Code would: payload on stdin, project dir in env. */
function runHook(payload, { root } = {}) {
  const projectDir = root ?? mkdtempSync(join(tmpdir(), "praxis-"));
  const result = spawnSync(process.execPath, [HOOK], {
    input: payload,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf8",
  });
  return {
    projectDir,
    status: result.status,
    stdout: result.stdout ?? "",
    hasErrors: existsSync(join(projectDir, ".praxis", "errors.log")),
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

/** Parse the hook's stdout into a permission decision, or null if it allowed silently. */
function decision(stdout) {
  if (!stdout) return null;
  return JSON.parse(stdout).hookSpecificOutput?.permissionDecision ?? null;
}

test("an irreversible Bash command returns an 'ask' decision and exits 0", () => {
  const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf build" } }));
  try {
    assert.equal(r.status, 0);
    assert.equal(decision(r.stdout), "ask");
    assert.match(r.stdout, /irreversible/);
    assert.ok(!r.hasErrors);
  } finally {
    r.cleanup();
  }
});

test("a force-push is gated", () => {
  const r = runHook(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force" } }),
  );
  try {
    assert.equal(decision(r.stdout), "ask");
  } finally {
    r.cleanup();
  }
});

test("a safe Bash command is allowed silently (no output, exit 0)", () => {
  const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" } }));
  try {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    r.cleanup();
  }
});

test("non-Bash tools are never gated", () => {
  const r = runHook(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } }));
  try {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    r.cleanup();
  }
});

test("empty stdin is a silent no-op", () => {
  const r = runHook("");
  try {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.ok(!r.hasErrors);
  } finally {
    r.cleanup();
  }
});

test("a malformed payload fails open: allows the call, notes the error, exits 0", () => {
  const r = runHook("not json at all");
  try {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, ""); // no decision emitted -> call proceeds (fail open)
    assert.ok(r.hasErrors); // but the failure is recorded, not silent
  } finally {
    r.cleanup();
  }
});
