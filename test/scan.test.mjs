import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanHistory } from "../src/history/scan.mjs";
import { decodeHistory } from "../src/history/history.mjs";

const call = (sessionId, second, name, input = {}) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    sessionId,
    timestamp: `2026-09-01T10:00:${String(second).padStart(2, "0")}.000Z`,
    cwd: "/code/demo",
    message: { content: [{ type: "tool_use", name, input }] },
  }) + "\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "praxis-scan-"));
  const projectsDir = join(root, "projects");
  const dataDir = join(root, "data");
  mkdirSync(join(projectsDir, "demo", "s1", "subagents"), { recursive: true });
  return { root, projectsDir, dataDir };
}

const readHistory = (out) => decodeHistory(JSON.parse(readFileSync(out, "utf8")));

test("scans top-level transcripts and writes a decodable history", async () => {
  const { root, projectsDir, dataDir } = fixture();
  try {
    writeFileSync(
      join(projectsDir, "demo", "s1.jsonl"),
      call("s1", 1, "Read") + call("s1", 2, "Edit"),
    );
    writeFileSync(join(projectsDir, "demo", "s1", "subagents", "a.jsonl"), call("x", 3, "Read"));

    const result = await scanHistory({ projectsDir, dataDir });
    assert.equal(result.files, 1, "subagent transcripts are not scanned");
    assert.equal(result.toolCalls, 2);
    assert.deepEqual(
      readHistory(result.out).records.map((r) => [r.action, r.preceding_event]),
      [
        ["file_read", "session_start"],
        ["file_edit", "file_read"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second scan reuses the cache and parses only appended lines", async () => {
  const { root, projectsDir, dataDir } = fixture();
  try {
    const file = join(projectsDir, "demo", "s1.jsonl");
    writeFileSync(file, call("s1", 1, "Read"));
    await scanHistory({ projectsDir, dataDir });

    const unchanged = await scanHistory({ projectsDir, dataDir });
    assert.equal(unchanged.reparsed, 0);

    appendFileSync(file, call("s1", 2, "Bash", { command: "git push" }));
    const grown = await scanHistory({ projectsDir, dataDir });
    assert.equal(grown.reparsed, 1);
    assert.deepEqual(
      readHistory(grown.out).records.map((r) => r.action),
      ["file_read", "git_push"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a line still being written is picked up whole on the next scan", async () => {
  const { root, projectsDir, dataDir } = fixture();
  try {
    const file = join(projectsDir, "demo", "s1.jsonl");
    const line = call("s1", 1, "Read");
    writeFileSync(file, line.slice(0, 40)); // no newline yet
    assert.equal((await scanHistory({ projectsDir, dataDir })).toolCalls, 0);

    appendFileSync(file, line.slice(40));
    assert.equal((await scanHistory({ projectsDir, dataDir })).toolCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing projects directory yields an empty history, not an error", async () => {
  const { root, dataDir } = fixture();
  try {
    const result = await scanHistory({ projectsDir: join(root, "nope"), dataDir });
    assert.equal(result.files, 0);
    assert.equal(result.toolCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a damaged cache is rebuilt", async () => {
  const { root, projectsDir, dataDir } = fixture();
  try {
    writeFileSync(join(projectsDir, "demo", "s1.jsonl"), call("s1", 1, "Read"));
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "scan-cache.json"), "{ not json");
    const result = await scanHistory({ projectsDir, dataDir });
    assert.equal(result.reparsed, 1);
    assert.equal(result.toolCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
