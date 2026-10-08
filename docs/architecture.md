# Architecture (as built)

This document tracks the system **as actually implemented**, stage by stage. Where reality
deviates from [`PRAXIS.md`](../PRAXIS.md), the deviation and its reason are recorded here.
`PRAXIS.md` is the spec (*what*); this is the build record (*what exists*).

---

## Stage 1 — Hot path (complete)

### What it does

A `PostToolUse` hook fires after every Claude Code tool call, classifies the call into a stable
`action` label with a deterministic rule table, and appends one JSON line to `.praxis/log.jsonl`.
This is the raw material every later stage consumes.

### Components

| Path | Responsibility |
|------|----------------|
| `.claude/settings.json` | Registers the PostToolUse hook (matcher `*` = all tools). Committed, shared config. |
| `src/hooks/post-tool-use.mjs` | Hot-path entry. Reads the event from stdin, appends one record, advances the session marker, exits 0. |
| `src/normalize.mjs` | Pure, deterministic `normalize(event) -> { action, raw? }`. The rule table. |
| `src/state/paths.mjs` | Single source of truth for `.praxis/` file locations. |
| `src/state/scaffold.mjs` | `ensureScaffold(root)` — creates the state dir and seeds `last_processed`. |
| `src/report.mjs` | Pure aggregation (`summarize(records)`) over log records — no I/O, fully testable. |
| `scripts/inspect-log.mjs` | Read-only CLI (`npm run inspect`) that prints a log summary and the unmatched pile. A companion for verifying the Stage 1 gate. |
| `scripts/demo.mjs` | Self-contained demo (`npm run demo`) that drives the real hook over synthetic events in a temp dir. Touches no project state. |
| `test/*.test.mjs` | Zero-dependency tests (`node --test`): normalization rules, the spawned hook process, concurrent appends, and the report aggregation. |

### Data flow

```
PostToolUse event (JSON on stdin)
        │
        ▼
resolveProjectDir()  ──►  $CLAUDE_PROJECT_DIR ?? event.cwd ?? process.cwd()
        │
        ▼
normalize(event)  ──►  { action, raw? }      (deterministic rule table)
        │
        ├─ read  .praxis/sessions/<id>.last   ──►  preceding_event
        │
        ▼
append one line to .praxis/log.jsonl
        │
        ▼
overwrite .praxis/sessions/<id>.last with the new action
        │
        ▼
exit 0   (always — failures are swallowed to errors.log)
```

### Normalization behavior

`normalize(event)` maps a raw invocation to a stable `action`:

- **Non-Bash tools** map by name (`Read -> file_read`, `Edit/Write/MultiEdit -> file_edit`,
  `Grep/Glob -> file_search`, …).
- **Bash commands** are split on shell separators (`&&`, `||`, `;`, `|`, newlines); each segment has
  leading noise stripped (environment assignments like `CI=1`, and wrappers like `sudo`, `env`,
  `time`, `nice`) and is matched against an ordered rule table. The **last** segment that matches
  wins — a chain's terminal intent. So `git add . && git commit … && git push` normalizes to
  `git_push`, `sudo git push` and `CI=1 git push` still resolve to `git_push`, and leading-anchored
  rules keep working under chaining and prefixing. Whether to also record intermediate segments is
  left as a calibration decision for real logged data.
- **Anything unrecognized** is `action: "unmatched"` with the raw command or tool name preserved,
  so the unmatched pile reveals which rules to add next (PRAXIS.md §5). Coverage is intentionally
  not exhaustive.

### The hot-path contract (non-negotiable)

The hook runs on *every* tool call, so its cost is paid on every action. It is therefore held to:

- **No model call, no network.** Classification is a fixed regex/lookup table.
- **No locking.** A single line-sized `appendFileSync` uses the OS append mode (`O_APPEND`), which
  is atomic for writes this small even across concurrent sessions — so no lock is required.
- **No read-modify-write of the growing log.** The log is only ever appended to. The single piece
  of state the hook *reads* is a tiny, fixed-size per-session marker file (see below), never the log.
- **Never disrupts Claude Code.** Every failure path is caught, noted best-effort to
  `.praxis/errors.log`, and the process still `exit(0)`s. A logger must never break the tool it logs.

Measured cost (200 invocations, `npm run bench`, Windows/Node 24): p50 ≈ 57 ms, p95 ≈ 68 ms,
p99 ≈ 88 ms per call, dominated by Node process startup and flat regardless of log size — the append
and marker writes are negligible by comparison. This is the latency added to each tool call; it is
small relative to a model turn (seconds), which is the objective basis for the Stage 1 gate's
"still feels snappy" requirement. The remaining, subjective confirmation is the user's day of use.

### Design decision: how `preceding_event` is captured

**Problem.** The log schema (PRAXIS.md §4) requires `preceding_event` on every line — "the action the
hook saw immediately before." But each hook invocation is a fresh process with no memory of the last
one, and the hot-path contract forbids reading the growing log to find the previous event.

**Decision.** Maintain a tiny **per-session marker** at `.praxis/sessions/<session_id>.last` holding
only that session's most recent action. Each invocation reads it (fixed-size, ~one word) to get
`preceding_event`, then overwrites it with the current action for the next event.

