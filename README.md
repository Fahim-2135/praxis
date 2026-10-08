# Praxis

**Your AI already watches you work. Praxis makes it _learn your habits_ — and act on them, with your permission, never behind your back.**

[![CI](https://github.com/Fahim-2135/praxis/actions/workflows/ci.yml/badge.svg)](https://github.com/Fahim-2135/praxis/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a) ![dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen) ![license](https://img.shields.io/badge/license-MIT-blue)

Praxis is a behavioral-inference agent for [Claude Code](https://claude.com/claude-code). Since 0.2 it is a **Claude Code mod**: it runs inside Claude Code in every project, reads the session history Claude Code already keeps, and shows you what that history says about how you work — seconds after you install it. It mines the same history for repeated `(action, context)` patterns, and only a habit that proves itself across sessions is ever offered as a rule. The model is never trained. Irreversible commands are held for your explicit go-ahead.

The distinction that matters: **Praxis is not a notes tool you fill in. It _infers_ the rules you never stated.** You don't tell it "I always push after tests pass" — it notices, counts, and asks.

---

## Install (Claude Code 2.1.287 or later)

```text
/plugin marketplace add Fahim-2135/praxis
/plugin install praxis@praxis
```

Then type `/praxis`. To try it from a clone without installing: `claude --plugin-dir ./praxis`.

Node.js ≥ 20 is recommended: Praxis uses it to read very long sessions. Without it, the mod still works and skips transcripts over 4 MB.

| Command | What it does |
|---------|--------------|
| `/praxis` | Opens your profile. `c` copies a share card, `r` rescans, `1`-`9` make a rule-ready habit a rule. |
| `/praxis share` | Copies the share card straight to your clipboard. |
| `/praxis quiet` · `/praxis loud` | Hides or shows the one-line "watching" note above the prompt. |
| `/praxis rescan` | Re-reads your history now (it also refreshes after each answer). |

---

## See it

The first time Praxis finishes reading your history, it says so — _"Praxis read 81 of your sessions. Type /praxis to see what they say about you."_ This is the share card it produced from its author's own history (real output, not a mock-up):

```text
My Claude Code habits, read by Praxis

🏷️ The Night Owl
40% of your work with Claude happens between 10 PM and 5 AM.

📊 81 sessions · 5,029 actions · 42 active days
🕐 Busiest: Saturdays around 11 PM
🔥 Longest streak: 12 days in a row
🛠️ Claude mostly: reading files 27% · editing files 24% · running scripts 13%
🔁 Signature move: checking git status → reading the git log

What's yours? github.com/Fahim-2135/praxis
```

The `/praxis` pane adds what the card leaves out: your top projects, **signature moves** (what Claude does next far more often than chance), any **rule-ready habits** that cleared all five gates (each with a **Make it a rule** button), the **almost habits** with exactly what each still needs, and a few facts — your most-touched file, your favourite connected app, how often you stop Claude mid-answer. While you work, one dim line above the prompt names the habit Praxis is closest to learning.

**Make it a rule.** Press it on a rule-ready habit ("getting the latest code → running tests") and from then on Praxis does the next step for you: right after Claude gets the latest code, it runs the tests without being asked. What a rule may do follows the step's reversibility: safe steps (tests, formatting) happen by themselves, recoverable ones (commit, push) are asked about first, irreversible ones are only ever suggested. Your rules are listed under **YOUR RULES**, each with **Turn off**.

### What Praxis 2 reads, and what it never keeps

- **Source:** the transcripts Claude Code writes to `~/.claude/projects/`. Praxis adds no logging of its own and nothing to each tool call.
- **Kept:** each tool call reduced to its action label (`git_push`, `file_read`…), its time, session, project folder name, file _base name_, and model. A shell command Praxis does not recognize is kept as its first word only — arguments, where paths and tokens live, are dropped before anything is stored.
- **Stored at:** `~/.claude/praxis/` on your machine. Nothing is uploaded.
- **The one optional network call:** opening the pane asks Haiku, on your own Claude plan, for a one-line caption. It is sent aggregate numbers only — no project, file, or app names.
- **The share card** contains no project or file names, so it is safe to post as-is.

### The `praxis status` CLI (classic, per-project)

Praxis 1's project-scoped hooks and CLI still work for the rule loop inside one repository (see [Setup](#setup)). _Example output — the numbers are illustrative, showing what the profile looks like once a few habits have cleared the gates:_

```text
$ praxis status
Praxis — what I've learned about your workflow

Observed 213 events across 7 sessions over 9 days, last 2026-06-09.

Your top habits:
     48  file_edit
     31  test_run
     22  git_push
     12  git_status
      9  lint_run

Active rules — I act on these for you (1):
  [consequential] git_push after test_run

Proposed — awaiting your review (1):
  [safe] lint_run after file_edit
        seen 7× across 4 sessions, 86% consistent, last 2026-06-09
  → run `praxis review` to approve or reject

Almost rules — habits I'm watching (2):
  git_commit after test_run
      seen 5× but in only 2 sessions — 1 more session to qualify
  git_status after git_push
      follows 71% of the time — needs 80%
```

That last section — **the habits it's _almost_ ready to suggest, and exactly what's missing** — is the moment the premise lands: it's watching, it's counting, and it's close.

---

## The honest mechanism (read this first)

It would be easy to imply Praxis "learns." It doesn't, and saying so plainly is the point.

**The model is never trained or fine-tuned.** The intelligence is a mechanical loop running _around_ the model:

```
log actions  ->  detect repetition  ->  write an inferred rule into the context the model reads next time
```

Everything stays inspectable. Approved rules live in a human-readable file you can open, edit, or delete — not in hidden automation. That transparency is a deliberate constraint, not a missing feature. A system that quietly acts on your behalf is one you can't trust; a system whose every rule you can read is one you can.

---

## Architecture

Four paths, two of them hard-separated by a strict latency boundary.

```
                          ┌─────────────────────────────────────────────┐
   every tool call        │  HOT PATH  (PostToolUse hook)                │
   ───────────────────────▶  normalize -> append one line -> exit        │
                          │  no model, no network, no lock. instant.     │
                          └───────────────────────┬─────────────────────┘
                                                  │ appends
                                                  ▼
                                          .praxis/log.jsonl
                                                  │ reads (only when new events exist)
                          ┌───────────────────────┴─────────────────────┐
   session start / end    │  COLD PATH  (SessionStart + SessionEnd)      │
   ───────────────────────▶  run the 5 gates -> write candidates;        │
                          │  re-validate active rules -> flag stale ones  │
                          │  may think; runs off the hot path.           │
                          └───────────────────────┬─────────────────────┘
                                                  │ proposes
                                                  ▼
                                       .praxis/candidates.json
                                                  │ approve / reject / retire
                          ┌───────────────────────┴─────────────────────┐
   `praxis review`        │  HUMAN PATH  (async, you decide)             │
   ───────────────────────▶  approve -> active-rules.md                  │
                          │  reject  -> rejected.json (never re-proposed)│
                          └───────────────────────┬─────────────────────┘
                                                  │ injects at next start
                                                  ▼
                          ┌─────────────────────────────────────────────┐
   SessionStart stdout    │  FEEDBACK PATH  (SessionStart hook)          │
   ───────────────────────▶  render active-rules.md -> stdout -> context │
                          │  the model now acts on approved rules.       │
                          └─────────────────────────────────────────────┘
```

`SessionStart` stdout is the one hook channel Claude Code injects into model context — that property _is_ the feedback mechanism. Praxis never automates your actions; it writes your approved rules into what the model reads, so the model _offers_ them, honoring each tier's confirmation rule. Orthogonal to these four learning paths is a **`PreToolUse` safety gate** ([Safety model](#safety-model)) that runs before each Bash call and forces confirmation on irreversible commands — a guard, not part of the loop, so it sits outside the diagram.

### Why the hot/cold split exists

The hot-path hook runs on **every single tool call**, so its latency is added to everything you do. It is therefore restricted to a brutally minimal job: classify the action with a fixed rule table and append one line. No model call, no network, no lock, no rewriting the file. All the expensive thinking — counting, scoring, validating — happens on the **cold path**, which fires only at session boundaries where a few hundred milliseconds cost nothing. Mixing the two would tax every keystroke to do work that can wait. Keeping them apart is the core engineering decision the whole system is built around.

---

## The promotion logic (the intellectual core)

A _pattern_ is an `(action, preceding_event)` pairing — not "you push" but "you push **after** tests pass." A pattern becomes a candidate rule only after clearing **five sequential gates**, each of which kills a specific kind of junk. (Thresholds are starting guesses, calibrated against real logged behavior — never invented in the abstract.)

| # | Gate | What it kills |
|---|------|---------------|
| 1 | **Frequency** — happened ≥ 5 times | One-offs and noise. |
| 2 | **Cross-session spread** — across ≥ 3 distinct sessions | "Did it 5× in one stuck session" masquerading as a habit. _(The most important gate.)_ |
| 3 | **Consistency** — followed ≥ 80% of the times its context occurred | Coincidence. Counts the denominator, not just the hits. |
| 4 | **Recency** — at least once in the last 5 days | Stale habits you've already dropped. |
| 5 | **Safety classification** — sorts the action into a reversibility tier | Nothing — it classifies rather than rejects, governing how the rule may _behave_. |

Every gate is pure arithmetic over the local log. No model call, no network, no cost. (An `unmatched` action — an unrecognized command — can't become a rule, so it's never promoted; its volume is instead a signal to add a _normalization_ rule.)

The build order calls this a "detection subagent," but there is deliberately **no model in it.** A non-deterministic judge would map the same log to different rules on different runs, fragmenting the counts the gates depend on and destroying the inspectability the system promises. Detection is plain arithmetic on purpose.

### Calibration is part of the design

Thresholds start as guesses and are tuned against _real_ logged behavior — never invented (the spec forbids tuning against imagined data). `npm run detect` runs the engine read-only and prints both the survivors and the **near-misses with the exact gate each died at**, which is what makes a threshold falsifiable. The first calibration run over this repo's own log produced **zero candidates** from four sessions — and that's the engine working: with little cross-session history, the honest answer is to propose nothing rather than manufacture a rule.

### Self-pruning (the rulebook shrinks, not just grows)

A rule store that only accumulates decays — it ends up steering the model with habits you've abandoned. So each cold pass also **re-validates the active rules**: one unused beyond a longer horizon (14 days) is flagged for retirement in the next review. Two deliberate choices:

- **Asymmetric thresholds.** Promotion requires _current_ proof (5 days); retirement tolerates a normal lull (14 days). It should be hard to add a rule and forgiving to keep one — so the threshold is chosen from the cost of each error, not from symmetry.
- **Human-gated, like promotion.** The engine only _flags_; removal happens solely through `praxis review`. The engine proposes in both directions; you dispose.

---

## Safety model

Reversibility decides autonomy. Three tiers — and the strongest is enforced at the hook layer, not by convention:

| Tier | Examples | Allowed behavior |
|------|----------|------------------|
| **Safe / reversible** | run tests, format, `ls`, status | May eventually act with a soft confirm. |
| **Consequential / recoverable** | `git commit`, `git push` | Acts **only** with explicit confirmation, every time. Never silent. |
| **Destructive / irreversible** | force push, delete, external sends | **Never auto-executes** — a `PreToolUse` gate forces explicit confirmation before it can run. |

The irreversible gate is a `PreToolUse` hook ([`src/safety.mjs`](src/safety.mjs) + [`src/hooks/pre-tool-use.mjs`](src/hooks/pre-tool-use.mjs)) that returns an **`ask`** permission decision: Claude Code must get your explicit confirmation before the command runs. The guarantee holds even if a rule is buggy or malicious, because the gate sits at the hook layer — _below_ the rules — so an irreversible action can never auto-execute. It recognizes the dangerous command directly on its raw text (force-push, recursive/forced `rm`, disk overwrites, external sends), because the learning normalizer deliberately discards exactly the flags that make a command dangerous. Coverage is conservative and extensible; because the decision is "ask," erring toward flagging costs a keystroke, never an accident.

In the mod, the same recognizer runs in-process on every Bash and PowerShell call in every project: a `tool.call` hook holds a matching command and asks you, in Claude Code's own question dialog, whether to run it. If nobody is there to answer (a `claude -p` run), the answer is no, and Claude is told why.

---

## Commands

```bash
npm run status     # what Praxis has learned about your workflow (start here)
npm run review     # approve / reject candidates; retire stale rules
npm run detect     # run the engine read-only: candidates + near-misses + thresholds
npm run inspect    # raw log summary + the unmatched pile
npm run demo       # drive the real hook over a synthetic workday (touches no real state)
npm test           # the full suite (Node's built-in runner, no install)
```

The `praxis` binary backs these directly: `praxis status`, `praxis review`, `praxis review --list` (read-only), `praxis help`.

---

## State files

All system state lives under `.praxis/` in the project root (and is git-ignored — it's your personal behavioral data).

| File | Contents |
|------|----------|
| `log.jsonl` | Append-only raw event stream, one normalized event per line. |
| `last_processed` | Read cursor (count of analyzed records) marking where the last detection pass ended. |
| `candidates.json` | Patterns that cleared all gates, awaiting approval, plus active rules flagged stale for retirement. Affects nothing. |
| `active-rules.md` | Approved rules **only** — the single human-readable file injected into context. |
| `rejected.json` | Declined patterns, so they're never re-proposed. |

Candidates and active rules live apart on purpose: a pending proposal can never accidentally act. (Two implementation files also live under `.praxis/`: `sessions/<id>.last`, a per-session marker for reconstructing `preceding_event` without scanning the log, and `errors.log`, a best-effort record of any hook failure.)

### Log record schema

```json
{ "action": "git_push", "preceding_event": "test_run", "timestamp": "2026-06-07T14:03:22.171Z", "session_id": "abc123" }
```

- **`action`** — normalized _intent_, not the raw command. `git push`, `git push origin main`, and aliases all collapse to one countable `git_push`.
- **`preceding_event`** — the previous action in the same session. "You push" is noise; "you push _after tests_" is a rule.
- **`session_id`** — separates "pushed 5× in one stuck session" (noise) from "pushed once at the end of 5 sessions" (habit).

Commands Praxis has no rule for yet are logged as `action: "unmatched"` with the raw text preserved — the unmatched pile is how we discover which rules to add next.

---

## Setup

**The mod (recommended):** see [Install](#install-claude-code-21287-or-later). It observes every project, starts from your existing history, and needs no per-project setup.

**The classic hooks (Praxis 1):** the original rule loop — logging, `praxis review`, and approved rules injected at session start — still runs as project-scoped settings hooks. Requires **Node.js ≥ 20** — and nothing else. Zero runtime dependencies.

1. Clone this repo and open Claude Code **inside it**.
2. The hooks are registered in [`.claude/settings.json`](.claude/settings.json) with paths relative to the repo root. Claude Code loads them at session start, so **restart your session** (or start a new one) to activate them.

> **Current scope:** because the hooks are project-scoped, Praxis observes the Claude Code sessions you run in this repository. Observing every project from one install (registering the hooks in user-level settings with absolute paths) is not supported yet.

3. Work normally. `.praxis/log.jsonl` fills with normalized events; at session boundaries the engine looks for habits.
4. Run `npm run status` to see what it's learned, and `npm run review` to approve what it proposes.

### Development

The runtime has zero dependencies; the only dev dependencies are ESLint and Prettier.

```bash
npm install        # dev tooling
npm run lint
npm run format
npm test           # 145 tests, Node's built-in runner
npm run test:mod   # 8 mod tests in Claude Code's own test kit (claude plugin test)
npm run validate   # Claude Code's static check of the mod (claude plugin validate .)
npm run history    # run the history scanner by hand; prints one JSON line
```

To work on the mod, run `claude --plugin-dir .` from the repo: Claude Code hot-reloads `hooks/praxis.mjs` on every save and writes type declarations for your exact version into `.claude-plugin/types/`.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint, the formatter check, and the Node suite on Node 20, 22, and 24 for every push and pull request.

---

## How it was built

Built strictly in stages — each stage's real output is the next stage's tuning input. The git history reads as a deliberate progression.

1. **Hot path** — PostToolUse logging, rule-based normalization, `log.jsonl`.
2. **Detection + 5 gates** — the promotion engine + cursor-idempotent cold path, calibrated on the real log.
3. **`praxis review` + write-back** — the approval loop; decided patterns never re-proposed.
4. **Feedback hook** — SessionStart injects `active-rules.md` into context; the loop closes.
5. **Self-pruning** — recency re-validation flags stale rules for retirement.
6. **Safety gate** — a `PreToolUse` hook forces confirmation on irreversible commands.
7. **`praxis status`** — the profile that makes the whole loop visible.
8. **Praxis 2, the mod** — rebuilt on Claude Code mods: reads existing transcripts instead of logging, so it works in every project from the first minute; the profile pane, share card, and the safety gate now run in-process.

The full specification is in [`PRAXIS.md`](PRAXIS.md); the system as actually built (with every deviation and its reason) is in [`docs/architecture.md`](docs/architecture.md). The reasoning behind each stage is captured in [`docs/learning-log.md`](docs/learning-log.md) and [`docs/teaching-log.md`](docs/teaching-log.md).

---

## License

[MIT](LICENSE)
