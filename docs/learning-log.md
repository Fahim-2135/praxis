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

---

## Stage 4 — Feedback injection (closing the loop)

**What we built, in one line.** The part that makes the rulebook *matter*. When a session starts, Praxis
reads my approved rules into the assistant's context — so it actually offers the habits I approved.

**The plain version.** Up to now the rulebook just sat there. Stage 1 watched, Stage 2 made a shortlist,
Stage 3 let me approve — but the assistant never *saw* the approved rules. Stage 4 is the wire that
connects them: a small script that runs the moment a session begins, opens the rulebook, and reads it
aloud into the room where the assistant is listening. Now the assistant knows "after tests, offer to
push — but ask first" and brings it up on its own. Nothing runs behind my back; the rules are just
*spoken into context* so the assistant can act on them.

**The one idea I want to remember: one specific channel is the megaphone.** A hook is just an outside
program, and normally whatever it prints goes nowhere. But there's *one* exception: what the
session-start hook prints gets handed straight to the assistant as part of what it reads. That single
property is the entire feedback mechanism. I don't need fancy automation — I just need to write my rules
to *that one channel*, and the assistant picks them up. The honesty of this is the point: I can read the
exact words that steer it, instead of trusting hidden machinery.

**The choice I want to remember: don't dump the file — re-write it for its reader.** The rulebook is
written for *me* (plain English plus little hidden data tags). I could have just printed that whole file
into context, but the assistant doesn't need my header or the hidden tags — that's noise. So instead I
pull the rules back out and rebuild them as *instructions aimed at the assistant*: "When X happened,
offer Y, and ask first." Same facts, but phrased for whoever's reading. The risk level decides the
wording — safe rules get a light touch, riskier ones demand explicit confirmation, dangerous ones may
only be *suggested* — so the safety promise rides along in the very sentence that steers the model.

**The subtle decision: this hook breaks a rule the other one follows — on purpose.** The Stage 2
detection hook is forbidden from running when the session is just *compacted* (squeezed to save room),
because that would interrupt me mid-work. I deliberately did the *opposite* for feedback: it re-reads
the rulebook on compaction too. Why? Because compacting can squeeze my rules right out of the
assistant's memory — so re-stating them then is exactly what I want. The "don't run on compact" rule was
only ever about the *thinking* step (detection); a cheap read-only reminder has no reason to obey it.
Recognizing that a constraint applies to one path and not another — instead of cargo-culting it
everywhere — is the senior move here.

**The technical words (so the vocabulary lands too).**

- **the feedback path** — the spec's name for the step that feeds approved rules back into the model, via
  `SessionStart` stdout. The fourth of the four paths; the one that closes the loop.
- **context injection** — putting text into what the model reads for a session. Here it's done by printing
  to a hook's stdout that Claude Code forwards into context — *not* by training the model (it never learns).
- **`SessionStart` stdout** — the specific channel that gets injected. Other hooks' stdout is discarded;
  this one isn't, which is why the feedback path uses exactly this event.
- **source-filtering** — checking *why* a session started (`startup` / `resume` / `clear` / `compact`) and
  acting only on some. Detection filters; feedback intentionally does not.
- **single-responsibility** — each script does one job: detection and feedback are two separate
  `SessionStart` hooks rather than one hook with branching behavior, because their filtering needs differ.

**Gate before Stage 5:** the loop is now closed end-to-end — I act, Praxis logs, detects, proposes, I
approve, and the assistant reads my rule next session and offers it back. Stage 5 (self-pruning) is the
last piece: a rule whose behavior I've stopped doing gets flagged for retirement, so the rulebook can't
quietly accumulate stale habits forever.

---

## Stage 5 — Self-pruning (the rulebook can now shrink)

**What we built, in one line.** The part that lets Praxis *forget*. It re-checks my approved rules and
flags any habit I've stopped doing, so I can retire it — the rulebook shrinks, not just grows.

**The plain version.** Until now every stage only *added*: log more, detect more, approve more. But a
rulebook that only grows eventually fills with habits I've abandoned, and the assistant keeps offering
me things I don't do anymore. Stage 5 fixes that. Each time Praxis analyzes my log, it also looks back at
the rules I already approved and asks of each: "has this actually happened lately?" If a rule's habit
hasn't shown up in two weeks, it gets flagged. Next time I run review, after the new suggestions it shows
me the stale ones and asks "retire or keep?" Retire deletes it from the rulebook. So the rulebook stays a
picture of what I do *now*, not a junk drawer of everything I ever did.

