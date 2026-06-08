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

### 2026-06-07 — Stage 1 hardening: chained shell commands

**Concept — why one command can hold several intents:** A real developer rarely runs one verb at
a time. `git add . && git commit -m "x" && git push` is a single Bash call but three intents, and
the one that matters — the *reason you ran the line* — is the last one (`git push`). The original
normalizer matched the whole string against its rules and stopped at the first hit, so it labelled
that line `git_add`: technically present, but the wrong story. Worse, any rule anchored to the
start of the command (`^git …`) silently failed the moment you prefixed the line, e.g.
`cd packages/api && git push`.

**What I did about it.** I split each Bash command on shell separators (`&&`, `||`, `;`, `|`,
newlines), classify every segment, and keep the *last* one that matches — the chain's terminal
intent. Unrecognized chains still fall through to `unmatched` with the full command preserved, so
nothing is silently lost.

**Plain — what this means:** When you string several commands together with `&&`, Praxis now reads
the line the way you mean it — by its final, point-of-the-whole-thing action — instead of getting
distracted by the first word. And it no longer goes blind just because you put a `cd` in front.

**Technical — how an engineer says it:** Bash normalization now tokenizes on shell control
operators and applies the rule table per segment, selecting the terminal matching segment as the
canonical `action`. This restores correctness for leading-anchored patterns under command chaining
and prefixing, and keeps the one-record-per-call invariant. Whether to additionally emit
intermediate segments is explicitly deferred as a calibration decision against real logged data
(PRAXIS.md §12), rather than guessed now. Covered by four new unit tests (compound terminal intent,
chained/prefixed anchors, unmatched chain with raw preservation, non-actionable leading segment).

### 2026-06-07 — Stage 1 hardening: a read-only log inspector

**Concept — separating pure logic from I/O:** A function that *both* reads a file and computes a
result is hard to test (you need a real file on disk) and hard to reuse. The fix is to split it:
a pure function that takes already-parsed data and returns a result (no file access, no printing),
and a thin wrapper that does the messy I/O around it. The pure part gets fast, deterministic unit
tests; the wrapper stays trivially small. I applied that here: `src/report.mjs` has `summarize()`
(pure), and `scripts/inspect-log.mjs` reads the log and prints around it.

**Plain — what I just did:** I added a command, `npm run inspect`, that shows you what Praxis has
logged so far — how many times each action happened, and a list of commands it didn't recognize
yet. That last list is gold: it's literally the to-do list of normalization rules to add, written
by your real behavior instead of my guesses. It only reads; it changes nothing.

