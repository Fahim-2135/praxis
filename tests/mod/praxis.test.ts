// Tests for the Praxis mod (hooks/praxis.mjs), run by `claude plugin test` with no session,
// sign-in, or network. Every call the mod makes to Claude Code is answered by a stub here.

import { expect, mock, test } from "claude-code/testing";
import { buildHistory, encodeHistory } from "../../src/history/history.mjs";

const PANE = {
  plugin: "praxis",
  component: "Pane",
  requestId: "praxis",
  surface: "terminal",
  viewport: { columns: 120, rows: 40 },
  props: {
    title: "Praxis",
    isFocused: true,
    bodyColumns: 80,
    placement: "inline",
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const;

/**
 * A small history whose clearest signal is subagents (25% of calls), at midday UTC so the
 * night-owl archetype does not compete. Three sessions over three days.
 */
function fixtureHistory() {
  const events = [];
  for (let day = 1; day <= 3; day++) {
    const sessionId = `s${day}`;
    const actions = ["Read", "Agent", "Edit", "Read", "Agent", "Edit", "Grep", "Read"];
    actions.forEach((tool, i) => {
      events.push({
        kind: "tool",
        sessionId,
        timestamp: `2026-09-0${day}T12:0${i}:00.000Z`,
        project: "demo",
        action: {
          Read: "file_read",
          Agent: "subagent_run",
          Edit: "file_edit",
          Grep: "file_search",
        }[tool],
        model: "claude-opus-5-5",
      });
    });
    events.push({
      kind: "prompt",
      sessionId,
      timestamp: `2026-09-0${day}T11:59:00.000Z`,
      interrupted: false,
    });
  }
  return JSON.stringify(encodeHistory(buildHistory(events)));
}

/** Stubs for everything session.start and a scan touch, recording toasts and copies. */
function stubSession(
  on,
  seen: { toasts: string[]; copied: string[] },
  history: () => string = fixtureHistory,
) {
  mock.env(on, {});
  const saved = new Map<string, unknown>();
  on("store.get", ($, e) => ({ value: saved.get(e.key) }));
  on("store.set", ($, e) => {
    saved.set(e.key, e.value);
    return { value: undefined };
  });
  on("store.delete", ($, e) => {
    saved.delete(e.key);
    return { value: undefined };
  });
  on("command.register", () => ({ value: undefined }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.toast", ($, e) => {
    seen.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.copy", ($, e) => {
    seen.copied.push(e.text);
    return { value: { isCopied: true } };
  });
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("process.run", () => ({
    value: {
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, out: "/data/history.json" }) + "\n",
      stderr: "",
    },
  }));
  on("fs.read", () => ({ value: history() }));
  on("session.start", () => ({ cwd: "/work" }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
}

async function startAndScan($, clock) {
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
  await clock.settle();
}

test("the first scan announces the reveal once", async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse("2026-09-04T00:00:00Z") });
  const seen = { toasts: [] as string[], copied: [] as string[] };
  stubSession(on, seen);

  await startAndScan($, clock);

  expect(seen.toasts.length).toBe(1);
  expect(seen.toasts[0]).toContain("Praxis read 3 of your sessions");
});

test("/praxis share copies a card with the archetype and the link", async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse("2026-09-04T00:00:00Z") });
  const seen = { toasts: [] as string[], copied: [] as string[] };
  stubSession(on, seen);

  await startAndScan($, clock);
  const answer = await $.command.run({ command: "praxis", args: "share" });

  expect(answer.text).toContain("Copied");
  expect(seen.copied[0]).toContain("The Delegator");
  expect(seen.copied[0]).toContain("github.com/Fahim-2135/praxis");
});

test("the pane shows the archetype and the share button copies the card", async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse("2026-09-04T00:00:00Z") });
  const seen = { toasts: [] as string[], copied: [] as string[] };
  stubSession(on, seen);

  await startAndScan($, clock);
  const ui = await $.ui.mount(PANE);

  expect(await ui.find({ type: "Text", text: "THE DELEGATOR" })).toBeDefined();
  await ui.press({ key: "copy" });
  expect(seen.copied.length).toBe(1);
  await ui.unmount();
});

test("the pane says it is reading before the first scan finishes", async ($, on) => {
  stubSession(on, { toasts: [], copied: [] });
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ type: "Text", text: /Reading your Claude Code history/ })).toBeDefined();
  await ui.unmount();
});

/** A tool.call stub that answers Praxis's question with `answer` and runs every other tool. */
function answerQuestion(on, answer: string, ran: string[]) {
  on("tool.call", ($, e) => {
    if (e.tool === "AskUserQuestion")
      return { result: { answers: { [e.questions[0].question]: answer } } };
    ran.push(e.command);
    return { result: "ok" };
  });
}

