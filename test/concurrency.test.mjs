import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../src/hooks/post-tool-use.mjs", import.meta.url));

/** Fire the hook as an independent process (no awaiting between launches). */
function fireHook(root, sessionId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
    child.stdin.end(
      JSON.stringify({
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: { command: "git push" },
      }),
    );
  });
}

// This is the test behind the "no locking" design decision: a single line-sized
// O_APPEND write is atomic, so many sessions can append concurrently without a lock
// or a corrupted/interleaved line. If that assumption were wrong, some lines would
// fail to parse or go missing here.
test("concurrent appends from many sessions stay intact and well-formed", async () => {
  const root = mkdtempSync(join(tmpdir(), "praxis-conc-"));
  try {
    const N = 25;
    const codes = await Promise.all(
      Array.from({ length: N }, (_, i) => fireHook(root, `sess-${i}`)),
    );
    assert.ok(
      codes.every((c) => c === 0),
      "every hook process exited 0",
    );

    const lines = readFileSync(join(root, ".praxis", "log.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(lines.length, N, "no writes lost or merged");

    const sessions = new Set();
    for (const line of lines) {
      const record = JSON.parse(line); // throws if a line was interleaved/torn
      assert.equal(record.action, "git_push");
      sessions.add(record.session_id);
    }
    assert.equal(sessions.size, N, "every session's write landed exactly once");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
