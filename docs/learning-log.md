# Learning Log

> One tight entry per build stage, in my own voice — the distilled lesson, plain and technical.
> The full transcript of every explanation lives in [`teaching-log.md`](teaching-log.md); this is
> the summary I'd hand someone who asked "so what did that stage actually teach you?"

---

## Stage 1 — The hot path (the logger)

**What we built, in one line.** The part that *watches*. Every time I do something in Claude Code, a
tiny script writes one line in a logbook saying what I did — then gets out of the way.

**The plain version.** Picture a security camera wired to a notebook. Every time a door opens it writes
*one* line: what happened, what happened right before it, when, and which visit it was. It never stops to
think, never phones anyone, never rewrites old pages. Jot one line, done. All the actual thinking ("is
this a habit worth automating?") happens *later*, when nobody is waiting on it.

**The one idea I want to remember: this code runs on *everything*, so it must do *almost nothing*.** This
script fires after every single action I take. If it were even a little slow, every action I do would feel
sluggish — because its delay gets added to all of them. So the rule is brutal: write one line and leave.
No thinking, no internet, no waiting. That "do almost nothing" limit isn't laziness — it's the thing that
keeps the whole tool invisible while I work. (The name for this delay-on-every-action is **latency** — the
lag between doing a thing and it finishing.)

**A neat trick worth remembering: how it knows "what I did right before."** Each time the script runs, it
is a brand-new program with no memory of last time. But I want to record *what came before* each action.
Re-reading the whole logbook to find out would be too slow (breaks the "do almost nothing" rule). So
instead it keeps a one-word sticky note per work-session: it reads the note ("last thing was: edit a
file"), writes the new line, then updates the note. Cheap, no re-reading the big logbook.

**Why it can never crash my editor.** If the logger ever hits an error, it quietly notes it in a side file
and *still reports success*. A tool whose only job is to watch must never break the thing it's watching.

**The technical words (so the vocabulary lands too).**

- **hook** — a script Claude Code runs automatically at a set moment. Ours runs *after every tool call*
  (the official name is a **PostToolUse hook**).
- **the hot path** — the spec's name for "code that runs on every action and therefore must be instant."
  Its opposite, the **cold path** (Stage 2), runs rarely and is allowed to be slow.
- **normalization** — turning a messy raw command (`git push origin main`) into one tidy label
  (`git_push`) so the same intent always counts as the same thing.
- **append-only log / JSONL** — a file you only ever *add* to the bottom of, one line per event. ("JSONL" =
  one self-contained record per line.) Adding a line is cheap; a crash can only hurt the last line.
- **latency** — the delay added to an action. The whole Stage 1 design exists to keep this near zero.

**Gate before Stage 2:** after a day of real use — (a) the logbook is clean and the labels are right, and
(b) Claude Code still feels snappy. If it lags, the logger isn't minimal enough and that gets fixed before
anything else.

---

## Stage 2 — Detection and the five gates (the shortlist maker)

**What we built, in one line.** The part that *thinks*. It reads the logbook and decides which repeated
behaviors are real habits worth proposing — and writes them on a shortlist.

**The plain version.** Go back through the Stage 1 notebook and, for each thing that keeps happening, ask
four questions:

1. Did it happen **enough times**? (not just once or twice)
2. On **different days/sessions**, or all in one frantic afternoon? (one stuck afternoon isn't a habit)
3. **Almost every time** the setup happened, or only occasionally? (otherwise it's just coincidence)
4. **Recently**, or has it gone stale?

Only behaviors that pass all four land on the shortlist. A fifth question just labels **how risky** each
one is (run tests = safe; delete files = dangerous), which later decides how much freedom it's ever
allowed. Important: nothing acts here. It only builds a shortlist.

**The one idea I want to remember: count the "out of how many," not just the hits.** "I pushed 5 times"
sounds like a lot — but it means nothing until you ask *out of how many chances?* If I pushed 5 times after
tests, and tests ran 6 times total, that's a real habit (5 of 6). If tests ran 50 times, then pushing only
5 times is basically random. So the key question 3 above divides the hits by the *total* opportunities.
That division is the line between a real habit and a fluke. (The "out of how many" number is called the
**denominator** — the bottom of the fraction.)

**The bigger lesson: sometimes the correct answer is "propose nothing."** I ran this over my own real
logbook expecting to watch it find habits. It found **zero**. Why? My history was mostly one long session,
and question 2 ("different days?") correctly refused to call that a habit. The tempting move is to loosen a
rule so *something* shows up. That is the trap. A system that invents habits from thin data is worse than
one that honestly stays quiet. The rule: tune the thresholds against *real* behavior once there's enough
of it — never against the data I wish I had.

**Why the "thinking" part is plain math, not an AI.** The plan called this a "detection subagent," which
made it sound like it should ask an AI to judge. I deliberately did **not**. If an AI judged it, the same
logbook could produce *different* habits on different days (AI isn't perfectly repeatable) — which would
scramble the very counts the four questions depend on, and make the result impossible to trust or inspect.
So the thinking here is ordinary arithmetic: same input always gives same output. Catching that temptation
was the plan protecting the project from a smart-sounding wrong turn.

**The technical words (so the vocabulary lands too).**

- **the cold path** — the opposite of Stage 1's hot path: code that runs only when a session starts or
  ends, so it's *allowed* to take its time and think.
- **pattern** — not just an action, but an action *plus what came right before it*: "push **after tests**,"
  not "push." That pairing is what makes a rule meaningful.
- **the five gates** — the four yes/no filters above plus the risk label, applied in order. A "gate" is
  just a check a pattern has to pass to continue.
- **denominator** — the "out of how many" total; counting it is what kills coincidences.
- **candidates** — the shortlist (`candidates.json`): patterns that passed, waiting for my yes/no in
  Stage 3.
- **deterministic** — "same input always gives the same output." Required here so the system stays
  trustworthy and inspectable; an AI judge would not be deterministic.
- **idempotent** — "running it twice does no extra harm." Detection runs at both session-end and the next
  session-start (belt and suspenders), and a small bookmark file makes the second run a harmless no-op if
  there's nothing new.

**Gate before Stage 3:** the engine is correct and honest — it stays quiet on thin data instead of
inventing rules. Stage 3 gives those shortlisted candidates somewhere to go: my yes/no/later decision.

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
