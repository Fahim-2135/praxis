# Praxis

**A behavioral pattern-learning agent that layers over Claude Code.** It watches how you
actually work, detects the action-and-context patterns you repeat, and proposes rules that
automate them — with your approval, and never for anything irreversible.

The key distinction: Praxis is **not** a note tool you fill in. It *infers* the rules you
never stated. You don't tell it "I always push after tests pass" — it notices.

> **Status:** Stage 1 of 5 complete (the hot path). The detection engine, review loop,
> feedback injection, and self-pruning are built in later stages — see
> [Build stages](#build-stages). This README grows with the build.

---

## The honest mechanism (read this first)

It would be easy to imply Praxis "learns." It does not, and saying so plainly is the point.

**The model is never trained or fine-tuned.** The intelligence is a mechanical loop running
*around* the model:

```
log actions  ->  detect repetition  ->  write an inferred rule into the context the model reads next time
```

Everything stays inspectable. Approved rules live in a human-readable file you can open, edit,
or delete — not in hidden automation. That transparency is a deliberate design constraint, not
a missing feature. A system that quietly acts on your behalf is one you can't trust; a system
whose every rule you can read is one you can.

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
                                                  │ reads (unprocessed only)
                          ┌───────────────────────┴─────────────────────┐
   session start / end    │  COLD PATH  (SessionStart + SessionEnd)      │
   ───────────────────────▶  run the 5 gates -> write candidates         │
                          │  may think; runs off the hot path.           │
                          └───────────────────────┬─────────────────────┘
                                                  │ proposes
                                                  ▼
                                       .praxis/candidates.json
                                                  │ approve / reject
                          ┌───────────────────────┴─────────────────────┐
   `praxis review`        │  HUMAN PATH  (async, you decide)             │
   ───────────────────────▶  approve -> active-rules.md                  │
                          │  reject  -> rejected.json (never re-proposed)│
                          └───────────────────────┬─────────────────────┘
                                                  │ injects at next start
                                                  ▼
                          ┌─────────────────────────────────────────────┐
   SessionStart stdout    │  FEEDBACK PATH                               │
   ───────────────────────▶  print active-rules.md into context         │
                          │  the model now acts on approved rules.       │
                          └─────────────────────────────────────────────┘
```

### Why the hot/cold split exists

The hot-path hook runs on **every single tool call**, so its latency is added to everything you
do. It is therefore restricted to a brutally minimal job: classify the action with a fixed rule
table and append one line to a log. No model call, no network, no lock, no rewriting the file.
All the expensive thinking — counting, scoring, validating — happens on the **cold path**, which
fires only at session boundaries where a few hundred milliseconds costs nothing. Mixing the two
would tax every keystroke to do work that can wait. Keeping them apart is the core engineering
decision the whole system is built around.

---

## The promotion logic (the intellectual core)

A *pattern* is an `(action, preceding_event)` pairing — not "you push" but "you push **after**
tests pass." A pattern becomes a candidate rule only after clearing **five sequential gates**,
each of which kills a specific kind of junk. (Thresholds are starting guesses, calibrated against
real logged behavior — never invented in the abstract.)

| # | Gate | What it kills |
|---|------|---------------|
| 1 | **Frequency** — happened ≥ 5 times | One-offs and noise. |
| 2 | **Cross-session spread** — across ≥ 3 distinct sessions | "Did it 5× in one stuck session" masquerading as a habit. *(The most important gate.)* |
| 3 | **Consistency** — followed ≥ 80% of the times its context occurred | Coincidence. Counts the denominator, not just the hits. |
| 4 | **Recency** — at least once in the last 5 days | Stale habits you've already dropped. |
| 5 | **Safety classification** — sorts the action into a reversibility tier | Nothing — it classifies rather than rejects, governing how the rule may *behave*. |

Every gate is pure arithmetic over the local log. No model call, no network, no cost.

---

## Safety model

Reversibility decides autonomy. Three tiers, enforced at the hook layer — not by convention:

| Tier | Examples | Allowed behavior |
|------|----------|------------------|
| **Safe / reversible** | run tests, format, `ls`, status | May eventually act with a soft confirm. |
| **Consequential / recoverable** | `git commit`, `git push` | Acts **only** with explicit confirmation, every time. Never silent. |
| **Destructive / irreversible** | force push, delete, external sends | **Never auto-executes.** Suggested only; hard-blocked at `PreToolUse`. |

The irreversible block is enforced by a `PreToolUse` hook that denies the call (exit code 2), so
the guarantee holds even if a rule is buggy or malicious. An irreversible action never runs itself.

---

## State files

All system state lives under `.praxis/` in the project root (and is git-ignored — it is your
personal behavioral data).

| File | Contents |
|------|----------|
| `log.jsonl` | Append-only raw event stream, one normalized event per line. |
| `last_processed` | Read cursor (line count) marking where the last detection pass ended. |
| `candidates.json` | Patterns that cleared all gates, awaiting your approval. Affects nothing. |
| `active-rules.md` | Approved rules **only** — the single human-readable file injected into context. |
| `rejected.json` | Declined patterns, so they are never re-proposed. |

Candidates and active rules live apart on purpose: a pending proposal can never accidentally act.

Two implementation files also live under `.praxis/`: `sessions/<id>.last`, a tiny per-session
marker used to reconstruct `preceding_event` without scanning the log, and `errors.log`, a
best-effort record of any hot-path failure (the hook always exits cleanly, so failures are noted
here rather than surfaced to the editor). See [`docs/architecture.md`](docs/architecture.md).

### Log record schema

```json
{ "action": "git_push", "preceding_event": "test_run", "timestamp": "2026-06-07T14:03:22.171Z", "session_id": "abc123" }
```

- **`action`** — normalized *intent*, not the raw command. `git push`, `git push origin main`,
  and aliases all collapse to one countable `git_push`.
- **`preceding_event`** — the previous action in the same session. "You push" is noise; "you push
  *after tests*" is a rule.
- **`timestamp`** — ISO 8601, for recency and ordering.
- **`session_id`** — separates "pushed 5× in one stuck session" (noise) from "pushed once at the
  end of 5 sessions" (habit).

Commands Praxis doesn't yet have a rule for are logged as `action: "unmatched"` with the raw text
preserved — the unmatched pile is how we discover which rules to add next.

---

## Setup

Requires **Node.js ≥ 18** (no other dependencies).

1. Clone into the project you want Praxis to observe (or use this repo directly).
2. The PostToolUse hook is registered in [`.claude/settings.json`](.claude/settings.json). Claude
   Code loads it at session start, so **restart your session** (or start a new one) to activate it.
3. That's it for Stage 1. As you work, `.praxis/log.jsonl` fills with normalized events.

Inspect what's been logged at any time (read-only — counts per action, plus the unmatched pile
that reveals which rules to add next):

```bash
npm run inspect
```

Run the tests (no install needed — the suite uses Node's built-in test runner):

```bash
npm test
```

### See it work

No setup or day of use required — `npm run demo` drives the real hook over a synthetic workday in a
throwaway directory and prints what it inferred:

```text
Logged events (action  <-  preceding_event   [session]):
  test_run                     <- file_search      [morning]
  git_push                     <- test_run         [morning]    # "git add && commit && push" -> terminal intent
  test_run                     <- session_start    [afternoon]  # "CI=1 npm test" -> prefix stripped
  unmatched: docker compose up -d <- git_status    [afternoon]  # surfaced as a rule candidate

Summary — 11 events across 3 sessions:
    3  git_push
    2  test_run
    ...
```

### Development

The runtime has zero dependencies; the only dev dependency is Prettier, for formatting.

```bash
npm install        # dev dependencies (ESLint, Prettier)
npm run lint       # correctness checks
npm run format     # format the code
npm test
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint, formatter check, and the test
suite on Node 18, 20, and 22 for every push and pull request.

---

## Build stages

Built strictly in order — each stage's real output is the next stage's tuning input.

1. **Hot path** ✅ — PostToolUse logging, rule-based normalization, `log.jsonl`, `last_processed`.
2. **Detection + 5 gates** — the promotion engine, run over the real Stage-1 log.
3. **`praxis review` + write-back** — the approval loop.
4. **Feedback hook** — SessionStart injects `active-rules.md`; the loop closes.
5. **Self-pruning** — recency re-validation retires stale rules.

See [`PRAXIS.md`](PRAXIS.md) for the full specification and [`docs/architecture.md`](docs/architecture.md)
for the system as actually built.

---

## License

[MIT](LICENSE)
