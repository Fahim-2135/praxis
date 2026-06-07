# Learning Log

> One tight entry per build stage, in my own voice — the distilled lesson, plain and technical.
> The full transcript of every explanation lives in [`teaching-log.md`](teaching-log.md); this is
> the summary I'd hand someone who asked "so what did that stage actually teach you?"

---

## Stage 1 — The hot path

**What we built.** A hook that fires after every action I take in Claude Code, turns that action
into a clean label, and writes one line to a log file. Nothing clever — that's the whole point.

**The plain version.** Think of a security camera that, every time a door opens, writes one line
in a notebook: *what happened, what happened right before it, when, and which visit it was.* It
never stops to think, never phones anyone, never rewrites old pages — it jots one line and gets
out of the way. All the actual reasoning ("is this a habit worth automating?") happens later, when
nobody's waiting.

**The technical version.** Stage 1 is a `PostToolUse` hook that performs deterministic
rule-based normalization of each tool invocation into a stable `action`, then does a single
atomic append to an append-only JSONL event log. It is held to a strict hot-path contract: no
model call, no network, no lock, no read-modify-write of the log, and it always exits 0 so a
logging failure can never disturb the editor. Expensive analysis is deferred to the cold path that
runs at session boundaries.

**The thing that actually clicked.** The whole architecture is one boundary: *latency*. Because
this code runs on every keystroke-level action, it's allowed to do almost nothing — and that
constraint is a feature, not a limitation. The discipline of "append one line and leave" is what
keeps the tool invisible in use. I also saw why `preceding_event` is the hard field: a fresh
process has no memory, so carrying "what came before" across invocations takes a deliberate trick
(a tiny per-session marker) rather than reading the log — which the latency budget forbids.

**Concepts exercised:** hooks (PostToolUse), JSONL append-only logs, the hot/cold path split,
deterministic normalization, atomic appends vs. locking, the idempotency cursor, and graceful
non-blocking error handling.

**Gate before Stage 2:** after a day of real use — (a) the log is clean and the intents are
correct, and (b) Claude Code still feels snappy. If it lags, the hook isn't minimal enough and
that gets fixed before anything else.