test("an irreversible command is held and refused when the user says no", async ($, on) => {
  const ran: string[] = [];
  answerQuestion(on, "Don't run it", ran);

  const result = await $.tool.call({ tool: "Bash", command: "rm -rf build" });

  expect(result.deny).toContain("Praxis held this deletion command");
  expect(ran).toEqual([]);
});

test("an irreversible command runs when the user says yes", async ($, on) => {
  const ran: string[] = [];
  answerQuestion(on, "Run it", ran);

  const result = await $.tool.call({ tool: "Bash", command: "git push --force origin main" });

  expect(result.result).toBe("ok");
  expect(ran).toEqual(["git push --force origin main"]);
});

test("a background agent's run (CREW_WORKER) is left alone: no hold, no scan", async ($, on) => {
  mock.env(on, { CREW_WORKER: "1" });
  const asked: string[] = [];
  const ran: string[] = [];
  on("tool.call", ($, e) => {
    if (e.tool === "AskUserQuestion") asked.push(e.questions[0].question);
    else ran.push(e.command);
    return { result: "ok" };
  });
  on("session.start", () => ({ cwd: "/work" }));
  await $.session.start({ surface: "cli", isInteractive: false, cwd: "/work" } as any);

  const result = await $.tool.call({ tool: "Bash", command: "rm -rf build" });

  expect(result.result).toBe("ok");
  expect(asked).toEqual([]);
  expect(ran).toEqual(["rm -rf build"]);
});

test("an ordinary command is never questioned", async ($, on) => {
  const ran: string[] = [];
  answerQuestion(on, "Don't run it", ran);

  const result = await $.tool.call({ tool: "PowerShell", command: "git status" });

  expect(result.result).toBe("ok");
  expect(ran).toEqual(["git status"]);
});

test("the line above the prompt shows the habit Praxis is closest to learning, and /praxis quiet hides it", async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse("2026-09-04T00:00:00Z") });
  stubSession(on, { toasts: [], copied: [] });
  const BAND = {
    plugin: "praxis",
    component: "AbovePrompt",
    surface: "terminal",
    viewport: { columns: 120, rows: 40 },
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 3,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 3 },
      view: {},
    },
  } as const;

  await startAndScan($, clock);
  let band = await $.ui.mount(BAND);
  expect(
    await band.find({
      type: "Text",
      text: "praxis · watching: editing files → reading files (seen 3× — 2 more occurrences to qualify) · /praxis",
    }),
  ).toBeDefined();
  await band.unmount();

  await $.command.run({ command: "praxis", args: "quiet" });
  band = await $.ui.mount(BAND);
  expect(await band.find({ type: "Text", text: "drawn by Claude Code" })).toBeDefined();
  await band.unmount();
});

/** A history whose one strong habit is "getting the latest code → running tests", 3 sessions. */
function habitHistory() {
  const events = [];
  for (let day = 1; day <= 3; day++) {
    const sessionId = `h${day}`;
    const steps = ["file_read", "git_pull", "test_run", "file_edit", "git_pull", "test_run"];
    steps.forEach((action, i) => {
      events.push({
        kind: "tool",
        sessionId,
        timestamp: `2026-09-0${day}T12:0${i}:00.000Z`,
        project: "tip-calculator",
        action,
        model: "claude-opus-5-5",
      });
    });
  }
  return JSON.stringify(encodeHistory(buildHistory(events)));
}

test("a rule-ready habit becomes a rule with one press, and Claude is told the next step", async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse("2026-09-04T00:00:00Z") });
  const seen = { toasts: [] as string[], copied: [] as string[] };
  stubSession(on, seen, habitHistory);
  on("tool.call", () => ({ result: { stdout: "Already up to date.", stderr: "" }, text: "ok" }));

  await startAndScan($, clock);
  const ui = await $.ui.mount(PANE);
  expect(await ui.find({ text: /getting the latest code → running tests/ })).toBeDefined();

  // No rule yet: a pull carries nothing extra.
  const before = await $.tool.call({ tool: "Bash", tool_use_id: "t0", command: "git pull" });
  expect(before.context ?? []).toEqual([]);

  await ui.press({ key: "make-rule-0" });
  expect(seen.toasts.at(-1)).toContain("Rule on: getting the latest code → running tests");
  expect(await ui.find({ text: /YOUR RULES/ })).toBeDefined();

  // Now, right after a pull, Claude reads that it should run the tests.
  const after = await $.tool.call({ tool: "Bash", tool_use_id: "t1", command: "git pull" });
  expect((after.context ?? []).join("\n")).toMatch(/run the tests now, without being asked/);
  // Other steps carry nothing.
  const other = await $.tool.call({ tool: "Bash", tool_use_id: "t2", command: "npm test" });
  expect(other.context ?? []).toEqual([]);

  await ui.press({ key: "drop-rule-0" });
  const off = await $.tool.call({ tool: "Bash", tool_use_id: "t3", command: "git pull" });
  expect(off.context ?? []).toEqual([]);
  await ui.unmount();
});
