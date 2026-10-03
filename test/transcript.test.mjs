import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptLine, parseTranscript, baseName } from "../src/history/transcript.mjs";

const assistant = (content, extra = {}) =>
  JSON.stringify({
    type: "assistant",
    isSidechain: false,
    sessionId: "s1",
    timestamp: "2026-09-12T18:14:35.357Z",
    cwd: "C:\\Users\\me\\code\\talkative",
    message: { model: "claude-opus-5-5", role: "assistant", content },
    ...extra,
  });

const user = (content, extra = {}) =>
  JSON.stringify({
    type: "user",
    isSidechain: false,
    sessionId: "s1",
    timestamp: "2026-09-12T18:14:30.000Z",
    message: { role: "user", content },
    ...extra,
  });

test("reads every tool call in an assistant message, with project and model", () => {
  const events = parseTranscriptLine(
    assistant([
      { type: "thinking", thinking: "" },
      { type: "tool_use", name: "Read", input: { file_path: "C:\\code\\talkative\\app.json" } },
      { type: "tool_use", name: "Bash", input: { command: "cd app && git push origin main" } },
    ]),
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    kind: "tool",
    sessionId: "s1",
    timestamp: "2026-09-12T18:14:35.357Z",
    project: "talkative",
    model: "claude-opus-5-5",
    action: "file_read",
    file: "app.json",
  });
  assert.equal(events[1].action, "git_push");
});

test("keeps only the verb of an unrecognized command, never its arguments", () => {
  const [event] = parseTranscriptLine(
    assistant([
      {
        type: "tool_use",
        name: "Bash",
        input: { command: 'TOKEN=abc123 docker login -p "s3cret" registry.io' },
      },
    ]),
  );
  assert.equal(event.action, "unmatched");
  assert.equal(event.raw, "docker");
});

test("names a connector call by its server", () => {
  const [event] = parseTranscriptLine(
    assistant([{ type: "tool_use", name: "mcp__claude_ai_Gmail__search_threads", input: {} }]),
  );
  assert.equal(event.action, "mcp_call");
  assert.equal(event.raw, "claude_ai_Gmail");
});

test("counts typed prompts and interruptions, and skips synthetic user text", () => {
  assert.deepEqual(parseTranscriptLine(user("fix the login bug")), [
    { kind: "prompt", sessionId: "s1", timestamp: "2026-09-12T18:14:30.000Z", interrupted: false },
  ]);
  const [stop] = parseTranscriptLine(
    user([{ type: "text", text: "[Request interrupted by user]" }]),
  );
  assert.equal(stop.interrupted, true);
  assert.deepEqual(parseTranscriptLine(user("<command-name>/clear</command-name>")), []);
  assert.deepEqual(parseTranscriptLine(user("<system-reminder>x</system-reminder>")), []);
  assert.deepEqual(parseTranscriptLine(user("hi", { isMeta: true })), []);
  assert.deepEqual(
    parseTranscriptLine(user([{ type: "tool_result", tool_use_id: "t", content: "ok" }])),
    [],
  );
});

test("skips subagent lines, malformed lines, and records without a session", () => {
  const tool = [{ type: "tool_use", name: "Read", input: {} }];
  assert.deepEqual(parseTranscriptLine(assistant(tool, { isSidechain: true })), []);
  assert.deepEqual(parseTranscriptLine('{"type":"assistant", "tool_use"'), []);
  assert.deepEqual(parseTranscriptLine(assistant(tool, { sessionId: undefined })), []);
  assert.deepEqual(parseTranscriptLine('{"type":"queue-operation"}'), []);
});

test("parses a whole file, line by line", () => {
  const text = [
    user("go"),
    assistant([{ type: "tool_use", name: "Edit", input: { file_path: "/a/b.ts" } }]),
    "",
  ].join("\n");
  assert.deepEqual(
    parseTranscript(text).map((e) => e.kind),
    ["prompt", "tool"],
  );
});

test("baseName handles both separators and trailing slashes", () => {
  assert.equal(baseName("C:\\Users\\me\\proj\\"), "proj");
  assert.equal(baseName("/home/me/proj/file.ts"), "file.ts");
  assert.equal(baseName(undefined), "");
});