**The one idea I want to remember: adding and removing should not use the same bar.** My instinct was to
reuse the same "recent?" window for both — if 5 days proves a habit is current enough to *add*, why not
use 5 days to decide it's gone? Because the two jobs aren't symmetric. *Adding* a rule should be hard: I
want strong, current proof before automating something. *Removing* an approved rule should be forgiving:
it already earned its place, so a quiet week or a vacation shouldn't yank it. So promotion uses a short
window (5 days) and retirement uses a longer one (14 days). Same math, different thresholds, because the
cost of a wrong "add" and a wrong "remove" are different. Picking the threshold from *what the mistake
costs*, not from symmetry, is the lesson.

**The second idea: the machine flags, but only I delete.** Praxis never edits the rulebook on its own —
not even to remove dead rules. It only *flags*; the actual removal happens when I say "retire" in review,
exactly the same way adding happens when I say "approve." This is the same trust rule as everywhere else
in the project: a rule I can read is a rule I can trust, and nothing edits that file behind my back. The
engine only ever *proposes* — in both directions, adding and removing.

**A design subtlety I want to remember: don't break a property you already paid for.** Back in Stage 2 I
made detection *idempotent* — if nothing new happened, running it again does nothing. Staleness is
time-based (a rule goes stale because *time* passed, not because I did something), so I was tempted to
make the staleness check run on *every* session even when there's no new activity — which would have
broken that "do nothing if nothing's new" property. I chose to keep the property: staleness is recomputed
on the next pass that *does* have new activity, which in practice is the very next time I work. A tiny
delay in flagging a dead rule is a fair price for not breaking idempotency. Knowing which guarantee to
protect when two desires collide is the senior move here.

**The technical words (so the vocabulary lands too).**

- **self-pruning** — the system removing its own stale rules so it doesn't accumulate dead weight forever.
- **recency horizon** — the time window a rule's behavior must fall within to count as "still in use."
  Promotion's horizon is `recencyDays` (5); retirement's is `staleDays` (14).
- **re-validation** — re-running a check (here, recency) against data that already passed once, to see if
  it *still* holds. Active rules are re-validated every cold pass.
- **retire** — the review action that deletes an approved rule from `active-rules.md` (vs. *keep*, which
  leaves it). The mirror image of *approve*.
- **idempotency (again)** — the Stage 2 property I protected: a pass with no new events still does nothing.
- **asymmetric thresholds** — using a different cutoff for adding vs. removing, because the two errors
  cost differently.

**Stage 5 done — the loop is complete.** All five stages are built: I act → Praxis logs (hot path) →
detects and re-validates (cold path) → I approve or retire (human path) → the assistant reads the live
rules (feedback path). Praxis observes what I do, infers rules from real cross-session repetition, lets me
admit and prune them, and feeds the current set back into context — without ever training the model, ever
acting on an irreversible step, or ever hiding a rule from me.

---

## Safety gate — the PreToolUse block (the guarantee made real)

**What we built, in one line.** The part that *physically* stops danger. Before any terminal command
runs, a guard checks it; if it's irreversible (force-push, `rm -rf`, wiping a disk, sending data out), it
makes the assistant stop and ask me first.

**Why this even needed building.** The safety promise existed only as *words* until now. The rulebook
said of risky rules "never run this automatically" — but that's just text the assistant reads and is
*asked* to obey. If a rule were buggy, or the assistant slipped, nothing actually *stopped* the command.
This stage turns the promise into a wall: a check that sits below the rules, at the moment a command is
about to run, and refuses to let an irreversible one through without my explicit yes.

