// Pure "how you work with Claude" profile: the model behind the Praxis 2 reveal.
//
// The strict promotion engine (src/detect.mjs) answers one narrow question: which habits are
// consistent enough to become standing rules. On real histories that bar is rarely met, and it
// should stay that way, because a rule acts on your behalf. The profile answers the broader,
// lower-stakes question a new user asks first: "what does my history say about how I work?"
// It reports facts (counts, times, ratios) and tendencies, and labels which is which. Only
// patterns that clear all five gates are ever called rule-ready.
//
// No I/O, no model, no clock unless one is passed in: the same history always yields the same
// profile, so it is unit-tested directly and the Node scanner and the mod can share it.

import { detect } from "../detect.mjs";
import { buildStatus } from "../status/status.mjs";

const MS_PER_DAY = 86_400_000;

/** Below this share, a consistency near-miss is too far from the 80% bar to call "almost". */
const ALMOST_CONSISTENCY = 0.5;
const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

/** Actions that mean "looking" rather than "changing": the read side of the read-to-edit ratio. */
const LOOK_ACTIONS = new Set([
  "file_read",
  "file_search",
  "list_dir",
  "git_log",
  "git_diff",
  "git_status",
]);

/** Plain-English names for action labels, for every sentence the profile shows a person. */
const ACTION_PHRASES = Object.freeze({
  file_read: "reading files",
  file_edit: "editing files",
  file_search: "searching the code",
  file_manage: "moving and creating files",
  list_dir: "listing folders",
  script_run: "running scripts",
  test_run: "running tests",
  build_run: "building",
  lint_run: "type-checking and linting",
  format_run: "formatting",
  install_run: "installing packages",
  git_status: "checking git status",
  git_log: "reading the git log",
  git_diff: "reviewing diffs",
  git_add: "staging changes",
  git_commit: "committing",
  git_push: "pushing",
  git_pull: "getting the latest code",
  git_checkout: "switching branches",
  web_search: "searching the web",
  web_fetch: "fetching web pages",
  subagent_run: "sending out subagents",
  mcp_call: "using connected apps",
  ask_user: "asking you a question",
  skill_run: "running skills",
  todo_update: "updating the task list",
});

/**
 * Plain-English phrase for an action label.
 * @param {string} action
 * @returns {string}
 */
export function describeAction(action) {
  return ACTION_PHRASES[action] ?? action.replace(/_/g, " ");
}

/**
 * Archetypes, checked against the profile's ratios. Each fires when its signal reaches its bar;
 * the one furthest past its bar wins. Bars are set so an ordinary history fires at most one or
 * two, and every tagline quotes the person's own number, so the label is always earned.
 */
const ARCHETYPES = [
  {
    name: "The Night Owl",
    signal: (s) => s.nightShare,
    bar: 0.3,
    tagline: (s) => `${pct(s.nightShare)} of your work with Claude happens between 10 PM and 5 AM.`,
  },
  {
    name: "The Careful Reader",
    signal: (s) => s.lookPerEdit,
    bar: 2.5,
    tagline: (s) => `Claude looks around ${fixed(s.lookPerEdit)} times for every change it makes.`,
  },
  {
    name: "The Speed Runner",
    signal: (s) => (s.lookPerEdit > 0 ? 1 / s.lookPerEdit : 0),
    bar: 1.25,
    tagline: (s) => `Claude changes more than it reads: ${fixed(s.lookPerEdit)} looks per edit.`,
  },
  {
    name: "The Tinkerer",
    signal: (s) => s.share.script_run ?? 0,
    bar: 0.1,
    tagline: (s) =>
      `${pct(s.share.script_run)} of everything Claude does for you is running a script to try something.`,
  },
  {
    name: "The Delegator",
    signal: (s) => s.share.subagent_run ?? 0,
    bar: 0.03,
    tagline: (s) => `You sent out ${s.counts.subagent_run} subagents to work in parallel.`,
  },
  {
    name: "The Researcher",
    signal: (s) => (s.share.web_search ?? 0) + (s.share.web_fetch ?? 0),
    bar: 0.05,
    tagline: (s) =>
      `Claude went to the web ${(s.counts.web_search ?? 0) + (s.counts.web_fetch ?? 0)} times on your behalf.`,
  },
  {
    name: "The Conductor",
    signal: (s) => s.share.mcp_call ?? 0,
    bar: 0.04,
    tagline: (s) => `You run other apps through Claude: ${s.counts.mcp_call} connector calls.`,
  },
  {
    name: "The Shipper",
    signal: (s) => (s.share.git_push ?? 0) + (s.share.git_commit ?? 0),
    bar: 0.02,
    tagline: (s) =>
      `${(s.counts.git_push ?? 0) + (s.counts.git_commit ?? 0)} commits and pushes. You don't sit on work.`,
  },
  {
    name: "The Backseat Driver",
    signal: (s) => s.interruptRate,
    bar: 0.15,
    tagline: (s) => `You stopped Claude mid-answer ${s.interrupts} times. You know what you want.`,
  },
];

