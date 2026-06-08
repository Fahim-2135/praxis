# Praxis

**Praxis is a behavioral-inference agent layered over Claude Code:** it logs every tool call on a
brutally minimal hot path, then mines the stream off-path for repeated `(action, context)` patterns.
A five-gate promotion engine — frequency, cross-session spread, consistency, recency, reversibility —
turns raw repetition into proposed automations, killing coincidence with pure arithmetic over a local
log. The model is never trained; an inspectable rule file steers it, and irreversible actions are
hard-blocked at the hook layer, never auto-run.

The key distinction: Praxis is **not** a note tool you fill in. It *infers* the rules you
never stated. You don't tell it "I always push after tests pass" — it notices.

> **Status:** Stages 1–3 of 5 complete (the hot path, the detection engine, and the `praxis
> review` approval loop). Feedback injection and self-pruning are built in later stages — see
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
                                                  │ reads (only when new events exist)
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

Every gate is pure arithmetic over the local log. No model call, no network, no cost. (One pattern is
ineligible regardless of its counts: an `unmatched` action — an unrecognized command — can't become a
rule, so it's never promoted; its volume is instead a signal to add a *normalization* rule.)

The build order calls this a "detection subagent," but there is deliberately **no model in it**.
A non-deterministic judge would map the same log to different rules on different runs, fragmenting
the counts the gates depend on and destroying the inspectability the system promises. Detection is
plain arithmetic on purpose.

### Calibration is part of the design, not a one-time setup

Thresholds start as guesses and are tuned against *real* logged behavior — never invented in the
abstract (the spec forbids tuning against imagined data). `npm run detect` runs the engine
read-only and prints both the survivors and the **near-misses with the exact gate each died at**,
which is what makes a threshold falsifiable.

The first calibration run over this repo's own Stage-1 log is illustrative: **zero candidates** from
four sessions of activity. The two highest-volume patterns — `file_edit` after `file_edit` (27×) and
`file_read` after `file_read` (16×) — are bursts of editing and reading *within* a session, and Gate 2
(cross-session spread) correctly refuses to mistake them for habits. Everything else falls at Gate 1
(frequency). That is the engine working: with little cross-session history, the honest answer is to
propose nothing rather than manufacture a rule. Real candidates emerge only once a behavior actually
recurs *across* sessions.

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
| `last_processed` | Read cursor (count of analyzed records) marking where the last detection pass ended. |
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

Run the detection engine over the log to see candidates and near-misses (read-only; the cold-path
hook does this automatically at session boundaries). Pass `--write` to persist `candidates.json`:

```bash
npm run detect
```

Review the proposed candidates and decide which become rules. Each is shown with its tier and
evidence; approve (`a`) writes it to `active-rules.md`, reject (`r`) remembers it in `rejected.json`
so it's never proposed again, skip (`s`) leaves it pending, quit (`q`) stops:

```bash
npm run review                      # interactive approval loop
node bin/praxis.mjs review --list   # read-only: list pending candidates and active rules
```

Approved rules are written as plain markdown you can open and read — prose for you and the model,
with a machine-readable marker under each rule so later stages can parse them back:

```markdown
## `git_push` after `test_run`  ·  consequential

When `test_run` just happened, you have repeatedly done `git_push` next (seen 6× across 3 sessions,
86% consistent, last 2026-06-08…). It is recoverable but not trivial, so offer it and act only on
explicit confirmation.

<!-- praxis:rule {"action":"git_push","preceding_event":"test_run","tier":"consequential",…} -->
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
2. **Detection + 5 gates** ✅ — the promotion engine + cursor-idempotent cold path, run over the real
   Stage-1 log.
3. **`praxis review` + write-back** ✅ — the approval loop: candidates → `active-rules.md` /
   `rejected.json`, with decided patterns never re-proposed.
4. **Feedback hook** — SessionStart injects `active-rules.md`; the loop closes.
5. **Self-pruning** — recency re-validation retires stale rules.

See [`PRAXIS.md`](PRAXIS.md) for the full specification and [`docs/architecture.md`](docs/architecture.md)
for the system as actually built.

---

## License

[MIT](LICENSE)
