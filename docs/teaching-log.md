# Teaching Log

> **What this file is.** A running, append-only record of every explanation I (Claude Code)
> give you while we build Praxis. Whenever I teach you a concept, explain a decision, or give
> the two-layer (plain + technical) explanation that `CLAUDE.md` mandates, I paste it here too.
>
> **Why it exists.** So that if you forget something — a term, a mechanism, why we made a
> choice — you can come back to this one file and find it again, in full, without digging
> through the chat history.
>
> **How to read it.** Entries are in build order, newest at the bottom. Each entry is dated
> and tagged with what we were doing at the time. The `docs/learning-log.md` file (one tight
> entry per stage, in your voice) is the *summary*; this file is the *full transcript*.

---

## How entries are structured

Each meaningful explanation gets an entry like this:

```
### YYYY-MM-DD — <short title of what we were doing>

**Concept (if new):** one paragraph — what it is, why it's the right tool, the alternatives.

**Plain — "what I just did":** the no-jargon version.

**Technical — "how an engineer says it":** the same thing in correct professional vocabulary.
```

Not every entry will have all three parts — a pure concept explainer won't have a "what I
just did," and a quick decision might be plain + technical only. The shape flexes; the rule
is that nothing I teach you goes unrecorded here.

---

## Entries

### 2026-06-07 — Setting up this teaching log

**Concept — append-only documentation:** "Append-only" means we only ever *add* to the
bottom of this file; we don't rewrite or delete past entries. This is the same idea behind a
ship's logbook or an accountant's ledger: the value comes from the history being trustworthy
and unedited. It's also exactly the pattern Stage 1 of Praxis uses for the activity log, so
you're meeting the concept here in a low-stakes place before it matters in the engine.

**Plain — what I just did:** I made a notebook that lives in the project. Every time I teach
you something while we build, I'll write it down in here too, at the bottom, dated. If you
forget something later, you open this file and it's all there in plain words.

