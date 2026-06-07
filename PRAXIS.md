# PRAXIS — Build Specification

> A behavioral pattern-learning agent that layers over Claude Code. It observes the
> developer's workflow, detects repeated action+context patterns, and proposes rules
> that automate them — with human approval, and never for irreversible actions.

**This file is the authoritative spec. Build in the stated order. Do not skip the
build sequence — each stage produces the data the next stage is tuned against.**

---

## 0. Core thesis (do not violate)

The model does **not** learn or get fine-tuned. An agent around it accumulates and
retrieves behavioral rules. The "intelligence" is a mechanical loop:

```
log actions  ->  detect repetition  ->  write inferred rule into context the model reads next time
```

Everything must stay **inspectable**: approved rules live in a human-readable file,
not hidden automation. This is a credibility requirement, not a style choice.

It is NOT a note/second-brain tool. It infers what the user did not state. It does
not store what the user files.

---

## 1. Architecture overview

Two hard-separated paths plus a human path and a feedback path.

| Path | Trigger | Constraint |
|------|---------|------------|
| **Hot path** | every tool call (`PostToolUse`) | MUST be a brutally minimal append. No model call, no read-modify-write, no locking. Append one line, exit. Its latency is added to every action — keep it instant. |
| **Cold path** | `SessionStart` (startup/resume only) + `SessionEnd` (best effort) | May think. Runs the 5 gates over unprocessed log, writes candidates, re-validates live rules. |
| **Human path** | `praxis review` command, async | User approves/rejects candidates. Approvals -> active rules. Rejections -> rejected store. |
| **Feedback path** | `SessionStart` stdout | Inject `active-rules.md` into context so the model acts on approved rules this session. |

**Belt-and-suspenders processing:** attempt on `SessionEnd` (instant proposals) AND on
next `SessionStart` (survives hard closes / killed terminals / crashes). The
`last_processed` cursor makes running both idempotent — only unprocessed events get analyzed.

---

## 2. Verified hook facts (checked against Claude Code docs — rely on these)

- Hooks run shell commands at lifecycle events, OUTSIDE the model, every time conditions match.
- Hook receives JSON via **stdin**: `session_id`, `cwd`, `tool_name`, `tool_input` (and `tool_result` on PostToolUse).
- `PostToolUse` / `PreToolUse` fire on EVERY tool call (file read, bash, web fetch, MCP).
- `PreToolUse` can **block** (allow / deny / ask) — exit code 2 blocks. Use for the safety tier.
- `SessionStart` stdout **is injected into context** the model can see — use it for feedback.
- `SessionStart` fires on `startup`, `resume`, `clear`, AND `compact`. **MUST filter** to
  startup/resume only — running detection on a mid-work compaction interrupts active work.
- `SessionEnd` exists but a hard close can skip it — never depend on it alone.
- Hooks are synchronous; total hook time adds to every matched call. Default timeout 60s.
- Config lives in `.claude/settings.json`. `$CLAUDE_PROJECT_DIR` = project root.

---

## 3. State files (the entire system state)

All under `.praxis/` in the project root.

| File | Contents |
|------|----------|
| `log.jsonl` | Raw event stream. Append-only, one normalized intent per line. Written event-by-event so it survives hard closes. |
| `last_processed` | Read cursor (timestamp or line number). Marks where the last detection pass ended. Keeps dual triggers idempotent. |
| `candidates.json` | Patterns that cleared all gates, awaiting approval. Affects nothing until approved. |
| `active-rules.md` | Approved rules ONLY. The single file injected into context. Human-readable markdown. |
| `rejected.json` | Declined patterns, so they are never re-proposed (rejection memory). |

**Separation is the safety design:** candidates and active rules live apart so a pending
proposal can never accidentally act.

---

## 4. Log record schema (4 fields)

Each line in `log.jsonl`:

```json
{
  "action": "git_push",
  "preceding_event": "task_completed",
  "timestamp": "2026-06-07T14:03:22Z",
  "session_id": "abc123"
}
```

- `action` — normalized intent (NOT the raw command). Collapses `git push`,
  `git push origin main`, aliases -> one countable `git_push`.
- `preceding_event` — reconstructed context (what the hook saw immediately before).
  "He pushes" is noise; "he pushes after task_completed" is a rule. This is the hard field.
- `timestamp` — ISO 8601, for recency + ordering.
- `session_id` — from the hook's stdin JSON. Load-bearing: separates "pushed 5x in one
  stuck session" (noise) from "pushed once at the end of 5 sessions" (habit).

---

## 5. Normalization (rules-first, NO LLM in hot path)

The hot-path hook turns the raw command into an `action` via deterministic rule matching
(regex/prefix). Reasons: free, instant, and CONSISTENT — non-deterministic classification
would fragment counts and break detection. Cover the 8–12 actions the user actually repeats
(git ops, test runs, terminal-open, repeat-question). Unmatched events are logged as
`action: "unmatched"` with the raw command preserved, for later rule discovery.

Do NOT try to be exhaustive. The unmatched pile reveals what to add. Calibrate from
observed reality, never from imagination.

---

## 6. The promotion engine — 5 sequential gates (the brain)