**Technical — how an engineer says it:** Added a read-only reporting path: a pure
`summarize(records)` aggregator (counts by action and session, ranked, with the unmatched-raw
frequency table) and a CLI inspector that loads `log.jsonl`, tolerates malformed lines, and renders
the summary. It directly supports Stage 1 gate verification ("is the log clean, are intents
correct?") and operationalizes the PRAXIS.md §5 discovery loop — the unmatched pile is the
data-driven backlog for future normalization rules. Covered by unit tests on the aggregator,
including tie-breaking, empty input, and the missing-`session_id`/`raw` edge cases.

### 2026-06-07 — Stage 1 hardening: prefix stripping, a demo, and contributor docs

**Concept — peeling leading noise before matching:** Real commands often carry a prefix before the
verb that matters: an environment assignment (`CI=1 git push`) or a wrapper (`sudo git push`,
`time npm test`). A rule anchored to the start of the line (`^git …`) would miss all of these. So
before matching, the normalizer strips a stack of these known prefixes, exposing the real verb. It's
a small, deterministic pre-pass — no parsing the whole shell grammar, just removing the noise that
predictably sits in front.

**Plain — what I did:** Three things. (1) Praxis now understands commands that start with things
like `sudo` or `CI=1` — it looks past them to the real action. (2) I added `npm run demo`: run it
and you watch the whole Stage 1 machine work on a pretend day of activity, in seconds, without
touching your real data — useful for you and for anyone reading the repo. (3) I wrote a
`CONTRIBUTING.md` so an outside developer knows how to work on this safely, especially the one rule
that must never be broken (don't put slow or smart things in the hot path).

**Technical — how an engineer says it:** (1) Added `stripLeadingNoise()` to the Bash classifier — a
fixed-point removal of leading env-assignments and wrapper commands so leading-anchored rules match
under common prefixes; covered by a new unit test. (2) Added `scripts/demo.mjs` (`npm run demo`): an
honest, self-contained demonstration that spawns the actual hook over a synthetic multi-session
event stream in a temp directory and renders the resulting log plus a `summarize()` report, leaving
project state untouched — it doubles as the README's runnable demo. (3) Added `CONTRIBUTING.md`
documenting the dev workflow, CI expectations, the non-negotiable hot-path contract, and the
calibrate-from-real-data normalization principle.

### 2026-06-07 — Stage 1 hardening: linter vs formatter

**Concept — two different jobs people often conflate:** A *formatter* (Prettier) only changes how
code *looks* — indentation, quotes, line breaks. It never changes what the code *does*. A *linter*
(ESLint) analyzes what the code *means* and flags likely defects: a variable you imported but never
use, a reference to something undefined, a `case` that falls through by accident. Formatting is
taste; linting is correctness. Running both, with no overlap between them, is the conventional
professional setup — which is why I configured ESLint with formatting rules turned off, so the two
tools never fight.

**Plain — what I did:** I added a second automatic checker. The first one (Prettier) keeps the code
tidy; this new one (ESLint) reads the code for actual mistakes — things that would be bugs, not just
ugly. Both now run automatically in CI on every change, alongside the tests. The codebase passed
ESLint with nothing to fix, which is a good sign it was already clean.

**Technical — how an engineer says it:** Added ESLint (flat config, `@eslint/js` recommended) as a
correctness gate distinct from Prettier's formatting gate, with stylistic rules omitted to avoid
tool conflict. Wired `npm run lint` into CI ahead of `format:check` and `test`. The existing source
passed with zero findings, confirming the hand-written code already met the recommended rule set.
---

### 2026-06-08 — Stage 2: the cold path and the promotion engine

**Concept — the cold path (and why it is separate from the hot path):** Stage 1 was the hot path —
the code that runs on *every* action and must be instant. The *cold path* is its opposite: it runs
only at session boundaries (when a session starts or ends), so it's allowed to think. This is where
the actual reasoning lives. The split is the whole architecture: cheap-and-constant work on the hot
path, expensive-and-occasional work on the cold path, with a log file as the seam between them.

**Concept — a "pattern" and the five gates:** A pattern isn't an action; it's an `(action,
preceding_event)` pair — "push *after* tests," not "push." The promotion engine decides which pairs
are real habits using five filters in order: (1) **frequency** — happened enough times; (2)
**cross-session spread** — across enough *different* sessions; (3) **consistency** — of all the times
the setup occurred, the action followed often enough; (4) **recency** — happened recently; (5)
**reversibility** — classify how risky it is (this one never rejects, it just labels). The first four
kill junk; the fifth governs autonomy later.

**Concept — the consistency denominator:** The non-obvious gate. "Pushed 5 times" is meaningless
until you ask "out of how many opportunities?" Gate 3 divides the hits by how many events followed
that same `preceding_event` *at all*. Counting the denominator — not just the hits — is the line
between a habit and a coincidence.

**Concept — idempotency and the cursor:** Doing something twice should be the same as doing it once.
Detection runs at *both* SessionEnd and the next SessionStart (belt-and-suspenders, so a hard close
can't lose proposals). The `last_processed` cursor makes that safe: a pass runs only if there are
new events, then advances the cursor. Whichever trigger fires first does the work; the second sees
nothing new and no-ops. Note the subtlety: the gates still analyze the *whole* log (cross-session
and consistency counts need full history) — the cursor gates *whether to run*, not *what to read*.

**Concept — source filtering a hook:** `SessionStart` fires on startup, resume, clear, AND compact.
Clear/compact happen mid-work; running detection then would interrupt active work. So the hook
inspects the event's `source` field and runs only on startup/resume. A hook firing isn't a blank
cheque to act — you filter on *why* it fired.

**Plain — what I just did:** I built the part of Praxis that actually thinks. It reads the log of
everything you've done, and for each thing that keeps happening it asks five questions — did it
happen enough, on enough separate occasions, almost every time the setup occurred, recently, and how
risky is it? Only behaviors that pass get written onto a shortlist for you to approve. It runs
quietly when a session opens or closes, never while you're working. Then I ran it over my own real
log — and it proposed *nothing*, correctly, because my history is mostly one long session and the
"different occasions" test refused to call that a habit. That's the engine being honest, not broken.

**Technical — how an engineer says it:** Implemented the cold path. `src/detect.mjs` is a pure,
deterministic promotion engine: `detect(records)` groups events by `(action, preceding_event)`,
evaluates four sequential kill-or-pass gates (frequency, cross-session cardinality, consistency over
the context denominator, recency) plus a non-rejecting reversibility classifier, and returns
candidates with evidence plus the dropped near-misses tagged by failed gate. `src/cold/run.mjs`
wraps it with cursor-gated idempotency and writes `candidates.json` with provenance. A
`SessionStart`/`SessionEnd` hook (`src/hooks/session-detect.mjs`) triggers it, source-filtered to
startup/resume. Thresholds are a frozen, overridable table — starting guesses, calibrated only
against real data. The calibration pass over the live 93-event/4-session log yielded zero candidates;
the dominant patterns failed Gate 2 (2 sessions) and the rest Gate 1, which is the correct outcome on
thin cross-session data. Refactored shared hook I/O (`src/hooks/io.mjs`) and the JSONL reader
(`src/state/log.mjs`) out of duplication. 10 engine tests + 5 cold-runner tests added; full suite of
38 passes, lint and format clean.

**Decision — "detection subagent" is deterministic code, not an LLM.** The spec's build order says
"detection subagent," which tempts a model call. I deliberately did not. A non-deterministic
classifier would map the same log to different rules across runs, fragmenting the counts every gate
depends on and destroying the inspectability that is the project's core promise (PRAXIS.md §6, §12).
"Subagent" here means a cold-path component, not a model. Flagging this rather than quietly building
an LLM judge is the spec protecting the project from a plausible-sounding wrong turn.