/** Fallback when no archetype's signal reaches its bar. */
const DEFAULT_ARCHETYPE = {
  name: "The Builder",
  tagline: (s) =>
    `A steady ${fixed(s.callsPerSession)} actions per session, across ${s.projectCount} projects.`,
};

const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const fixed = (x) => (Math.round((x ?? 0) * 10) / 10).toString();

/** Increment a counter in a Map. */
function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Map entries sorted by count, most first, ties by key for stable output. */
function ranked(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

/**
 * Local calendar fields of an ISO timestamp, given a fixed UTC offset. Taking the offset as a
 * parameter keeps the profile deterministic in tests and independent of the host's time zone.
 * @param {string} iso
 * @param {number} offsetMinutes
 */
function localTime(iso, offsetMinutes) {
  const d = new Date(Date.parse(iso) + offsetMinutes * 60_000);
  return { hour: d.getUTCHours(), weekday: d.getUTCDay(), day: d.toISOString().slice(0, 10) };
}

/**
 * Longest run of consecutive calendar days in a set of `YYYY-MM-DD` strings.
 * @param {Set<string>} days
 * @returns {number}
 */
function longestStreak(days) {
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const day of sorted) {
    const t = Date.parse(day);
    run = prev !== null && t - prev === MS_PER_DAY ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

/** "11 PM", "12 AM", "3 PM". */
function hourLabel(hour) {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * Signature moves: pairs "after A, Claude does B" that happen far more often than B's base rate
 * would predict. They are tendencies, not rules, so the bar is support plus lift rather than the
 * engine's 80% consistency. Self-repeats and unrecognized actions are excluded: "reads after
 * reading" is not a move, and an unlabelled action cannot be described.
 * @param {object[]} records
 * @param {{ minCount?: number, minSessions?: number, minLift?: number, limit?: number }} [options]
 */
export function signatureMoves(records, options = {}) {
  const { minCount = 5, minSessions = 3, minLift = 2, limit = 3 } = options;
  const total = records.length;
  if (total === 0) return [];

  const actionTotals = new Map();
  const contextTotals = new Map();
  const pairs = new Map();
  for (const r of records) {
    bump(actionTotals, r.action);
    bump(contextTotals, r.preceding_event);
    const key = `${r.preceding_event}|${r.action}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { after: r.preceding_event, action: r.action, count: 0, sessions: new Set() };
      pairs.set(key, pair);
    }
    pair.count += 1;
    pair.sessions.add(r.session_id);
  }

  const moves = [];
  for (const pair of pairs.values()) {
    if (pair.after === pair.action) continue;
    if (
      pair.after === "session_start" ||
      pair.after === "unmatched" ||
      pair.action === "unmatched"
    ) {
      continue;
    }
    if (pair.count < minCount || pair.sessions.size < minSessions) continue;
    const rate = pair.count / contextTotals.get(pair.after);
    const lift = rate / (actionTotals.get(pair.action) / total);
    if (lift < minLift) continue;
    moves.push({
      after: pair.after,
      action: pair.action,
      count: pair.count,
      sessions: pair.sessions.size,
      lift: Math.round(lift * 10) / 10,
      sentence: `${describeAction(pair.after)} → ${describeAction(pair.action)}`,
      detail: `${pair.count} times, ${Math.round(lift)}× more than chance`,
    });
  }
  return moves.sort((a, b) => b.lift * b.count - a.lift * a.count).slice(0, limit);
}

/**
 * @typedef {object} Profile
 * @property {object} totals
 * @property {object} rhythm
 * @property {Array<{ name: string, share: number }>} projects
 * @property {{ name: string, tagline: string }} archetype
 * @property {object[]} moves              Signature moves (tendencies).
 * @property {object[]} ruleReady          Patterns that cleared all five gates.
 * @property {object[]} almost             Near-misses, with what each still needs.
 * @property {string[]} facts              Short, shareable lines.
 * @property {object} signals              The ratios the archetype was chosen from.
 */

/**
 * Build the profile from a decoded history.
 * @param {{ records: object[], prompts?: Array<{ session_id: string, timestamp: string, interrupted: boolean }> }} history
 * @param {{ now?: string | number | Date, utcOffsetMinutes?: number }} [options]
 * @returns {Profile}
 */
export function buildProfile(history, options = {}) {
  const records = history.records ?? [];
  const prompts = history.prompts ?? [];
  const offset = options.utcOffsetMinutes ?? 0;

  const counts = new Map();
  const projects = new Map();
  const files = new Map();
  const models = new Map();
  const connectors = new Map();
  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  const days = new Set();
  const sessions = new Set();
  let night = 0;
  let look = 0;
  let edit = 0;

  for (const r of records) {
    bump(counts, r.action);
    if (r.project) bump(projects, r.project);
    if (r.file) bump(files, r.file);
    if (r.model) bump(models, r.model);
    if (r.action === "mcp_call" && r.raw) bump(connectors, r.raw);
    sessions.add(r.session_id);
    if (LOOK_ACTIONS.has(r.action)) look += 1;
    if (r.action === "file_edit") edit += 1;

    const t = localTime(r.timestamp, offset);
    hours[t.hour] += 1;
    weekdays[t.weekday] += 1;
    days.add(t.day);
    if (t.hour >= 22 || t.hour < 5) night += 1;
  }

  const typed = prompts.filter((p) => !p.interrupted);
  const interrupts = prompts.length - typed.length;
  const total = records.length;
  const stamps = records.map((r) => r.timestamp).sort();

  const share = {};
  const countsObj = {};
  for (const [action, n] of counts) {
    share[action] = total ? n / total : 0;
    countsObj[action] = n;
  }

  const signals = {
    counts: countsObj,
    share,
    nightShare: total ? night / total : 0,
    lookPerEdit: edit ? look / edit : look,
    interrupts,
    interruptRate: typed.length ? interrupts / typed.length : 0,
    callsPerSession: sessions.size ? total / sessions.size : 0,
    projectCount: projects.size,
  };

  const archetype = pickArchetype(signals, total);
  const busiestHour = hours.indexOf(Math.max(...hours));
  const busiestWeekday = weekdays.indexOf(Math.max(...weekdays));

  const { candidates } = detect(records, { now: options.now });
  const status = buildStatus(records, {}, { now: options.now });

  const profile = {
    totals: {
      sessions: sessions.size,
      toolCalls: total,
      prompts: typed.length,
      interrupts,
      activeDays: days.size,
      longestStreak: longestStreak(days),
      firstSeen: stamps[0] ?? null,
      lastSeen: stamps[stamps.length - 1] ?? null,
    },
    rhythm: {
      busiestHour: total ? hourLabel(busiestHour) : null,
      busiestWeekday: total ? WEEKDAYS[busiestWeekday] : null,
      nightShare: signals.nightShare,
    },
    projects: ranked(projects)
      .slice(0, 3)
      .map(([name, n]) => ({ name, share: n / total })),
    topActions: ranked(counts)
      .filter(([action]) => action !== "unmatched")
      .slice(0, 3)
      .map(([action, n]) => ({ action, phrase: describeAction(action), share: n / total })),
    archetype,
    moves: signatureMoves(records),
    // A self-repeat ("connected apps after connected apps") clears the gates easily and makes a
    // useless rule, so the profile only calls a pattern rule-ready when it links two actions.
    ruleReady: candidates
      .filter((c) => c.action !== c.preceding_event)
      .map((c) => ({
        ...c,
        sentence: `${describeAction(c.preceding_event)} → ${describeAction(c.action)}`,
        detail: `${pct(c.evidence.consistency)} of the time, across ${c.evidence.sessions} sessions`,
      })),
    // "Almost" has to mean close: a pattern far below the consistency bar is not one session
    // away from anything, so those are left out rather than shown as near-misses.
    almost: status.almostRules
      .filter(
        (a) =>
          a.action !== a.preceding_event &&
          a.preceding_event !== "unmatched" &&
          a.preceding_event !== "session_start" &&
          (a.failedGate !== "consistency" || a.evidence.consistency >= ALMOST_CONSISTENCY),
      )
      .slice(0, 3)
      .map((a) => ({
        ...a,
        sentence: `${describeAction(a.preceding_event)} → ${describeAction(a.action)}`,
        detail: a.gap,
      })),
    facts: buildFacts({ files, models, connectors, interrupts, total }),
    signals,
  };
  return profile;
}

/**
 * Pick the archetype whose signal is furthest past its bar.
 * @param {object} signals
 * @param {number} total
 * @returns {{ name: string, tagline: string }}
 */
function pickArchetype(signals, total) {
  if (total === 0)
    return { name: "The Newcomer", tagline: "No history yet. Work with Claude and check back." };
  let best = null;
  let bestScore = 1;
  for (const a of ARCHETYPES) {
    const score = a.signal(signals) / a.bar;
    if (score >= bestScore) {
      best = a;
      bestScore = score;
    }
  }
  const chosen = best ?? DEFAULT_ARCHETYPE;
  return { name: chosen.name, tagline: chosen.tagline(signals) };
}

/**
 * Short, shareable lines. Each is included only when its number is there to back it.
 * File and connector names are base names only (see src/history/transcript.mjs).
 */
function buildFacts({ files, models, connectors, interrupts, total }) {
  const facts = [];
  const [topFile] = ranked(files);
  if (topFile && topFile[1] >= 5)
    facts.push(`Most-touched file: ${topFile[0]} (${topFile[1]} times).`);
  const [topConnector] = ranked(connectors);
  if (topConnector && topConnector[1] >= 3) {
    facts.push(
      `Favourite connected app: ${prettyConnector(topConnector[0])} (${topConnector[1]} calls).`,
    );
  }
  const [topModel] = ranked(models);
  if (topModel && total) {
    facts.push(`${prettyModel(topModel[0])} did ${pct(topModel[1] / total)} of the work.`);
  }
  if (interrupts > 0) facts.push(`You stopped Claude mid-answer ${interrupts} times.`);
  return facts;
}

/** `claude_ai_Gmail` -> `Gmail`, `claude-in-chrome` -> `chrome`: the server's own name. */
export function prettyConnector(server) {
  return String(server)
    .replace(/^claude[_-](?:ai[_-]|in[_-])?/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

/** `claude-opus-5-5` -> `Opus 5.5`; unknown ids pass through unchanged. */
export function prettyModel(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(String(id));
  if (!m) return String(id);
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return m[3] && m[3].length <= 2 ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`;
}
