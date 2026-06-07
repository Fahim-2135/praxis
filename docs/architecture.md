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
| `test/normalize.test.mjs` | Zero-dependency unit tests (`node --test`) over the normalization rules. |

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

The hook command uses `$CLAUDE_PROJECT_DIR` (Claude Code's documented project-root variable). The
script additionally falls back to the event's `cwd` and then `process.cwd()`, so path resolution is
resilient even where the environment variable is absent. Verified on Windows during the build; the
Stage-1 gate (a day of real use) is the final confirmation that the hook fires correctly in situ.

---

## Stages 2–5

Not yet built. See [`PRAXIS.md` §10](../PRAXIS.md) for the planned sequence. This document is
extended as each stage lands.