**Technical — how an engineer says it:** I created an append-only Markdown teaching log at
`docs/teaching-log.md`, structured as dated, chronologically-ordered entries. It sits
alongside `docs/learning-log.md` (the per-stage, author's-voice summary) in the `docs/`
directory to keep the repository root clean. This file is the verbatim record; the learning
log is the distilled one. I also registered this as a working convention in `CLAUDE.md` so
the practice is self-documenting and survives across sessions.

### 2026-06-07 — The teaching log is a manual prototype of Praxis itself

**The insight (yours):** "I just manually did something while building the thing that will
automate it." Setting up the teaching-log convention, you ran — by hand — the exact loop
Praxis runs in software: **notice a repeated action → write down the rule → follow the rule.**

**Concept — convention vs. automated workflow:** A *manual convention* is a rule a human
chooses to follow, written in a doc (here, `CLAUDE.md`). An *automated workflow* is the same
rule enforced by a **hook** that fires on its own, so it never depends on anyone remembering.
Praxis's entire job is to promote the first kind into the second: observe behavior, infer the
rule, write the config that makes it automatic.

**Concept — dogfooding:** "Eating your own dogfood" means using your own product to do your
own work. Building the manual version of a workflow *first* — feeling where it's tedious —
before automating it is senior instinct: you can't automate a workflow well until you've
lived it, or you'll automate the wrong thing.

**Plain — what this means:** Before writing a single line of the auto-detector, you performed
its job with your own hands and recognized it. That recognition is the real proof you
understand the system — you can be it before you've built it.

**Technical — how an engineer says it:** The teaching-log convention is a manual prototype of
a Praxis promotion target: a repeated, observable behavior currently enforced by human
discipline rather than by a registered hook. Hardening it later (PostToolUse/Stop hook that
appends explanations automatically) would be the literal manual-to-automated promotion the
engine performs — making this an instance of dogfooding the product's core loop on day zero.

### 2026-06-07 — Stage 1: the three concepts behind the hot path

**Concept — a hook:** A hook is a shell command Claude Code runs automatically at a lifecycle
event (here, `PostToolUse` — after every tool call), *outside* the model. It receives a JSON
description of the event on stdin and runs as its own short-lived process. We chose a hook because
it's free, deterministic, and fires whether or not the model is "thinking." The alternative — asking
an LLM to classify each action — is explicitly banned from this path: it would cost money and tokens
on every action and, worse, classify the same command differently on different runs.

**Concept — JSONL:** "JSON Lines" is a file format: one self-contained JSON object per line. It's
the right tool for an event log because you can *append* a new line without reading or rewriting the
file, and because a crash mid-write can only damage the final line — every earlier line stays valid.
The alternative, one big JSON array, would force a read-modify-write of the whole file on every event.

**Concept — the idempotency cursor:** `last_processed` is a small file recording how far the
detection pass has already read (a line count). Because we'll trigger detection twice — once when a
session ends and again when the next one starts (belt and suspenders against hard crashes) — the
cursor lets both runs skip already-analyzed events, so each event is processed exactly once.
"Idempotent" means running it twice has the same effect as running it once. Stage 1 only *creates*
this file; the cold path advances it in Stage 2.

### 2026-06-07 — Stage 1: what I just built (two-layer)

**Plain — what I just did:** I built the part of Praxis that watches you work. Every time you do
something in Claude Code, a tiny script wakes up, writes a single tidy line in a logbook saying what
you did, what you'd done right before it, when, and which work-session it was — then immediately
gets out of the way. It never thinks, never reaches the internet, never rewrites old pages. I also
laid down a bookmark file so the part that *does* think (built next) knows where it left off. I
tested it: the log lines come out correct, and each call takes about 70 milliseconds — fast enough
to be invisible.

**Technical — how an engineer says it:** I implemented the Stage 1 hot path as a `PostToolUse`
hook registered in `.claude/settings.json`. The hook (`src/hooks/post-tool-use.mjs`) reads the
event payload from stdin, runs deterministic rule-based normalization (`src/normalize.mjs`) to map
the raw tool invocation to a stable `action`, reconstructs `preceding_event` from a per-session
marker, and performs a single atomic `O_APPEND` write of one record to `.praxis/log.jsonl`. It
holds the hot-path contract: no model call, no network, no lock, no read-modify-write of the log,
and an unconditional `exit 0` with errors swallowed to `errors.log` so the logger can never disrupt
the editor. I scaffolded the `last_processed` line-count cursor and covered the normalization rules
with `node --test` unit tests. Measured per-invocation latency ≈ 70 ms, dominated by Node startup
and flat in log size.

### 2026-06-07 — Stage 1: why `preceding_event` needed a trick

**Concept — carrying state across stateless invocations:** Each hook run is a brand-new process
with no memory of the previous one. But `preceding_event` requires knowing what happened *last*.
Reading the log to find out is forbidden — the log grows without bound and scanning it would break
the latency budget. The standard cheap solution is a small, fixed-size *marker* file that the
process reads and then overwrites. I keyed it per session (`.praxis/sessions/<id>.last`) so there's
exactly one writer per file (a session's tool calls run one at a time), which means no lock is ever
needed.

**Plain — what this means:** To remember "what you just did," the script keeps a one-word sticky
note per work-session. It reads the note to fill in the "right before" field, then updates the note.
It never has to flip back through the whole logbook to remember.

**Technical — how an engineer says it:** `preceding_event` is reconstructed via a per-session
marker rather than a log scan, preserving the no-read-modify-write-of-the-log invariant. Per-session
keying guarantees single-writer access, eliminating the need for file locking under concurrent
sessions. This is documented as a deliberate, spec-compliant design decision in
`docs/architecture.md` (the marker file is an implementation detail not present in PRAXIS.md §3's
state-file table).

### 2026-06-07 — Stage 1: two bugs the verification caught before you wasted a day

**Concept — verify the activation path, not just the logic:** Unit tests proved the *logic*
(normalization) was correct, but a hook has a second failure surface: whether the shell command
that launches it actually runs on your machine. I tested that separately, and it's a good thing —
the first version would have silently never fired.

**Bug 1 — shell variable expansion.** The hook command was `node "$CLAUDE_PROJECT_DIR/src/..."`.
`$CLAUDE_PROJECT_DIR` is the syntax for an environment variable in **bash**, but your shell is
**PowerShell**, where the same text means "a PowerShell variable named CLAUDE_PROJECT_DIR" — which
is undefined and expands to nothing. So the path collapsed to `/src/hooks/post-tool-use.mjs` and
node couldn't find the file. *Fix:* use a relative path (`node src/hooks/post-tool-use.mjs`), which
needs no expansion and works the same in PowerShell, cmd, and bash, because Claude Code runs hooks
from the project root.

**Bug 2 — the BOM.** "BOM" (byte-order mark) is an invisible character (U+FEFF) some Windows tools,
including PowerShell, stick at the very front of text they pipe into a program. `JSON.parse` sees
that invisible character before the `{` and throws. Claude Code itself sends clean text without a
BOM, so this wasn't strictly required — but a parser that chokes on a stray invisible byte is
fragile. *Fix:* strip a leading BOM and ignore empty input before parsing.

**Plain — what this means:** Code that passes its tests can still be broken in the real world if the
wiring that launches it is wrong. Checking the launch path on the actual platform — not just the
inner logic — is what separates "works on my machine in theory" from "works." Both fixes are small;
finding them is the whole value.

**Technical — how an engineer says it:** Logic correctness (unit-tested normalization) is
necessary but not sufficient; the invocation contract must be validated against the host
environment. Two platform-specific defects were found by exercising the registered command under
PowerShell: (1) POSIX `$VAR` expansion does not occur in PowerShell, so the command was switched to
a cwd-relative path that is shell-agnostic given Claude Code's project-root working directory; and
(2) PowerShell's native-pipe encoding prepends a UTF-8 BOM, so the hook now strips a leading U+FEFF
and treats empty stdin as a no-op. Verified end-to-end under PowerShell, including correct
`preceding_event` reconstruction across interleaved sessions.