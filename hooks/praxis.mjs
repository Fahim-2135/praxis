// Praxis 2 — the Claude Code mod.
//
// Praxis 1 ran as settings hooks: a separate Node process per tool call, registered per project,
// so it only ever saw sessions opened inside its own repository and needed days of logging before
// it could say anything. As a mod it runs inside Claude Code in every project, and it starts from
// the transcripts Claude Code already keeps, so the first profile appears seconds after install.
//
// What this module does:
//   - session.start   registers /praxis and starts a background scan of the history
//   - turn.complete   refreshes the profile in the background after each answer
//   - ui.render       draws the profile pane, and one line above the prompt
//   - tool.call       holds irreversible shell commands for the person's explicit go-ahead
//
// Everything that decides anything lives in the pure modules under src/, which have their own
// tests. This file is the I/O shell: it moves data between Claude Code and those modules.

import { decodeHistory, buildHistory } from "../src/history/history.mjs";
import { parseTranscript } from "../src/history/transcript.mjs";
import { buildProfile } from "../src/profile/profile.mjs";
import { shareCard, bandText, wittyRequest, cleanWitty } from "../src/profile/card.mjs";
import { inspectCommand } from "../src/safety.mjs";

const PANE = "praxis";

/** Minimum time between background refreshes, so a burst of short turns triggers one scan. */
const REFRESH_INTERVAL_MS = 30_000;

/** Largest transcript the in-process fallback can read: the mods API's per-file limit. */
const FS_READ_LIMIT = 4 * 1024 * 1024;

/** @type {"idle" | "scanning" | "ready" | "failed"} */
let scanState = "idle";
let scanNote = "";
/** @type {import("../src/profile/profile.mjs").Profile | null} */
let profile = null;
let lastScanAt = 0;
let witty = null;
let wittyPending = false;
let settings = { quiet: false };

