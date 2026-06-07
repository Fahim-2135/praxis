import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../src/hooks/post-tool-use.mjs", import.meta.url));

/**
 * Run the hook process exactly as Claude Code would: a payload on stdin, the
 * project root supplied via CLAUDE_PROJECT_DIR. Returns the parsed log lines.
 */
function runHook(payload, { root } = {}) {
  const projectDir = root ?? mkdtempSync(join(tmpdir(), "praxis-"));
  const result = spawnSync(process.execPath, [HOOK], {
    input: payload,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: "utf8",
  });
  const logPath = join(projectDir, ".praxis", "log.jsonl");
  const errPath = join(projectDir, ".praxis", "errors.log");
  return {
    projectDir,
    status: result.status,
    logLines: existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [],
    hasErrors: existsSync(errPath),
    cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
  };
}

test("appends a normalized record and exits 0", () => {
  const r = runHook(JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "git push origin main" } }));
  try {
    assert.equal(r.status, 0);
    assert.equal(r.logLines.length, 1);
    assert.deepEqual(
      { action: r.logLines[0].action, preceding_event: r.logLines[0].preceding_event, session_id: r.logLines[0].session_id },
      { action: "git_push", preceding_event: "session_start", session_id: "s1" },
    );
    assert.ok(!r.hasErrors);
  } finally {
    r.cleanup();
  }
});

test("tolerates a leading UTF-8 BOM (as PowerShell prepends)", () => {
  const bom = String.fromCharCode(0xfeff);
  const r = runHook(bom + JSON.stringify({ session_id: "s1", tool_name: "Read" }));
  try {
    assert.equal(r.status, 0);
    assert.equal(r.logLines.length, 1);
    assert.equal(r.logLines[0].action, "file_read");
    assert.ok(!r.hasErrors);
  } finally {
    r.cleanup();
  }
});

test("empty stdin is a silent no-op (no log, no error, exit 0)", () => {
  const r = runHook("");
  try {
    assert.equal(r.status, 0);
    assert.equal(r.logLines.length, 0);
    assert.ok(!r.hasErrors);
  } finally {
    r.cleanup();
  }
});

test("malformed payload is swallowed: no log line, error noted, still exit 0", () => {
  const r = runHook("not json at all");
  try {
    assert.equal(r.status, 0);
    assert.equal(r.logLines.length, 0);
    assert.ok(r.hasErrors);
  } finally {
    r.cleanup();
  }
});

test("reconstructs preceding_event across calls in the same session", () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-"));
  try {
    runHook(JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } }), { root });
    const r = runHook(JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "git push" } }), { root });
    assert.equal(r.logLines.length, 2);
    assert.equal(r.logLines[1].action, "git_push");
    assert.equal(r.logLines[1].preceding_event, "test_run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
