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

## Stages 3–5

Not yet built. See [`PRAXIS.md` §10](../PRAXIS.md) for the planned sequence. This document is
extended as each stage lands.