**The one idea I want to remember: the safety check can't reuse the habit-labeler.** My first instinct
was "I already have code that names commands (the normalizer) — reuse it." Wrong, and worth understanding
why. The normalizer's whole *job* is to throw away detail: `git push --force-with-lease` and `git push`
both become `git_push`, because for counting habits they're the same intent. But the danger lives in
exactly the part it throws away — the `--force`. A labeler built to ignore differences is the worst tool
for spotting the one difference that matters. So safety got its *own* recognizer that reads the raw
command and looks for the dangerous flags directly. Lesson: two jobs that look similar ("classify this
command") can need opposite designs — one blurs detail, the other hunts for it.

**The second idea: 'block' has three settings, not two.** I assumed the guard could only *allow* or
*deny*. But the pre-run hook has a third option: **ask**. That third option dissolved the whole problem.
A flat "deny all force-pushes" would also block *me* when I genuinely need one. "Ask" means: never runs on
its own, but I can wave it through in the moment. That's exactly the real goal — "never *auto*-executes" —
without making the tool fight me. Reaching for the option I didn't know existed beat building a clumsy
"deny + secret override" workaround.

**The third idea: a safety guard should fail *open*, loudly.** If the guard itself crashes, what should
happen — block everything, or allow everything? Blocking everything would freeze my terminal over a typo
in the guard: the guard becomes the disaster. So it fails *open* (lets the command through) — but writes
the failure down, so a broken guard is *visible*, not silently gone. The reasoning that makes this safe
enough: the guard is tiny pure code, the worst it would've done is show a prompt (not take an action), and
the likely failure is tested. Choosing fail-open here isn't carelessness — it's matching the failure mode
to what the component actually does.

**The technical words (so the vocabulary lands too).**

- **PreToolUse hook** — a hook that runs *before* a tool call and can change whether it proceeds
  (allow / deny / **ask**), unlike PostToolUse which only observes after the fact.
- **permission decision** — the verdict the hook returns (here `ask`), emitted as JSON the harness reads.
- **fail open / fail closed** — on error, default to *allowing* (open) vs *blocking* (closed). I chose
  open + logging for this guard.
- **hard-gated vs hard-blocked** — my deviation from the spec's word "blocked": the action isn't forbidden,
  it's *gated* behind a mandatory human confirmation. Same guarantee (never auto-runs), still usable.
- **defense in depth** — the danger is caught at the hook layer *below* the rules, so even a bad rule can't
  get an irreversible command past it. The guarantee doesn't depend on the rules being correct.

**Why this was last, and outside the five stages.** The five stages are the *learning loop*; this guard is
a *seatbelt* around it. It depends on the tier idea from Stage 2 but nothing depends on it, so it was safe
to build last — and honestly, it had to exist before I'd call the repo trustworthy, because the README was
already promising it.

---

## `praxis status` — making it visible (the should-have jump)

**What we built, in one line.** The window. One command that tells me, in plain terms, everything Praxis
has figured out about how I work — and what it's *almost* ready to automate.

**The plain version.** Everything before this worked, but silently. To see what Praxis knew I'd have had
to run three different developer tools and read raw numbers. `praxis status` is the one friendly screen:
how much it's watched, my top habits, the rules it acts on, the ones waiting for my yes, and — the fun part
— the "almost rules": habits it's *this close* to suggesting, with exactly what's missing ("seen 5× but in
only 2 sessions — 1 more session to qualify").

**The one idea I want to remember: a working pipeline isn't a product until someone can *see* it.** The
hard engineering was already done. But a tool nobody can look into feels like nothing. The single highest-
value thing left wasn't more cleverness underneath — it was a window onto the cleverness already there.
Surfacing the state is what turns "a background process" into "a thing I open and enjoy," and it's what
makes the work *legible* to anyone judging the repo. Visibility is a feature, often the most important one.

**The second idea: show the 'almost', not just the done.** The active rules are the result; the *almost*
rules are the proof it's alive and watching. Seeing "1 more session and I'll suggest this" is the moment
the whole premise lands emotionally — it's watching me, and it's close. I got this for free by reusing the
engine's existing near-miss output, so the profile can never lie about what the detector actually thinks.

**The technical words (so the vocabulary lands too).**

- **synthesis / view layer** — code whose job is to *present* existing state, not compute new state. It
  reuses the engines (`summarize`, `detect`) instead of re-deriving, so it can't drift from them.
- **read-only command** — changes nothing on disk; safe to run anytime. (Why it crosses no safety line.)
- **near-miss surfacing** — exposing patterns that failed a gate but are close, ranked by how close.

**Why this was the right last feature.** It cost little (pure core + a renderer over engines I already
had), crossed no safety line (read-only), and did the most for the goal: it makes the invisible loop
visible — for me day-to-day, and for anyone reading the repo deciding whether the person who built it can
ship a *product*, not just a pipeline.