**Why this respects the contract.** The forbidden operation is read-modify-write of the *log* — the
file that grows without bound and would need locking under concurrency. The marker is the opposite:
fixed size, and **per session**, so there is exactly one writer (a session runs its tool calls
sequentially). No contention, no lock, no log scan. It is the standard cheap way to carry "what came
before" across stateless invocations.

**Scope note.** In Stage 1 the only lifecycle hook is PostToolUse, so `preceding_event` is always the
previous *tool action* (or `session_start` for the first event). When later stages add lifecycle hooks
(e.g. a Stop hook emitting `task_completed`), those hooks update the same marker, enriching the field
without any change to this design.

### State files (Stage 1 subset)

| File | Status in Stage 1 |
|------|-------------------|
| `.praxis/log.jsonl` | Written, one record per tool call. |
| `.praxis/last_processed` | Scaffolded to `0` (line-count cursor). Owned by the cold path; the hot path never touches it. |
| `.praxis/sessions/<id>.last` | Per-session `preceding_event` marker (implementation detail, not in the spec's file table). |
| `.praxis/errors.log` | Best-effort hot-path failure notes. |
| `candidates.json` / `active-rules.md` / `rejected.json` | Not yet created — later stages. |

All of `.praxis/` is git-ignored: it is user-specific behavioral data.

### Cross-platform note

The hook command is a **relative path** — `node src/hooks/post-tool-use.mjs` — not an absolute
path built from `$CLAUDE_PROJECT_DIR`. This is deliberate and was corrected during the build after
empirical testing:

- Claude Code runs hook commands through the user's shell, which on this machine is **PowerShell**.
  In PowerShell, `$CLAUDE_PROJECT_DIR` is *not* an environment-variable reference (that would be
  `$env:CLAUDE_PROJECT_DIR`); it expands to empty, so the absolute-path form silently broke. A
  relative path needs no variable expansion and resolves identically under PowerShell, `cmd`, and
  `bash`, relying only on Claude Code running hooks with the working directory at the project root.
- For locating `.praxis/`, the script still prefers `process.env.CLAUDE_PROJECT_DIR` (which *is*
  set as a real environment variable), falling back to the event's `cwd` then `process.cwd()`.
- The hook also strips a leading UTF-8 BOM and no-ops on empty stdin, because PowerShell prepends a
  BOM when piping to a process. Claude Code sends clean UTF-8, but tolerating both keeps the parser
  robust regardless of how the payload is delivered.

Verified on Windows/PowerShell during the build (correct records, correct `preceding_event`
chaining across interleaved sessions, silent on empty input). The Stage-1 gate — a day of real use —
is the final confirmation that the hook fires correctly in situ.

---

## Stage 2 — Detection + the 5 gates (complete)

### What it does

A **cold path** runs at session boundaries (SessionStart startup/resume, and SessionEnd best-effort).
It reads the log written by Stage 1 and runs the **promotion engine** — five sequential gates — over
it, writing the patterns that survive to `.praxis/candidates.json`. Nothing here touches the hot path:
the gates are pure arithmetic, run only when a session begins or ends.

### Components

| Path | Responsibility |
|------|----------------|
| `src/detect.mjs` | The promotion engine. Pure `detect(records, opts) -> { candidates, dropped, … }`. The five gates + reversibility classification. No I/O, no model. |
| `src/cold/run.mjs` | `runDetection(root, opts)` — the I/O shell: read log + cursor, run the engine if new events exist, write `candidates.json`, advance the cursor. |
| `src/hooks/session-detect.mjs` | The SessionStart/SessionEnd hook entry. Source-filters (startup/resume only), calls the runner, swallows failures, exits 0. |
| `src/state/log.mjs` | Shared `readLog(path)` — the reading side of the log (extracted so the inspector and the cold path parse JSONL the same way). |
| `src/hooks/io.mjs` | Shared hook plumbing (`readStdin`, `clean`, `noteError`) used by both the hot- and cold-path hooks. |
| `scripts/detect.mjs` | Calibration CLI (`npm run detect`): runs the engine read-only and prints candidates **and** the near-misses with the gate each failed. `--write` persists. |
| `.claude/settings.json` | Now also registers the `SessionStart` and `SessionEnd` hooks. |

### The five gates (`src/detect.mjs`)

A *pattern* is an `(action, preceding_event)` pair. It must clear, in order:

1. **Frequency** — seen ≥ `minOccurrences` (5) times.
2. **Cross-session spread** — across ≥ `minSessions` (3) distinct `session_id`s. *The workhorse:* it
   kills within-one-session repetition masquerading as a habit.
3. **Consistency** — of all events that followed this `preceding_event` (the denominator), the
   action followed ≥ `minConsistency` (0.8). Counting the denominator is what kills coincidence.
4. **Recency** — at least one occurrence within `recencyDays` (5).
5. **Reversibility classification** — assigns a `safe` / `consequential` / `destructive` tier. This
   gate never rejects; it records how an approved rule would be *allowed to behave* (PRAXIS.md §7).
   Unknown actions default to `consequential` (never silent, but not permanently sidelined).

Thresholds live in one frozen `THRESHOLDS` table and are overridable per-call for calibration. They
are **starting guesses**, tuned only against real logged behavior (PRAXIS.md §6, §12).

**Unmatched is never promoted.** A pattern whose `action` is `unmatched` is excluded from candidacy
regardless of its counts (it is surfaced in `dropped` with `failedGate: "unactionable"` so its volume
still informs rule discovery). You cannot make a rule out of an unrecognized command, and all
unmatched commands collapse under one label — so a frequent unmatched cluster is a signal to add a
*normalization* rule (PRAXIS.md §5), not a behavior to automate. A `preceding_event` of `unmatched`
is left eligible: the context is weak, but the gates handle it.

### Why the gates run over the whole log, and what the cursor is actually for

A pattern's significance — cross-session spread, the consistency denominator — is a property of the
**entire** stream, not of the events added since the last pass. So the engine always analyzes the full
log. The `last_processed` cursor therefore does **not** slice the input; its only job is **idempotency**:
a pass runs only if the log has more records than the cursor, then advances the cursor to the new total.

This is what makes the belt-and-suspenders dual trigger safe (PRAXIS.md §1). SessionEnd fires a pass
(instant proposals); the next SessionStart fires another (surviving hard closes / killed terminals).
Whichever runs first does the work and advances the cursor; the second sees no new events and no-ops.
Each event is thus analyzed into a candidates snapshot exactly once per change, with no double-proposing.

> **Deviation from the spec's wording.** PRAXIS.md §3 describes the cursor as "only unprocessed events
> get analyzed." Taken literally that breaks Gates 2–3, whose denominators need full history. The cursor
> is implemented as a *run/skip* gate (idempotency) rather than an input filter — the same intent (no
> redundant work, dual triggers safe) realized in the only way that keeps the gate math correct.

### Source filtering (non-negotiable)

`SessionStart` fires on `startup`, `resume`, `clear`, **and** `compact`. Only startup/resume are real
session boundaries; clear and compact happen mid-work, and running detection then would interrupt
active work (PRAXIS.md §2, §12). `session-detect.mjs` runs only on startup/resume. SessionEnd carries
no `source` and always runs (best effort).

### `candidates.json` shape

```json
{
  "generatedAt": "2026-06-08T11:22:20.774Z",
  "thresholds": { "minOccurrences": 5, "minSessions": 3, "minConsistency": 0.8, "recencyDays": 5 },
  "analyzed": { "events": 93, "sessions": 4 },
  "candidates": [
    {
      "action": "git_push",
      "preceding_event": "test_run",
      "tier": "consequential",
      "status": "candidate",
      "evidence": { "count": 6, "sessions": 3, "consistency": 0.86, "lastSeen": "…" }
    }
  ]
}
```

The provenance (thresholds + what was analyzed) is written alongside the candidates so a reviewer can
see *under what rules* a proposal was made. The runner reads `rejected.json` if it exists and filters
out already-declined patterns — forward-compatible with Stage 3, which creates that file.

### Calibration result (the point of running over real data)

The first pass over this repo's own Stage-1 log — 93 events across 4 sessions — produced **zero
candidates**, and that is the engine working correctly, not a failure:

- `file_edit` after `file_edit` (27×) and `file_read` after `file_read` (16×) are the highest-volume
  patterns, but each spans only **2** sessions → killed by Gate 2. Their consistency (0.68, 0.73) is
  below 0.8 as well. These are exactly the within-session bursts Gate 2 exists to reject.
- Every other pattern falls at Gate 1 (frequency): there simply isn't enough cross-session history yet.

The honest takeaway is that thresholds are **not** disproven by this data — there is just not enough of
it to promote anything, which is the correct behavior for a system that must not manufacture rules. Real
candidates appear only once a behavior recurs *across* sessions. We resist lowering thresholds to force a
candidate, because tuning against thin/imagined data is precisely what the spec forbids (PRAXIS.md §12).

### Hot-path refactor (no behavior change)

Extracting `readStdin` / `clean` / `noteError` into `src/hooks/io.mjs` and the JSONL loader into
`src/state/log.mjs` removed duplication between the two hooks and the inspector. The hot path's contract
is unchanged: still a minimal append, no model, no lock, always exit 0.

---

## Stage 3 — `praxis review` + write-back (complete)

### What it does

The **human path** (PRAXIS.md §1, §9). A CLI, `praxis review`, walks the pending candidates one at a
time, showing each pattern's tier and evidence, and lets the user **approve**, **reject**, or **skip**.
Approvals are written to `active-rules.md` (the human-readable file injected into context next session);
rejections are recorded in `rejected.json` (rejection memory — never re-proposed); skips stay pending.
This is the gate between an inferred *candidate* and an *active* rule: nothing the engine proposes ever
acts until a human says so here.

### Components

| Path | Responsibility |
|------|----------------|
| `src/review/store.mjs` | Pure state core. Renders/parses `active-rules.md`, serializes `rejected.json`, and computes the approve/reject/skip state transition (`applyDecision`). No I/O. |
| `src/review/run.mjs` | I/O shell. Reads the three review files, drives an injected per-candidate decision callback, and persists the results. Holds no prompt logic. |
| `bin/praxis.mjs` | The `praxis` command. Argument dispatch (`review`, `review --list`, `help`) and the interactive readline prompt. |
| `package.json` | Adds the `praxis` bin and an `npm run review` script. |

### The three files the review loop owns

- **`active-rules.md`** — approved rules only; the single file injected into context (PRAXIS.md §3).
  Each rule is rendered as a markdown block: a human/model-facing heading and instruction sentence
  (tier-aware — "soft confirmation" for safe, "explicit confirmation" for consequential, "never run
  automatically" for destructive), followed by a machine-readable provenance marker.
- **`rejected.json`** — an array of `{ action, preceding_event, rejectedAt }`. Matches the shape the
  cold-path runner already reads, so a rejected pattern is filtered out of every future detection pass.
- **`candidates.json`** — rewritten on exit with only the still-pending (skipped/undecided) patterns;
  the provenance fields are preserved. The next cold pass overwrites it wholesale anyway.

Each file is written **only if that kind of decision was made**: an approval never spawns an empty
`rejected.json`, a rejection never spawns an empty `active-rules.md`, and a skip-only (or immediate-quit)
session writes nothing at all — mirroring the no-candidates path, which also touches no files.

### Design decision: one file that is both human-readable and machine-parseable

**Problem.** `active-rules.md` must be *both* prose a human and the model read *and* a data source later
stages can parse (to know which rules are live, and — Stage 5 — to re-validate their recency). Markdown
prose alone is fragile to parse; a sidecar JSON would duplicate state and risk drift, and the spec names
`active-rules.md` as *the* file.

**Decision.** Render each rule as prose **plus** a provenance marker — an HTML comment carrying the
canonical JSON:

```markdown
## `git_push` after `test_run`  ·  consequential

When `test_run` just happened, you have repeatedly done `git_push` next (seen 6× across 3 sessions,
86% consistent, last 2026-06-08…). It is recoverable but not trivial, so offer it and act only on
explicit confirmation.

<!-- praxis:rule {"action":"git_push","preceding_event":"test_run","tier":"consequential",…} -->
```

The parser (`parseActiveRules`) reads **only** the markers via regex, so a human can freely edit the
prose without breaking round-tripping; a corrupt marker is skipped, not fatal. The render/parse pair is
covered by a lossless round-trip test. This keeps the file a single plain-text artifact a reviewer can
read top-to-bottom while remaining a reliable data source — inspectability and machine-readability in
one file.

### Closing a loop gap: approved patterns are not re-proposed

Stage 2's cold runner filtered out `rejected` patterns before writing candidates. Stage 3 generalizes
that to a single "already decided" filter: `readDecided()` in `src/cold/run.mjs` unions the rejection
memory **and** the active rules (read via `parseActiveRules`), so an already-approved pattern is never
surfaced again as a pending candidate. Without this, every cold pass would re-propose rules the user had
already approved — a confusing duplicate. Both files are optional; a read failure means "nothing decided."

### Design decision: the decision source is injected (testability + a robust prompt)

`runReview(root, { decide })` takes the per-candidate decision as a callback rather than reading the
keyboard itself. The interactive CLI passes a readline-backed asker; the tests pass a scripted list of
answers. The exact same loop runs in both, so the persistence logic is unit-tested without a TTY.

The interactive asker pulls lines from readline's **async iterator** rather than issuing sequential
`rl.question` calls. Sequential `question` calls drop input lines that arrive *between* prompts (batched
or pasted input), then hang at end-of-input; the async iterator queues lines, so batched input is handled
correctly and EOF resolves cleanly (treated as `quit` — a graceful stop that persists decisions made so
far). Unrecognized input re-prompts, so a stray keystroke never decides a rule.

### Usage

```bash
npm run review            # interactive: approve / reject / skip each candidate
node bin/praxis.mjs review --list   # read-only: list pending candidates and active rules
```

### State files (Stage 3 additions)

| File | Status after Stage 3 |
|------|----------------------|
| `.praxis/active-rules.md` | Written on first approval. Approved rules only; injected into context in Stage 4. |
| `.praxis/rejected.json` | Written on first rejection. Filtered out of all future detection passes. |
| `.praxis/candidates.json` | Now also rewritten by the review loop (remaining/skipped patterns only). |

### Tests

`test/review.test.mjs` (13 tests): render/parse round-trip and lossless-ness, prose-tolerant and
corrupt-marker-tolerant parsing, the `applyDecision` transitions (approve/reject/skip + dedupe), and the
full `runReview` loop over a temp project (persists approvals/rejections, rewrites the pending pool,
stops at `quit`, no-ops on empty, reloads rejection memory). `test/cold-run.test.mjs` gains a case
proving already-approved patterns are not re-proposed. Full suite: 54 tests, lint and format clean.

---

## Stage 4 — Feedback injection (complete)

### What it does

The **feedback path** (PRAXIS.md §1, §8) — the step that finally closes the loop. A `SessionStart`
hook reads the approved rules from `active-rules.md`, renders them into an imperative directive, and
prints it to **stdout**. `SessionStart` is the one lifecycle event whose stdout Claude Code injects
into the model's context, so from session start the model knows the user's inferred rules and offers
the matching action when its trigger occurs. Praxis still automates nothing: it writes rules into the
context the model reads (the honest, inspectable "Option A", PRAXIS.md §8), rather than driving actions
from a hook.

### Components

| Path | Responsibility |
|------|----------------|
| `src/feedback/context.mjs` | Pure `renderInjection(rules) -> string`. Builds the tier-aware directive block; returns `""` for no rules. No I/O. |
| `src/hooks/session-feedback.mjs` | The SessionStart hook entry. Reads `active-rules.md`, parses it via `parseActiveRules`, prints the rendered block to stdout, swallows failures, exits 0. |
| `.claude/settings.json` | Now registers `session-feedback.mjs` as a second `SessionStart` hook, alongside `session-detect.mjs`. |

### Design decision: a dedicated injection renderer, not the raw file

`active-rules.md` is a *human*-facing artifact that also carries machine-readable provenance markers
(HTML comments). Dumping it verbatim into context would inject that parsing noise and a header written
for a human reader. Instead the hook re-renders from the *parsed* rules into a block whose audience is
the model: an imperative directive ("When `test_run` just happened, offer to run `git_push` next, and
act only on explicit confirmation"). The tier governs the phrasing — safe asks for a soft confirmation,
consequential for explicit confirmation every time, destructive may only be suggested (PRAXIS.md §7) —
so the autonomy promise is restated in the very text that steers the model. The renderer is pure, so
the injected wording is unit-tested without spawning a process.

### Design decision: no source filter on feedback (unlike detection)

The detection hook (Stage 2) filters `SessionStart` to `startup`/`resume` because running detection on
`compact`/`clear` would interrupt active work — a non-negotiable (PRAXIS.md §12). That constraint is
specifically about *detection*. Feedback injection is read-only, cheap, and idempotent, and re-injecting
after a `compact` is **beneficial**: compaction can summarize the original injected rules out of context,
so re-emitting them keeps the rules live mid-session. The feedback hook therefore runs on every
`SessionStart` source. This is a reasoned divergence from the detection hook's behavior, not a violation
of the filter rule — that rule guards detection, not output.

> Why two hooks instead of teaching `session-detect.mjs` to also print: detection and feedback are
> distinct paths in the spec table (one writes candidates, one reads approved rules) with *different*
> source-filtering needs. Keeping them as two single-responsibility scripts is cleaner than one hook
> with branching behavior, and Claude Code concatenates the stdout of all `SessionStart` hooks.

### Defensive contract (shared with every Praxis hook)

Like the hot- and cold-path hooks, the feedback hook never disturbs Claude Code: a missing or unreadable
`active-rules.md` injects nothing, any failure is swallowed to `errors.log`, empty stdin is a silent
no-op, and it always `exit(0)`s. A feedback problem can never block a session from starting.

### State files (Stage 4)

No new state files. Stage 4 only *reads* `active-rules.md` (written by Stage 3) and emits to stdout;
it owns nothing on disk.

### Tests

`test/feedback.test.mjs` (13 tests): the pure renderer (empty-for-no-rules, trigger/action/pointer
present, per-tier phrasing, mixed-tier rendering, multi-rule numbering) and the spawned hook as Claude
Code runs it (injects seeded rules to stdout on `startup`, injects on `compact` too, injects nothing when
`active-rules.md` is absent, silent no-op on empty stdin, BOM tolerance, and a swallowed malformed payload
noted to `errors.log`). Lint and format clean.

---

## Stage 5 — Self-pruning (complete)

### What it does

The final stage: Praxis can now **retire** rules, not only add them (PRAXIS.md §8). During each cold
pass the engine re-validates every active rule against a recency horizon; a rule whose behavior hasn't
recurred within `staleDays` (14) is flagged for retirement and surfaced in the next `praxis review`,
where the user retires it (removed from `active-rules.md`) or keeps it. A system that only accumulates
rules decays — over time it steers the model with habits the user has dropped. Self-pruning closes that
leak, keeping the rulebook a picture of *current* behavior.

### Components

| Path | Responsibility |
|------|----------------|
| `src/detect.mjs` | `findStaleRules(records, activeRules, opts)` — pure. The inverse of Gate 4 applied to active rules: returns the rules with no occurrence within `staleDays`, each with `lastSeen` / `daysSinceLastSeen`. Adds `staleDays: 14` to `THRESHOLDS`. |
| `src/cold/run.mjs` | Computes `retirements` each pass (via `findStaleRules` over the parsed `active-rules.md`) and persists them into `candidates.json` alongside the candidates. |
| `src/review/store.mjs` | `retireRule(active, rule)` — pure removal of a rule from the active set by pattern id. |
| `src/review/run.mjs` | `runReview` gains a second phase: after candidates, walk the flagged stale rules via an injected `decideRetirement` callback (`retire` / `keep` / `quit`). `loadState`/`persist` now carry the `retirements` array; `formatRetirement` renders a stale-rule line. |
| `bin/praxis.mjs` | A retirement prompt (`r/k/q`, empty defaults to *keep*), the `--list` view now shows flagged stale rules, and both prompt phases share one readline iterator. |

### Design decision: a longer horizon for retirement than for promotion

Gate 4 promotes on `recencyDays` (5) — a candidate must prove the habit is *current*. Retirement uses
`staleDays` (14), deliberately longer. Promotion and pruning are asymmetric on purpose: it should take
strong, current evidence to *add* a rule, but a rule already approved deserves the benefit of the doubt
through a normal lull (a quiet week, a vacation) before being flagged. Using the same 5-day window for
both would yank rules the moment you paused the habit; a longer pruning horizon retires only on genuine
abandonment. Both remain calibration knobs in the one frozen `THRESHOLDS` table (PRAXIS.md §6, §12).

### Design decision: retirement is human-gated, symmetric with promotion

The cold pass only *flags* — it never edits `active-rules.md`. Removal happens solely through
`praxis review`, exactly as admission does. Auto-retiring silently was rejected for the same reason
Praxis never acts silently: a rule you can read is one you can trust, and the file is the user's to
own. So the same human path that admits a rule is the one that removes it; the engine only ever
proposes, in both directions.

### How staleness is computed without breaking cursor idempotency

`findStaleRules` runs inside the normal cold pass, so retirements are recomputed only when the pass
actually runs — i.e. when new events have arrived since the `last_processed` cursor (Stage 2's
idempotency gate). A pass with no new events stays a no-op; it does not rewrite `candidates.json`. In
practice a rule goes stale because *time* passed, and by the next session there is essentially always
new activity to trigger a fresh pass that re-evaluates staleness. The trade-off — staleness refreshes
on the next pass-with-activity rather than on a purely idle session — preserves the idempotent-no-op
property that makes the dual SessionStart/SessionEnd triggers safe.

### `candidates.json` shape (Stage 5 addition)

```json
{
  "generatedAt": "…",
  "thresholds": { "…": "…", "staleDays": 14 },
  "analyzed": { "events": 93, "sessions": 4 },
  "candidates": [ "…" ],
  "retirements": [
    { "action": "git_pull", "preceding_event": "session_start",
      "tier": "consequential", "lastSeen": null, "daysSinceLastSeen": null }
  ]
}
```

The review loop rewrites this file with both arrays trimmed to what is still pending; the next cold
pass overwrites it wholesale.

### State files (Stage 5)

No new files. Stage 5 adds the `retirements` array to `candidates.json` and *removes* rules from
`active-rules.md` on retirement; it owns no new on-disk artifact.

### Tests

`test/detect.test.mjs` gains 4 `findStaleRules` cases (flagged beyond horizon, kept within it, never-seen
rule, custom horizon). `test/cold-run.test.mjs` gains 1 case (a stale rule is written to
`candidates.json`). `test/review.test.mjs` gains 7 cases (`retireRule` purity; the retirement phase:
retire, keep-as-non-decision, combined candidate+retirement, quit-skips-phase, retirement-only). Full
suite: **79 tests**, lint and format clean.

---

## The loop, closed

With Stage 5 done, all four paths and the full lifecycle are in place:

```
hot path logs  ->  cold path detects + re-validates  ->  human approves / retires  ->  feedback injects
        ▲                                                                                      │
        └──────────────────────────  the model acts; behavior feeds back in  ◄────────────────┘
```

Praxis observes behavior, proposes rules from cross-session repetition, lets the user admit and retire
them, and injects the live set into context — never training the model, never acting on an irreversible
step, and keeping every rule in a file the user can read. See [`PRAXIS.md`](../PRAXIS.md) for the spec.

---

## Safety gate — PreToolUse (complete)

The reversibility tiers (PRAXIS.md §7) decide how a rule is *allowed* to behave; the safety gate is what
makes the strongest tier's promise — irreversible actions never auto-execute — true at the **hook layer**
rather than by convention. A `PreToolUse` hook runs before each Bash call and, if the command is
irreversible, returns a permission decision that forces explicit human confirmation.

### Components

| Path | Responsibility |
|------|----------------|
| `src/safety.mjs` | Pure `inspectCommand(raw) -> { category, reason, segment } \| null`. A high-precision rule table over the *raw* command, split into shell segments so a buried link (`npm test && rm -rf dist`) is caught. No I/O, no model. |
| `src/hooks/pre-tool-use.mjs` | The PreToolUse hook. On a Bash call it runs `inspectCommand`; a hit emits an `ask` permission decision to stdout. Fails open (allows + logs on error), always exits 0. |
| `.claude/settings.json` | Registers the hook with matcher `Bash` (the destructive vector; v1 scope). |

### Design decision: a separate recognizer, not the learning normalizer

`normalize.mjs` deliberately collapses argument noise to count habits — `git push --force-with-lease`
becomes `git_push`, `rm -rf x` becomes `unmatched`. That is precisely the wrong granularity for safety:
the danger lives in the flags it discards, and the reversibility tier of `git_push` (consequential) says
nothing about the `--force` that makes *this* push irreversible. So the gate has its own recognizer
(`safety.mjs`) that matches the dangerous command on raw text. The two modules answer different questions —
"what habit is this?" vs "is this irreversible?" — and must not share a classifier.

Coverage is conservative and extensible, mirroring normalization (PRAXIS.md §5): it targets the spec's
three categories (history rewrites, deletions, external sends) plus disk overwrites; an unrecognized
command is allowed, and the list grows as real dangerous commands surface. Over-blocking erodes trust
faster than the occasional gap, and because the decision is `ask`, a false positive costs one keystroke
while a false negative costs an irreversible action — so the rules err slightly toward flagging.

### Deviation from the spec: "ask" rather than exit-2 deny

PRAXIS.md §7/§2 describe the irreversible block as "hard-blocked (exit code 2)". A blanket `deny` would
also block the user's *own* deliberate destructive commands, and a `PreToolUse` hook cannot tell "a rule
auto-fired this" from "the user asked for it." So the gate returns an **`ask`** decision instead: the
guarantee the spec actually wants — *never auto-executes* — holds for every irreversible call (it cannot
run without a human yes), while a deliberate action still goes through on confirmation. "Hard-blocked" is
realized as "hard-gated." This was an explicit product decision (the alternative, deny-plus-escape-hatch,
was rejected as more friction for the same guarantee).

### Design decision: fail open, but logged

Every Praxis hook follows "never disturb Claude Code." For a *safety* hook that creates a real tension:
fail closed (deny on error) would turn one parse bug into a frozen terminal — itself a violation of the
hot-path contract — while fail open risks a silent gap. The gate fails **open** (allows the call) to
preserve usability, but records every failure to `errors.log`, so a malfunctioning gate is visible rather
than silently absent. The residual risk is bounded: the recognizer is pure regex with no I/O, the most
likely failure path (a malformed payload) is covered by a test, and the decision it would have made is
only a confirmation prompt, not an action.

### Tests

`test/safety.test.mjs` (12 cases): each category flagged (force-push variants, `git reset --hard`, `rm`
with `-r`/`-f`, `git clean -f`, disk destroyers, scp/rsync/curl sends), each safe counterpart *not*
flagged (plain push, soft reset, single-file `rm`, dry-run clean, disk *read*, GET fetch, local copy),
buried-in-a-chain detection, safe-chain non-detection, empty/nullish input, and the `\brm\b`-word-boundary
guard. `test/pre-tool-use.test.mjs` (6 cases): the spawned hook returns `ask` for an irreversible command,
allows safe commands silently, never gates non-Bash tools, no-ops on empty stdin, and fails open (allows +
logs) on a malformed payload. Full suite: **97 tests**, lint and format clean.

---

## `praxis status` — the workflow profile (complete)

Everything above is a pipeline; `praxis status` is the **window into it**. A single read-only command
that synthesizes the log, the live rules, the pending candidates, the stale flags, and the engine's
near-misses into one human "what I've learned about your workflow" view. It is the answer to "what does
this thing actually *know* about me?" — and the artifact that makes the otherwise-invisible loop legible.

### Why it matters (product, not plumbing)

Before this, seeing the system's state meant running three disjoint developer tools (`inspect`, `detect`,
`review --list`), none of which presented a *profile*. `praxis status` turns Praxis from a silent
background process into something you *check* — and it carries standalone value before any rule is ever
approved: it tells you things about your own workflow you didn't consciously know ("you push after tests
86% of the time"). That self-knowledge is the jump from "nice to have" to "worth opening."

### The "almost rules" idea

The section that makes the system feel alive. It surfaces patterns the engine has seen but that have not
yet cleared all five gates — ranked by how close they are — each with the exact remaining gap:

```
Almost rules — habits I'm watching (2):
  git_push after test_run
      seen 5× but in only 2 sessions — 1 more session to qualify
  git_commit after file_edit
      follows 68% of the time — needs 80%
```

This reuses the engine's own `dropped` output (the near-misses, with the gate each failed at), so the
profile can never disagree with the detector. Closeness is ranked by gates-cleared (a recency miss cleared
three gates and is nearest; a frequency miss cleared none and is furthest), and a lone one-off is excluded
— only genuine almost-habits show.

### Components

| Path | Responsibility |
|------|----------------|
| `src/status/status.mjs` | Pure `buildStatus(records, state, opts) -> StatusModel`. Folds `summarize` (top habits, observed window) and `detect` (near-misses) plus the review state into one model. No I/O. |
| `bin/praxis.mjs` | The `status` command: reads the log + review state, renders the model in sections. |
| `package.json` | Adds the `status` bin subcommand and `npm run status`. |

Like every feature it is a pure core under a thin renderer, reusing the existing engines rather than
re-deriving anything — so `status` is correct by construction and unit-tested without a terminal.

### Tests

`test/status.test.mjs` (7 cases): empty-log zeroing, the observed window (counts / sessions / day span),
top-habits ranking with `unmatched` excluded, a cross-session near-miss surfaced with its concrete gap, a
near-frequency miss included while a lone one-off is excluded, closeness ranking (nearer misses first), and
review-state passthrough. Full suite: **104 tests**, lint and format clean.

---

## Praxis 2: the mod (2026-10-04)

Claude Code 2.1.287 opened **mods** to everyone on 2026-10-01: TypeScript or JavaScript event
handlers, packaged in a plugin, that run inside Claude Code and can observe, rewrite, or answer
its events and draw their own interface. Praxis 2 moves the product onto that surface. The engine
(normalizer, five gates, status) is unchanged and shared; what changed is where the data comes from
and where Praxis lives.

### What changed, and why

| Praxis 1 | Praxis 2 | Why |
|----------|----------|-----|
| A `PostToolUse` hook logs every call to `.praxis/log.jsonl` | Reads the transcripts Claude Code already writes to `~/.claude/projects/` | The history already exists. A new install shows a profile in seconds instead of needing days of logging, and nothing is added to each tool call. |
| Project-scoped settings hooks (only sessions opened in this repo) | A mod installed once, active in every project | Fixes the open question from 2026-09-14: the first real detection pass produced 0 candidates because Praxis only saw its own repo. |
| `praxis status` in a separate terminal | A `/praxis` pane, a share card, and one line above the prompt | Visibility inside the tool where the work happens. |
| `PreToolUse` hook returns `ask` | `tool.call` hook holds the call and asks through `$.ui.ask` | Same recognizer (`src/safety.mjs`), now global; in a non-interactive run the answer is no. |

### Data flow

```
~/.claude/projects/<project>/<session>.jsonl     (written by Claude Code)
        │  bin/praxis-history.mjs  — run by the mod as a child process
        │  src/history/scan.mjs    — incremental: parses only bytes appended since last scan
        │  src/history/transcript.mjs — line -> tool/prompt events (pure)
        ▼
~/.claude/praxis/history.json                    (compact encoding, src/history/history.mjs)
        │  read by the mod with $.fs.read
        ▼
src/profile/profile.mjs  buildProfile()  — reuses detect() and buildStatus()
        │
        ├─ /praxis pane, share card, band line   (hooks/praxis.mjs, src/profile/card.mjs)
        └─ refreshed in the background after each turn (at most every 30 s)
```

**Why a child process.** A mod reads files through `$.fs.read`, capped at 4 MiB per file, and long
sessions' transcripts run past 100 MB (the author's largest is 108 MB). The Node scanner streams
files of any size and keeps a per-file byte offset, so the first scan of 223 MB took 1.4 s and each
later scan about 60 ms. When Node is missing, the mod falls back to reading transcripts itself and
skips files over the limit, saying so in the pane.

**Why a compact encoding.** The mod reads the scanner's output under the same 4 MiB cap. Each call
travels as a short array of numbers (seconds plus string-table indexes); `preceding_event` is not
stored but re-derived from order on decode. About 33 bytes per call: roughly 120,000 calls fit.

### Facts versus rules (a deliberate split)

Calibrating on the author's real history (80 sessions, ~5,000 calls) produced **one** pattern that
cleared all five gates, and it was a self-repeat ("connected-app call after connected-app call"),
which would make a useless rule. Real agent work is less repetitive than the spec imagined. Two
responses, kept separate on purpose:

- **The gates did not move.** A rule acts on your behalf, so its bar stays at 80% consistency. The
  profile additionally hides self-repeats from "rule-ready", and hides "almost" habits whose
  consistency is under 50% or whose trigger is the session start, because those are not close to
  anything.
- **The profile reports facts and tendencies, labelled as such.** Archetype (the signal furthest past
  its bar, quoting the person's own number), rhythm, projects, top actions, and **signature moves**:
  pairs with support (≥5 times, ≥3 sessions) and lift (≥2× the action's base rate). These are things
  that are true about the history; none of them acts.

### Normalizer coverage (shared with Praxis 1)

The first real scan labelled 43% of calls `unmatched`, mostly chained commands (`cd x && …`), the
PowerShell tool, and newer tool names. Added: PowerShell classified like Bash; `Agent`,
`AskUserQuestion`, `Skill`, task tools; `mcp__<server>__*` as `mcp_call` with the server as the raw
signal; `cat`/`grep`/`node`/`curl`/`mkdir`/compilers/installs. Pipeline filters (`head`, `grep`…)
are marked `filter` so they never override the command they trim (`git log | head` stays
`git_log`). `unmatched` fell to 5%. History keeps only the verb of an unrecognized command
(`commandVerb`), never its arguments.

### Components

| Path | Responsibility |
|------|----------------|
| `.claude-plugin/plugin.json`, `marketplace.json` | The repo root is the plugin; the marketplace lists it so `/plugin install praxis@praxis` works. |
| `hooks/hooks.json`, `hooks/praxis.mjs` | The mod: session start, background refresh, `/praxis`, pane and band rendering, the safety hold. The only file that calls `$`. |
| `src/history/transcript.mjs` | Pure transcript line parser. |
| `src/history/history.mjs` | Pure: events to engine records; compact encode/decode. |
| `src/history/scan.mjs`, `bin/praxis-history.mjs` | Incremental Node scanner and its CLI. |
| `src/profile/profile.mjs` | Pure profile: totals, rhythm, archetype, moves, rule-ready, almost, facts. |
| `src/profile/card.mjs` | Pure text: share card, band line, caption request. |

### Tests

Node suite: **145 tests** (new: transcript 7, history 7, profile 11, card 6, scan 5, normalizer 5).
Mod suite, run in Claude Code's own kit with `claude plugin test`: **8 tests** — the first-reveal
toast, `/praxis share`, the pane and its copy button, the reading state, the band line and
`/praxis quiet`, and the safety hold (refused, approved, and ordinary commands untouched). Verified
in real sessions on Claude Code 2.1.288: `/praxis share` printed the author's real card, and outside
the repo (so Praxis 1's hook could not act) the mod alone held `rm -rf` and the directory survived.
