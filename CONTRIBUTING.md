# Contributing to Praxis

Thanks for your interest. Praxis is a behavioral pattern-learning agent that layers over Claude
Code; please read [`PRAXIS.md`](PRAXIS.md) (the spec) and [`docs/architecture.md`](docs/architecture.md)
(the system as built) before making changes.

## Development setup

Requires **Node.js ≥ 20**. The runtime has no dependencies; the only dev dependencies are ESLint and Prettier.

```bash
npm install          # dev tooling (ESLint, Prettier)
npm test             # run the full test suite (Node's built-in runner)
npm run lint         # ESLint — correctness checks
npm run format       # Prettier — auto-format code
npm run format:check # verify formatting (also enforced in CI)
npm run demo         # see the Stage 1 pipeline run end-to-end on synthetic data
npm run inspect      # summarize your real .praxis/log.jsonl
npm run bench        # measure the hot path's per-invocation latency
```

CI runs `lint`, `format:check`, and `test` on Node 20, 22, and 24 for every push and pull request.
Keep them green. ESLint owns correctness; Prettier owns formatting — they do not overlap.

Optionally enable the bundled pre-commit hook to run those same checks locally before each commit:

```bash
git config core.hooksPath .githooks
```

Security-sensitive behavior (notably that unrecognized commands log their raw text) is documented in
[`SECURITY.md`](SECURITY.md).

## The one rule you must not break: the hot path

`src/hooks/post-tool-use.mjs` runs on **every** Claude Code tool call. Its latency is paid on every
action, so it is held to a strict contract (see `docs/architecture.md`):

- **No model/LLM call, no network** — normalization is a deterministic rule table.
- **No locking, no read-modify-write of the log** — append one line and exit.
- **Never crash the editor** — catch everything, note failures to `errors.log`, always exit 0.

A change that adds any of those to the hot path will be rejected, however useful it seems. Expensive
work belongs on the cold path (session boundaries), not here.

## Normalization rules

Add or adjust action labels in `src/normalize.mjs`. Two principles:

- **Determinism over cleverness.** The same command must always map to the same `action`, or the
  detection engine's counts fragment.
- **Calibrate from real data, not imagination.** Don't speculatively add rules. Run `npm run inspect`,
  read the `unmatched` pile, and add rules for what actually shows up (PRAXIS.md §5, §12).

Every normalization change needs a unit test in `test/normalize.test.mjs`.

## Commits and scope

- **Atomic, imperative commits** — "Add X", "Fix Y", one coherent change each. The history should
  read as a deliberate progression.
- **Respect the build order.** Praxis is built in the five stages in `PRAXIS.md` §10; each stage's
  real output tunes the next. Don't land later-stage work early.
- Update the relevant docs (`README.md`, `docs/architecture.md`) in the same change when behavior
  changes — docs must not drift from the code.

## Reporting issues

Include your OS and shell, Node version, the command or tool call involved, and anything in
`.praxis/errors.log`. Never paste secrets — `.praxis/` is your own data and is git-ignored for a
reason.
