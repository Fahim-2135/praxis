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
- **Bash commands** are split on shell separators (`&&`, `||`, `;`, `|`, newlines) and each
  segment is matched against an ordered rule table. The **last** segment that matches wins — a
  chain's terminal intent. So `git add . && git commit … && git push` normalizes to `git_push`,
  and leading-anchored rules keep working when a command is chained or prefixed (`cd x && git push`
  -> `git_push`). Whether to also record intermediate segments is left as a calibration decision
  for real logged data.
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

Measured cost: ~70 ms per invocation, dominated by Node process startup, flat regardless of log size.

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

## Stages 2–5

Not yet built. See [`PRAXIS.md` §10](../PRAXIS.md) for the planned sequence. This document is
extended as each stage lands.
