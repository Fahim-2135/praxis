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

---

## Stage 2 — Detection and the five gates

**What we built.** The "brain": code that reads the log and decides which repeated behaviors are
real habits worth proposing. It runs at the start and end of a session (never mid-work), scores
every `(action, what-came-before)` pair against five filters, and writes the survivors to a
candidates file I'll later approve or reject.

**The plain version.** Imagine going back through that security-camera notebook from Stage 1 and
asking, for each thing that keeps happening: did it happen *enough* times? On *different visits*,
or all in one frantic afternoon? *Almost every time* the setup occurred, or just occasionally?
*Recently*, or has it gone stale? Only the patterns that pass all four questions get written on a
shortlist — and a fifth note records how risky each one is, which decides how much freedom it's
ever allowed. Nothing acts; it just builds a shortlist.

**The technical version.** Stage 2 is the cold path: a `SessionStart`/`SessionEnd` hook that runs a
pure, deterministic promotion engine over the JSONL log. Five sequential gates — frequency,
cross-session spread, consistency (hits over the context's denominator), recency, and a
non-rejecting reversibility classification — filter patterns into `candidates.json`. It is all
arithmetic, no model: determinism is required so the same log always yields the same rules. A
`last_processed` cursor makes the dual trigger idempotent. `SessionStart` is source-filtered to
startup/resume so a mid-work compaction never kicks off detection.

**The thing that actually clicked.** Two things. First, **the denominator is everything.** "He
pushed 5 times" is meaningless until you ask "out of how many chances?" Gate 3 counts the
context's total occurrences, not just the hits — that's the line between a habit and a
coincidence. Second, and bigger: **the right answer is often "propose nothing."** I ran the engine
over my own log expecting to see it work, and it returned zero candidates — because my data is
mostly one long session, and Gate 2 correctly refused to call that a habit. The instinct is to
lower a threshold so *something* shows up. That instinct is the trap. The spec is explicit:
calibrate against real behavior, never against the data you wish you had. An engine that
manufactures rules from thin data is worse than one that stays quiet.

**Why "detection subagent" is not an LLM.** The build order's word "subagent" tempted a model
call. Putting one here would have been a real mistake — a non-deterministic judge fragments the
counts the gates depend on and destroys inspectability. The detection "agent" is deterministic
code. Catching that was the spec protecting the project from a plausible-sounding wrong turn.

**Concepts exercised:** the cold path, sequential gating / filter pipelines, the
consistency-denominator idea, cursor-based idempotency, hook source-filtering, reversibility
tiers, deterministic vs. model-based classification, and calibration discipline (not tuning
against imagined data). Also a small engineering hygiene pass: extracting shared hook I/O and the
log reader so nothing is duplicated across the two hooks.

**Gate before Stage 3:** the engine is correct and quiet on thin data. Stage 3 builds `praxis
review` — the approval loop that turns a candidate into an active rule — which is what finally
gives the candidates somewhere to go.

---

## Stage 3 — `praxis review` and the approval loop

**What we built, in one line.** The part where *I* decide. Stage 2 made a shortlist of habits it noticed;
Stage 3 is me going down that shortlist and stamping each one **yes / no / later**.

**The plain version.** The engine from Stage 2 can only *suggest* — it writes a shortlist and stops. It
has no power to change anything on its own (that's on purpose; that's the whole safety idea). Stage 3 is a
command I run, `praxis review`. It shows me one habit at a time — what it is, how often I did it, how
risky it is — and I answer:

- **yes (approve)** → the habit gets written into a rulebook the assistant will read later.
- **no (reject)** → it goes on a "never suggest this again" list.
- **later (skip)** → it stays on the shortlist for next time.

The rulebook is a plain file I can open and read like a page of notes. Nothing is hidden. Nothing acts
until I say yes.

**The one idea I want to remember: a single file doing two jobs.** The rulebook (`active-rules.md`) has to
work for *two different readers at once*:

1. **Me, a human** — I open it and read plain English: "you push after tests; offer it but ask first."
2. **The program** — later, Praxis has to read that same file and get the *exact* habit data back out of
   it.

I had three options:

- Write it as **plain English only** → nice for me, but a program reading loose English is unreliable; one
  reworded sentence and it misreads.
- Write **two separate files** (one English for me, one data-file for the program) → the program is happy,
  but now I have two files that can quietly drift out of sync, and the spec says there must be *one* file.
- **What I did:** one file = English for me, **plus a small hidden tag under each rule holding the exact
  data** for the program. The program only ever reads the tags, so I can freely edit the English without
  breaking it.

That last choice is the whole project in miniature: it has to be *readable by a human* and *usable by a
machine* at the same time, and I refused to give up either.

**A second small idea: separate "what to decide" from "how I typed it."** The logic that updates the
files (approve/reject/skip) is kept apart from the part that reads my keypresses. That means I could test
all the file logic automatically — by feeding it a fake list of answers like `["yes","no","later"]` —
without anyone actually sitting at a keyboard. Same trick as Stage 1: keep the thinking part separate from
the messy input/output part, so the thinking part is easy to test.

**A bug worth remembering (plain).** My first version asked the questions one at a time, which is fine when
a person types one answer, waits, types the next. But if several answers arrive *at once* (e.g. a test
pipes them in together), the in-between answers got dropped and the program froze waiting forever. Fix:
read the answers from a *queue* that holds them until I'm ready, and if the answers run out, just stop
politely. Lesson: handle input arriving in a batch, not only one keystroke at a time.

**The technical words (so the vocabulary lands too).** Each term, unpacked:

- **CLI** = "command-line interface" — a program you run by typing a command (`praxis review`), no buttons.
- **the human path** — the spec's name for "the step where a person, not the machine, makes the call."
- **`active-rules.md` / `rejected.json` / `candidates.json`** — the three files: approved rules, the
  never-again list, and the pending shortlist.
- **provenance marker** — the hidden data tag I tuck under each rule (`<!-- praxis:rule {...} -->`).
  "Provenance" = where-it-came-from; the tag records the rule's exact origin data.
- **parser** — the small piece of code that *reads* a file and pulls structured data out of it.
- **dependency injection** — fancy name for "pass the keyboard-reading part *in* as an argument," which is
  what let me swap in fake answers for testing.
- **idempotent** — "doing it twice changes nothing extra"; here, a rejected/approved habit is never
  re-proposed, no matter how many times detection runs.

**Gate before Stage 4:** my yes/no answers now stick — approvals in the rulebook, rejections on the
never-again list — and the engine respects both. Stage 4 is the step that finally *uses* the rulebook:
when a session starts, Praxis reads `active-rules.md` out loud into the assistant's context, so it
actually follows the habits I approved. That closes the whole loop.
