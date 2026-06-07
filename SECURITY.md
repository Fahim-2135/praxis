# Security

## Reporting a vulnerability

Please open a GitHub issue for non-sensitive reports, or contact the maintainer privately for
anything exploitable. Include your OS, shell, Node version, and reproduction steps.

## How Praxis handles your data

Praxis observes your workflow, so it is worth being precise about what it stores and where.

- **Everything stays local.** All state lives under `.praxis/` in your project and is never
  transmitted anywhere. There is no network call in any path.
- **`.praxis/` is git-ignored** from the first commit, so behavioral data is never committed.
- **Most records store only a normalized label** (`git_push`, `test_run`, …) — not the raw command.

### Sensitive data in the log (known consideration)

There is one deliberate exception to the "labels only" rule: a command Praxis does **not** recognize
is logged as `action: "unmatched"` with its **raw text preserved**, so the unmatched pile can reveal
which normalization rules to add (PRAXIS.md §5).

That means a one-off, unrecognized command containing a secret — for example
`curl -H "Authorization: Bearer <token>" …` — could be written into `.praxis/log.jsonl`.

**Mitigations in place:**

- The log is local-only and git-ignored, so the secret does not leave your machine or enter version
  control.
- Recognized commands (the common case) never store raw text.

**Your responsibility:**

- Do not paste `.praxis/log.jsonl` or `errors.log` into public issues, gists, or chats without
  reviewing them first.

**Future work:** raw-command redaction (stripping obvious secret patterns before logging) is a
candidate enhancement; it is intentionally deferred until there is real logged data to calibrate the
patterns against, per the project's calibrate-from-reality principle.

## Secrets in the repository

No secrets, keys, tokens, or `.env` files are committed. `.gitignore` excludes `.env*` and the
`.praxis/` state directory.
