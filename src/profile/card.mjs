// Pure text renderings of a profile: the share card a person pastes into a post, the one line
// the mod shows above the prompt, and the request behind the optional one-line AI roast.
//
// Kept apart from the mod so every word a person might post is unit-tested, and so the same
// card can be produced from the command line.

const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
const num = (n) => Number(n ?? 0).toLocaleString("en-US");

/** Where people find Praxis, printed at the bottom of every shared card. */
export const PRAXIS_URL = "github.com/Fahim-2135/praxis";

/**
 * The card a person copies and posts. Plain text with a few emoji, so it survives LinkedIn, X,
 * Slack and a terminal alike. Project and file names are left out: a card is meant to be public.
 * @param {import("./profile.mjs").Profile} profile
 * @param {{ witty?: string }} [options]
 * @returns {string}
 */
export function shareCard(profile, options = {}) {
  const { totals, rhythm, archetype, moves, topActions } = profile;
  const lines = [
    "My Claude Code habits, read by Praxis",
    "",
    `🏷️ ${archetype.name}`,
    archetype.tagline,
  ];
  if (options.witty) lines.push(`“${options.witty}”`);
  lines.push(
    "",
    `📊 ${num(totals.sessions)} sessions · ${num(totals.toolCalls)} actions · ${num(totals.activeDays)} active days`,
  );
  if (rhythm.busiestWeekday)
    lines.push(`🕐 Busiest: ${rhythm.busiestWeekday} around ${rhythm.busiestHour}`);
  if (totals.longestStreak > 1)
    lines.push(`🔥 Longest streak: ${totals.longestStreak} days in a row`);
  if (topActions?.length) {
    lines.push(
      `🛠️ Claude mostly: ${topActions.map((a) => `${a.phrase} ${pct(a.share)}`).join(" · ")}`,
    );
  }
  if (moves.length) lines.push(`🔁 Signature move: ${moves[0].sentence}`);
  lines.push("", `What's yours? ${PRAXIS_URL}`);
  return lines.join("\n");
}

/**
 * The single line shown above the prompt. It names the habit Praxis is closest to promoting,
 * when there is one, because a near-miss is what makes the learning visible; otherwise it shows
 * the archetype as a reminder that the profile exists.
 * @param {import("./profile.mjs").Profile} profile
 * @returns {string}
 */
export function bandText(profile) {
  const [closest] = profile.almost;
  if (closest) return `praxis · watching: ${closest.sentence} (${closest.detail}) · /praxis`;
  return `praxis · ${profile.archetype.name} · ${num(profile.totals.sessions)} sessions learned · /praxis`;
}

/**
 * The request for one short, kind roast of the profile. Only aggregate numbers are sent — no
 * project, file, or connector names — and the call runs on the person's own Claude plan.
 * @param {import("./profile.mjs").Profile} profile
 * @returns {{ system: string, prompt: string }}
 */
export function wittyRequest(profile) {
  const { totals, rhythm, archetype, topActions } = profile;
  const facts = [
    `Archetype: ${archetype.name} (${archetype.tagline})`,
    `${totals.sessions} sessions, ${totals.toolCalls} actions, ${totals.activeDays} active days, longest streak ${totals.longestStreak} days`,
    `Busiest: ${rhythm.busiestWeekday} around ${rhythm.busiestHour}; ${pct(rhythm.nightShare)} of work between 10 PM and 5 AM`,
    `Claude mostly: ${(topActions ?? []).map((a) => `${a.phrase} ${pct(a.share)}`).join(", ")}`,
    `Stopped Claude mid-answer ${totals.interrupts} times out of ${totals.prompts} prompts`,
  ];
  return {
    system:
      "You write one-line captions for a developer's coding-habits card. Warm, witty, specific to the numbers, never mean. One sentence, at most 18 words, no hashtags, no emoji, no quotation marks.",
    prompt: facts.join("\n"),
  };
}

/**
 * Clean a model reply into a caption: first line, no wrapping quotes, bounded length.
 * @param {string} text
 * @returns {string | null}
 */
export function cleanWitty(text) {
  const line = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const unquoted = line.replace(/^["“'”]+|["“'”]+$/g, "").trim();
  return unquoted.length > 160 ? `${unquoted.slice(0, 157)}…` : unquoted;
}
