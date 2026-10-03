import { test } from "node:test";
import assert from "node:assert/strict";
import { shareCard, bandText, wittyRequest, cleanWitty, PRAXIS_URL } from "../src/profile/card.mjs";

const profile = {
  totals: {
    sessions: 80,
    toolCalls: 4994,
    prompts: 653,
    interrupts: 16,
    activeDays: 42,
    longestStreak: 12,
  },
  rhythm: { busiestHour: "11 PM", busiestWeekday: "Saturdays", nightShare: 0.4 },
  projects: [{ name: "secret-client-project", share: 0.5 }],
  topActions: [
    { action: "file_read", phrase: "reading files", share: 0.27 },
    { action: "file_edit", phrase: "editing files", share: 0.24 },
  ],
  archetype: {
    name: "The Night Owl",
    tagline: "40% of your work with Claude happens between 10 PM and 5 AM.",
  },
  moves: [{ sentence: "checking git status → reading the git log", detail: "9 times" }],
  ruleReady: [],
  almost: [],
  facts: ["Most-touched file: main.js (82 times)."],
};

test("the share card carries the archetype, the numbers, and the link", () => {
  const card = shareCard(profile);
  assert.match(card, /The Night Owl/);
  assert.match(card, /80 sessions · 4,994 actions · 42 active days/);
  assert.match(card, /Busiest: Saturdays around 11 PM/);
  assert.match(card, /12 days in a row/);
  assert.match(card, /Signature move: checking git status → reading the git log/);
  assert.ok(card.trimEnd().endsWith(PRAXIS_URL));
});

test("the share card never includes project or file names", () => {
  const card = shareCard(profile);
  assert.ok(!card.includes("secret-client-project"));
  assert.ok(!card.includes("main.js"));
});

test("the caption is added only when there is one", () => {
  assert.match(shareCard(profile, { witty: "Sleep is optional." }), /“Sleep is optional\.”/);
  assert.ok(!shareCard(profile).includes("“"));
});

test("the band line prefers the closest near-miss, else the archetype", () => {
  assert.equal(bandText(profile), "praxis · The Night Owl · 80 sessions learned · /praxis");
  const watching = bandText({
    ...profile,
    almost: [{ sentence: "running tests → pushing", detail: "1 more session to qualify" }],
  });
  assert.equal(
    watching,
    "praxis · watching: running tests → pushing (1 more session to qualify) · /praxis",
  );
});

test("the caption request sends numbers, not names", () => {
  const { system, prompt } = wittyRequest(profile);
  assert.match(system, /one sentence/i);
  assert.match(prompt, /The Night Owl/);
  assert.ok(!prompt.includes("secret-client-project"));
  assert.ok(!prompt.includes("main.js"));
});

test("cleanWitty keeps one unquoted, bounded line", () => {
  assert.equal(cleanWitty('"Sleep is for the weak."\nSecond line'), "Sleep is for the weak.");
  assert.equal(cleanWitty("   \n  "), null);
  assert.equal(cleanWitty("x".repeat(400)).length, 158);
});