export function register(on) {
  on("session.start", async ($, e, next) => {
    const saved = await $.store.get("settings");
    if (saved && typeof saved === "object") settings = { ...settings, ...saved };
    const cached = await $.store.get("witty");
    if (cached && typeof cached.text === "string") witty = cached;

    // The scan runs on a timer so the session starts at once instead of waiting for it.
    $.clock.after(0, () => refresh($));

    try {
      await $.command.register({
        name: "praxis",
        description: "See what your Claude Code history says about how you work",
        argumentHint: "[share | rescan | quiet | loud]",
        immediate: true,
      });
    } catch (err) {
      $.ui.log(`could not add /praxis: ${err?.message ?? err}`, { to: "debug" });
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const now = await $.clock.now();
    if (scanState !== "scanning" && now - lastScanAt > REFRESH_INTERVAL_MS) {
      $.clock.after(0, () => refresh($));
    }
    return next(e);
  });

  on("command.run", { command: "praxis" }, async ($, e) => {
    const arg = String(e.args ?? "")
      .trim()
      .toLowerCase();

    if (arg === "share") {
      if (!profile) return { text: "Praxis is still reading your history. Try again in a moment." };
      const card = shareCard(profile, { witty: witty?.text });
      const copied = await $.ui.copy({ text: card });
      return copied.isCopied
        ? { text: "Copied your Praxis card. Paste it wherever you post." }
        : { text: card };
    }
    if (arg === "rescan") {
      witty = null;
      await $.store.delete("witty");
      $.clock.after(0, () => refresh($));
      return { text: "Rescanning your history." };
    }
    if (arg === "quiet" || arg === "loud") {
      settings = { ...settings, quiet: arg === "quiet" };
      await $.store.set("settings", settings);
      $.ui.invalidate("ui.render");
      return {
        text:
          arg === "quiet"
            ? "Praxis line hidden. /praxis loud brings it back."
            : "Praxis line shown.",
      };
    }

    await $.ui.open({ id: PANE, title: "Praxis", focus: true, closeOnEscape: true });
    if (profile && !witty && !wittyPending) $.clock.after(0, () => fetchWitty($));
    return {};
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const ui = $.ui.resolve(e);
    const copyCard = async (press) => {
      if (!profile) return;
      const card = shareCard(profile, { witty: witty?.text });
      const result = await $.ui.copy({ text: card, surface: press?.surface });
      $.ui.toast(
        result.isCopied ? "Copied. Paste it wherever you post." : `Copy failed: ${result.reason}`,
      );
    };
    const rescan = () => {
      witty = null;
      $.clock.after(0, () => refresh($));
    };
    return drawPane(ui, e.props.bodyColumns, { copyCard, rescan });
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (settings.quiet || !profile || profile.totals.toolCalls === 0 || e.props.isWorking) {
      return next(e);
    }
    const { Text } = $.ui.resolve(e);
    return Text({ dimColor: true, wrap: "truncate-end", children: [bandText(profile)] });
  });

  on("tool.call", { tool: ["Bash", "PowerShell"] }, async ($, e, next) => {
    const hit = inspectCommand(String(e.command ?? ""));
    if (!hit) return next(e);

    let answer = "Don't run it";
    try {
      answer = await $.ui.ask(`Praxis: ${hit.reason}. Run \`${shorten(e.command, 120)}\`?`, [
        "Run it",
        "Don't run it",
      ]);
    } catch {
      // Dismissed, or a non-interactive run with nobody to ask: the safe answer stands.
    }
    if (answer !== "Run it") {
      return {
        deny: `Praxis held this ${hit.category} command and the user did not approve it (${hit.reason}). Ask the user before trying another way.`,
      };
    }
    return next(e);
  });
}

/**
 * Rescan the history and rebuild the profile. Prefers the Node scanner, which reads files of any
 * size incrementally; falls back to reading transcripts through the mods API when Node is not
 * available, skipping files over the per-file read limit.
 */
async function refresh($) {
  if (scanState === "scanning") return;
  scanState = "scanning";
  $.ui.invalidate("ui.render");
  try {
    let history = await scanWithNode($);
    if (!history) history = await scanInProcess($);
    profile = buildProfile(history, {
      now: await $.clock.now(),
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
    });
    scanState = "ready";
    lastScanAt = await $.clock.now();
    await announceFirstReveal($);
  } catch (err) {
    scanState = "failed";
    scanNote = String(err?.message ?? err);
    $.ui.log(`scan failed: ${scanNote}`, { to: "debug" });
  }
  $.ui.invalidate("ui.render");
}

/** Run bin/praxis-history.mjs and read the history it writes; null when Node is unavailable. */
async function scanWithNode($) {
  let run;
  try {
    run = await $.process.run(["node", `${$.plugin.root}/bin/praxis-history.mjs`], {
      timeoutMs: 120_000,
    });
  } catch {
    return null;
  }
  const lastLine = String(run.stdout ?? "")
    .trim()
    .split("\n")
    .pop();
  let result;
  try {
    result = JSON.parse(lastLine);
  } catch {
    return null;
  }
  if (!result?.ok) return null;
  return decodeHistory(JSON.parse(await $.fs.read(result.out)));
}

/** Read transcripts through the mods API; used when the Node scanner cannot run. */
async function scanInProcess($) {
  const configDir = (await $.env.get("CLAUDE_CONFIG_DIR")) || `${await homeDir($)}/.claude`;
  const projectsDir = `${configDir}/projects`;
  const events = [];
  let skipped = 0;
  for (const project of await $.fs.list(projectsDir)) {
    if (project.kind !== "directory") continue;
    for (const file of await $.fs.list(`${projectsDir}/${project.name}`)) {
      if (file.kind !== "file" || !file.name.endsWith(".jsonl")) continue;
      if (file.size > FS_READ_LIMIT) {
        skipped += 1;
        continue;
      }
      const text = await $.fs.read(`${projectsDir}/${project.name}/${file.name}`);
      for (const event of parseTranscript(text)) events.push(event);
    }
  }
  scanNote = skipped
    ? `${skipped} very long sessions were skipped (install Node.js to include them).`
    : "";
  return buildHistory(events);
}

/** The user's home directory, from the variables each platform sets. */
async function homeDir($) {
  return (await $.env.get("HOME")) || (await $.env.get("USERPROFILE")) || ".";
}

/** The first time a profile exists, say so: this toast is the "it already knows me" moment. */
async function announceFirstReveal($) {
  if (!profile || profile.totals.sessions === 0) return;
  if (await $.store.get("revealed")) return;
  await $.store.set("revealed", true);
  $.ui.toast(
    `Praxis read ${profile.totals.sessions} of your sessions. Type /praxis to see what they say about you.`,
    { timeoutMs: 12_000 },
  );
}

/** Ask a small model for a one-line caption, once per archetype; the card works without it. */
async function fetchWitty($) {
  if (!profile || wittyPending) return;
  wittyPending = true;
  try {
    const request = wittyRequest(profile);
    const reply = await $.model.complete({
      model: "haiku",
      system: request.system,
      prompt: request.prompt,
      maxTokens: 80,
      timeoutMs: 20_000,
    });
    const text = reply.isAnswered ? cleanWitty(reply.text) : null;
    if (text) {
      witty = { archetype: profile.archetype.name, text };
      await $.store.set("witty", witty);
      $.ui.invalidate("ui.render");
    }
  } catch (err) {
    $.ui.log(`caption skipped: ${err?.message ?? err}`, { to: "debug" });
  } finally {
    wittyPending = false;
  }
}

/** Trim a command for display inside a one-line question. */
function shorten(text, max) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const num = (n) => Number(n ?? 0).toLocaleString("en-US");

/**
 * Draw the profile pane: the archetype, the numbers behind it, signature moves, rule-ready and
 * almost habits, fun facts, and the share and rescan buttons.
 * @param {Record<string, Function>} ui   Elements from $.ui.resolve.
 * @param {number} width                 The pane's body width in columns.
 * @param {{ copyCard: Function, rescan: Function }} actions
 */
function drawPane(ui, width, actions) {
  const { Box, Text, Button } = ui;
  const line = (text, props = {}) => Text({ wrap: "wrap", ...props, children: [text] });
  const gap = () => Text({ children: [" "] });
  const heading = (text) => Text({ bold: true, children: [text] });
  const rule = () =>
    Text({ dimColor: true, children: ["─".repeat(Math.max(10, Math.min(width ?? 60, 72)))] });

  if (!profile) {
    const message =
      scanState === "failed"
        ? `Praxis could not read your history: ${scanNote}`
        : "Reading your Claude Code history…";
    return Box({ flexDirection: "column", children: [line(message)] });
  }

  const { totals, rhythm, projects, topActions, archetype, moves, ruleReady, almost, facts } =
    profile;
  if (totals.toolCalls === 0) {
    return Box({
      flexDirection: "column",
      children: [
        line("No Claude Code history yet. Work with Claude for a while, then run /praxis again."),
      ],
    });
  }

  const children = [
    Text({ dimColor: true, children: ["PRAXIS · what your Claude Code history says about you"] }),
    gap(),
    Text({ bold: true, color: "cyan", children: [archetype.name.toUpperCase()] }),
    line(archetype.tagline),
  ];
  if (witty?.text) children.push(line(`“${witty.text}”`, { italic: true }));
  children.push(
    gap(),
    line(
      `${num(totals.sessions)} sessions · ${num(totals.toolCalls)} actions · ${num(totals.activeDays)} active days · ${totals.longestStreak}-day best streak`,
    ),
    line(`Busiest: ${rhythm.busiestWeekday} around ${rhythm.busiestHour}`),
  );
  if (projects.length) {
    children.push(
      line(`Projects: ${projects.map((p) => `${p.name} ${pct(p.share)}`).join(" · ")}`),
    );
  }
  if (topActions.length) {
    children.push(
      line(`Claude mostly: ${topActions.map((a) => `${a.phrase} ${pct(a.share)}`).join(" · ")}`),
    );
  }

  // Buttons sit near the top: an autofocused button below the fold scrolls the pane to the bottom
  // on open, hiding the archetype.
  children.push(
    gap(),
    Box({
      flexDirection: "row",
      columnGap: 3,
      children: [
        Button({
          key: "copy",
          label: "Copy share card",
          hotkey: "c",
          plain: true,
          autoFocus: true,
          onPress: actions.copyCard,
        }),
        Button({
          key: "rescan",
          label: "Rescan",
          hotkey: "r",
          plain: true,
          onPress: actions.rescan,
        }),
        Text({ dimColor: true, children: ["Esc close"] }),
      ],
    }),
  );

  const section = (title, items) => {
    if (!items.length) return;
    children.push(gap(), rule(), heading(title));
    for (const item of items) {
      children.push(
        Box({
          flexDirection: "row",
          columnGap: 2,
          children: [
            Text({ children: [`  ${item.sentence}`] }),
            Text({ dimColor: true, children: [item.detail] }),
          ],
        }),
      );
    }
  };
  section("SIGNATURE MOVES", moves);
  section("RULE-READY HABITS  (strong enough to become a standing rule)", ruleReady);
  section("ALMOST HABITS  (what each one still needs)", almost);

  if (facts.length) {
    children.push(gap(), rule(), heading("FUN FACTS"));
    for (const fact of facts) children.push(line(`  · ${fact}`));
  }
  if (scanNote) children.push(gap(), Text({ dimColor: true, children: [scanNote] }));

  return Box({ flexDirection: "column", children });
}