A pattern = an `(action, preceding_event)` pairing. It must pass ALL gates IN ORDER
before becoming a candidate. Thresholds below are STARTING values — calibrate against
real behavior; do not treat as final.

1. **Frequency** — pattern occurred >= `N` times. Start `N = 5`.
2. **Cross-session spread** — occurrences span >= `M` distinct `session_id`s. Start `M = 3`.
   (Most important gate — kills within-one-session repetition masquerading as a habit.)
3. **Consistency** — of ALL times `preceding_event` occurred, the action followed
   >= `80%` of them. (Counts the denominator, not just the hits. Kills coincidence.)
4. **Recency** — at least 1 occurrence within the last `5` days.
5. **Safety classification** — does NOT kill the rule; classifies reversibility into a
   tier that governs how the rule may behave (see §7).

Reference implementation:

```js
function evaluatePattern(pattern, log) {
  const hits = log.occurrencesOf(pattern);

  if (hits.length < 5) return null;                          // Gate 1

  const sessions = new Set(hits.map(h => h.session_id));
  if (sessions.size < 3) return null;                        // Gate 2

  const contextTotal = log.countContext(pattern.preceding_event);
  if (hits.length / contextTotal < 0.8) return null;         // Gate 3

  if (!hits.some(h => withinDays(h.timestamp, 5))) return null; // Gate 4

  const tier = classifyReversibility(pattern.action);        // Gate 5
  return { ...pattern, tier, status: "candidate" };
}
```

All gate logic is pure arithmetic over the local log. No model call, no network, no cost.

---

## 7. Safety tiers (govern autonomy, enforced at hook layer)

| Tier | Examples | Allowed behavior |
|------|----------|------------------|
| **Safe / reversible** | run tests, format, `ls`, status | May eventually act with a soft confirm. |
| **Consequential / recoverable** | `git commit`, `git push` | Acts ONLY with explicit confirmation every time ("push now?" -> user hits enter). Never silent. |
| **Destructive / irreversible** | force push, delete, external sends | NEVER auto-executes. May be suggested only. Hard-blocked at `PreToolUse`. |

The irreversible block must be enforced in a `PreToolUse` hook (exit 2), not by convention.

---

## 8. Feedback loop (how an approved rule changes behavior)

- On approval, a candidate moves `candidates.json` -> `active-rules.md`.
- `SessionStart` (startup/resume) reads `active-rules.md` and prints it to **stdout**, which
  Claude Code injects into context. The model now follows the rules this session.
- This is Option A (context injection), chosen over hook-driven automation because it is
  honest, debuggable, and inspectable — and because the consequential tier wants a soft
  "offer + confirm", not hard automation.

**Self-pruning:** during the cold pass, re-validate each active rule with gate-4 recency.
If a rule's behavior hasn't occurred recently (e.g. 14 days), flag it for retirement in
the next `praxis review`. A system that can't prune is self-accumulating, which decays.

---

## 9. `praxis review` command

CLI command the user runs asynchronously. Shows:
- pending candidates (pattern, tier, evidence: count / sessions / consistency / last-seen)
- active rules flagged stale for retirement

Actions: approve -> `active-rules.md`; reject -> `rejected.json` (never re-proposed);
retire -> remove from `active-rules.md`.

---

## 10. BUILD ORDER (strict — do not reorder)

Build stage 1 ONLY first. Each stage's output is the next stage's tuning input.

1. **Hot path** — `PostToolUse` hook + rule-based normalization + append to `log.jsonl`
   + `last_processed` scaffold.
   **Gate to pass before continuing:** after working normally for a day, (a) the log is
   clean and intents are correct, AND (b) Claude Code still feels snappy. If laggy, the
   hook is not minimal enough — fix before anything else.
2. **Detection subagent + 5 gates** — run over the real log from stage 1. It will propose
   junk first; that junk tells you which thresholds to tune. Calibration, not failure.
3. **`praxis review` + write-back** — approval loop, `candidates.json` -> `active-rules.md`,
   `rejected.json`.
4. **Feedback hook** — `SessionStart` injects `active-rules.md` into context. Loop closes.
5. **Self-pruning** — recency re-validation of active rules. Last; system works without it.

---

## 11. Scope

**In (v1):** PostToolUse logging, rule-based normalization, 5-gate engine, the 5 state
files, last_processed cursor, SessionStart detection + injection (source-filtered),
SessionEnd best-effort trigger, `praxis review`, PreToolUse safety block, self-pruning.

**Out (later):** LLM-assisted normalization discovery, autonomous action on the safe tier,
multi-project rule sharing, any GUI/dashboard, team-shared rule libraries.

---

## 12. Non-negotiable constraints (recap)

- Hot-path hook: minimal append, no LLM, no locking, instant.
- Normalization: deterministic rules only in the hot path.
- SessionStart: filter to startup/resume; never run detection on compact/clear.
- Irreversible actions: never auto-execute; hard-blocked at PreToolUse.
- All thresholds are starting guesses; calibrate against real logged behavior.
- Approved rules stay human-readable and inspectable.
- Build in the stated order; do not tune gates against imaginary data.
